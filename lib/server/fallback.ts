import { randomUUID } from "node:crypto";
import type { Entry, PermissionMode, ServerEvent } from "@/lib/types";
import { adapterFor, parseSessionKey, sessionKey } from "./agents";
import { onTurn } from "./agents/cli-run";
import { handoff, loadSource } from "./handoff";
import { sessionContext } from "./http";
import { getProfile, LIMIT_ERROR, setSessionProfile, withProfile, type ResolvedProfile } from "./profiles";
import { getRun, startRun, type RunEvent } from "./runner";

/* ── events for a session that don't come from its transcript or run ── */

type Bus = Map<string, Set<(e: ServerEvent) => void>>;
const bus = (): Bus => {
  const g = globalThis as typeof globalThis & { __agentuSessionBus?: Bus };
  return (g.__agentuSessionBus ??= new Map());
};

const norm = (key: string) => {
  const k = parseSessionKey(key);
  return k ? sessionKey(k.agent, k.native) : key;
};

export function onSessionEvent(key: string, fn: (e: ServerEvent) => void) {
  const k = norm(key);
  const set = bus().get(k) ?? new Set();
  set.add(fn);
  bus().set(k, set);
  return () => {
    set.delete(fn);
    if (!set.size) bus().delete(k);
  };
}

export function postToSession(key: string, e: ServerEvent) {
  bus().get(norm(key))?.forEach((fn) => fn(e));
}

export function postNotice(key: string, text: string, tone: "info" | "warn" = "info") {
  const k = parseSessionKey(key);
  const run = k?.agent === "claude" ? getRun(k.native) : null;
  if (run) return run.notice(text, tone);
  const entry: Entry = { kind: "notice", id: randomUUID(), ts: new Date().toISOString(), tone, text };
  postToSession(key, { type: "entries", entries: [entry] });
}

/* ── continuing a turn elsewhere when it hits a usage limit ── */

/** env vars that pick where an agent keeps its sessions: profiles that differ here can't resume each other's */
const STORE_VARS = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "KIMI_CODE_HOME", "GEMINI_CLI_HOME", "CURSOR_CONFIG_DIR", "XDG_DATA_HOME", "HOME"];
export const sameStore = (a: ResolvedProfile, b: ResolvedProfile) => a.agent === b.agent && STORE_VARS.every((k) => (a.env[k] ?? "") === (b.env[k] ?? ""));

const usable = (p: ResolvedProfile) => Boolean(p.binPath) || (p.agent === "claude" && !p.bin);

function nextProfile(p: ResolvedProfile, tried: string[]) {
  for (const id of p.fallback ?? []) {
    const next = getProfile(id);
    if (next && !tried.includes(next.id) && usable(next)) return next;
  }
  return null;
}

export type GuardedTurn = { key: string; text: string; mode: PermissionMode; model?: string; profile: ResolvedProfile; tried?: string[] };

const short = (s: string) => (s.length > 140 ? `${s.slice(0, 140)}…` : s);

/* one watcher per session: a message sent while a turn runs replaces the earlier watcher, so a limit fails over once
 * (earlier messages are in the transcript the fallback continues from) */
const guards: Map<string, () => void> = ((globalThis as { __agentuGuards?: Map<string, () => void> }).__agentuGuards ??= new Map());

/** Watches the turn just sent; if it fails on a limit and the profile has fallbacks, it carries on under the next one. */
export function guardTurn(t: GuardedTurn) {
  guards.get(t.key)?.();
  guards.delete(t.key);
  if (!t.profile.fallback?.length) return;
  const k = parseSessionKey(t.key);
  if (!k) return;
  const started = Date.now();
  const watch = (off: () => void) => {
    const stop = () => {
      off();
      if (guards.get(t.key) === stop) guards.delete(t.key);
    };
    guards.set(t.key, stop);
    return stop;
  };
  if (k.agent === "claude") {
    const run = getRun(k.native);
    if (!run) return;
    const stop = watch(
      run.observe((e: RunEvent) => {
        if (e.type !== "run" || e.run.status === "running" || e.run.status === "starting") return;
        stop();
        if (e.run.error && LIMIT_ERROR.test(e.run.error)) void failover(t, e.run.error);
      }),
    );
    return;
  }
  const key = sessionKey(k.agent, k.native);
  const stop = watch(
    onTurn(key, (s) => {
      if (s.status === "running") return;
      stop();
    void (async () => {
      const a = await adapterFor(k.agent);
      /* the adapter's error is the agent's own report; s.error can be just the last line of stderr (a stack frame) */
      let error = [a?.runState(k.native)?.error, s.error].find((e) => e && LIMIT_ERROR.test(e)) ?? null;
      if (!error) {
        /* some CLIs exit cleanly and leave the limit message in the transcript */
        const page = await a?.history(k.native, null).catch(() => null);
        const hit = page?.entries.filter((e) => e.kind === "notice" && e.tone === "warn" && Date.parse(e.ts) >= started - 5000 && LIMIT_ERROR.test(e.text)).pop();
        if (hit?.kind === "notice") error = hit.text;
      }
      if (error) await failover(t, error);
    })().catch((err) => postNotice(t.key, `Fallback failed: ${err instanceof Error ? err.message : err}`, "warn"));
    }),
  );
}

async function failover(t: GuardedTurn, error: string) {
  const tried = [...(t.tried ?? []), t.profile.id];
  const next = nextProfile(t.profile, tried);
  if (!next) return postNotice(t.key, `${t.profile.label} hit a usage limit (${short(error)}). No fallback left.`, "warn");
  postNotice(t.key, `${t.profile.label} hit a usage limit (${short(error)}). Switching to ${next.label}…`, "warn");
  const k = parseSessionKey(t.key)!;
  const go = { ...t, profile: next, tried, model: undefined };

  if (sameStore(t.profile, next)) {
    if (k.agent === "claude") {
      const ctx = await sessionContext(k.native);
      if (!ctx) return;
      getRun(k.native)?.close();
      const run = startRun({ resume: k.native, cwd: ctx.cwd, permissionMode: t.mode, profile: next });
      run.send(t.text);
    } else {
      const a = await adapterFor(k.agent);
      await withProfile(next, () => a!.send(k.native, t.text, { mode: t.mode }));
    }
    setSessionProfile(sessionKey(k.agent, k.native), next.id);
    guardTurn(go);
    return;
  }

  const src = await loadSource(t.key);
  if (!src) return;
  /* the unanswered message is sent again as the next one, not left in the history */
  const last = src.entries.findLastIndex((e) => e.kind === "user" && e.text.trim() === t.text.trim());
  if (last >= 0) src.entries = src.entries.slice(0, last);
  const key = await handoff(src, { text: t.text, mode: t.mode, profile: next });
  postNotice(t.key, `Switched to ${next.label} in a new session.`);
  postToSession(t.key, { type: "redirect", sessionId: key });
  guardTurn({ ...go, key });
}
