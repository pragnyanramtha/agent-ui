import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import type { AgentId, PermissionMode, ServerEvent } from "@/lib/types";
import { parseMode, str } from "../http";
import { InputRefused, inputTarget, typeIntoTerminal } from "../input";
import { terminalOf, toRunState } from "./bridge";
import { onDelta, onTurn } from "./cli-run";
import { adapterFor, parseSessionKey, sessionKey } from "./index";
import { modeOf, queueStore, saveQueues, setMode, type Queued } from "./queue-store";
import { handoffTitle } from "@/lib/handoff-text";
import { parseEffort } from "@/lib/agent-traits";
import { guardTurn, onSessionEvent, postNotice, postToSession, sameStore } from "../fallback";
import { getSessionMeta, pickProfile, setSessionProfile, withProfile } from "../profiles";

/* Route handlers for non-Claude sessions (ids "<agent>:<nativeId>").
 * Same wire shapes as the Claude routes, so the client doesn't care which agent it is. */

const notFound = () => NextResponse.json({ error: "Session not found." }, { status: 404 });
/** their print modes can't ask for approval on the web, so unattended turns may act (the UI shows Bypass) */
const DEFAULT_MODE: PermissionMode = "bypassPermissions";

/* Messages sent while a web-driven turn runs wait here and go out, in order, when it ends
 * (or is stopped): the CLIs take one prompt per turn. Keyed by session key; the item id is
 * the client's message id, so the client can take one back. Kept on disk (queue-store), so a restart sends them. */
const g = globalThis as { __agentuDrains?: Map<string, () => void>; __agentuResumed?: boolean };
const queues = () => queueStore().queues;
const drains: Map<string, () => void> = (g.__agentuDrains ??= new Map());
/** queued longer than this before a restart: likely stale, so reported instead of sent */
const STALE_MS = 6 * 60 * 60_000;

const queueEvent = (key: string): ServerEvent => ({ type: "queue", items: (queues().get(key) ?? []).map(({ id, text }) => ({ id, text })) });
/** every change to a queue is announced, so this is also where it is saved */
const announce = (key: string) => {
  saveQueues();
  postToSession(key, queueEvent(key));
};

/* Some CLIs (Cursor) only save a prompt after the turn's first step, so a turn stopped before that leaves no
 * trace and the agent never read the message. Turns the user stopped are checked once they end; prompts that
 * didn't land are reported, so the client can offer Retry instead of waiting for them forever. */
type Unsent = { id: string; text: string; error: string };
const unsent: Map<string, Unsent[]> = ((g as { __agentuUnsent?: Map<string, Unsent[]> }).__agentuUnsent ??= new Map());
/** "<key>@<startedAt>" of turns stopped from the web */
const stoppedTurns: Set<string> = ((g as { __agentuStopped?: Set<string> }).__agentuStopped ??= new Set());
const unsentEvent = (key: string): ServerEvent => ({ type: "unsent", items: unsent.get(key) ?? [] });
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

async function stopRunning(a: { runState(n: string): { status: string; startedAt: number } | null; stop(n: string): Promise<void> }, native: string, key: string) {
  const s = a.runState(native);
  if (s?.status !== "running") return;
  stoppedTurns.add(`${key}@${s.startedAt}`);
  /* turns nobody checks (started without a client id) would otherwise stay here */
  if (stoppedTurns.size > 200) stoppedTurns.delete(stoppedTurns.values().next().value!);
  await a.stop(native);
}

/** Once the turn that `text` started ends, reports it if the turn was stopped before the agent saved the prompt. */
async function checkLanding(agent: AgentId, native: string, id: string, text: string) {
  const a = await adapterFor(agent);
  const started = a?.runState(native)?.startedAt;
  if (!a || started === undefined) return;
  const key = sessionKey(agent, native);
  const turn = `${key}@${started}`;
  const ended = async () => {
    if (!stoppedTurns.delete(turn)) return;
    /* the store is written as the process exits; give it a moment */
    await new Promise((r) => setTimeout(r, 2500));
    const page = await a.history(native, null).catch(() => null);
    const want = squash(text);
    if (!page || page.entries.some((e) => e.kind === "user" && squash(e.text).includes(want))) return;
    unsent.set(key, [...(unsent.get(key) ?? []).filter((u) => u.id !== id), { id, text, error: `Not delivered. The turn stopped before ${a.label} saved it.` }].slice(-20));
    postToSession(key, unsentEvent(key));
  };
  /* another turn's state, emitted while this listener was being added, isn't this turn ending */
  const off = onTurn(key, (s) => s.startedAt === started && s.status !== "running" && (off(), void ended()));
  if (a.runState(native)?.startedAt !== started || a.runState(native)?.status !== "running") {
    off();
    void ended();
  }
}

/** sessions with a send in flight (the CLI may not report "running" until its process is up) */
const sending: Set<string> = ((g as { __agentuSending?: Set<string> }).__agentuSending ??= new Set());
const busy = (a: { runState(n: string): { status: string } | null }, native: string, key: string) => sending.has(key) || a.runState(native)?.status === "running";

const watchQueue = (agent: AgentId, native: string, key: string) => {
  if (!drains.has(key)) drains.set(key, onTurn(key, (s) => s.status !== "running" && void drain(agent, native)));
};

function enqueue(agent: AgentId, native: string, item: Queued) {
  const key = sessionKey(agent, native);
  const list = queues().get(key) ?? [];
  if (!list.some((q) => q.id === item.id)) list.push(item);
  queues().set(key, list);
  announce(key);
  watchQueue(agent, native, key);
}

function forget(key: string) {
  if (queues().get(key)?.length) return;
  if (queues().delete(key)) saveQueues();
  drains.get(key)?.();
  drains.delete(key);
}

function reportUnsent(key: string, items: { id: string; text: string }[], error: string) {
  const ids = new Set(items.map((q) => q.id));
  unsent.set(key, [...(unsent.get(key) ?? []).filter((u) => !ids.has(u.id)), ...items.map(({ id, text }) => ({ id, text, error }))].slice(-20));
  postToSession(key, unsentEvent(key));
}

/** At boot: queues saved before a restart go out again, except messages that waited too long, which are reported. */
export async function resumeQueues() {
  if (g.__agentuResumed) return;
  g.__agentuResumed = true;
  for (const [key, list] of [...queues()]) {
    try {
      const k = parseSessionKey(key);
      if (!k || k.agent === "claude") continue;
      const fresh = list.filter((q) => Date.now() - q.at < STALE_MS);
      if (fresh.length < list.length) {
        queues().set(key, fresh);
        announce(key);
        reportUnsent(key, list.filter((q) => !fresh.includes(q)), "Queued message not sent after restart.");
      }
      if (!fresh.length) {
        forget(key);
        continue;
      }
      const a = await adapterFor(k.agent);
      if (!a) continue;
      watchQueue(k.agent, k.native, key);
      if (!busy(a, k.native, key)) void drain(k.agent, k.native);
    } catch (err) {
      console.error(`queue: couldn't resume ${key}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/** Sends the next queued message once nothing runs; one that fails to start is reported and the next one tried. */
async function drain(agent: AgentId, native: string) {
  const key = sessionKey(agent, native);
  if (sending.has(key)) return;
  sending.add(key);
  try {
    const a = await adapterFor(agent);
    if (!a || a.runState(native)?.status === "running") return;
    for (;;) {
      const next = queues().get(key)?.shift();
      announce(key);
      if (!next) break;
      const res = await sendNow(agent, native, next.text, next);
      if (res.ok) break;
      postNotice(key, `Queued message not sent ("${next.text.slice(0, 60)}"): ${res.error}`, "warn");
      reportUnsent(key, [next], `Not sent: ${res.error}`);
    }
  } finally {
    sending.delete(key);
    forget(key);
    void settle(agent, native);
  }
}

/* a turn that ended while a send was in flight left its end-of-turn drain unanswered */
async function settle(agent: AgentId, native: string) {
  const key = sessionKey(agent, native);
  if (!queues().get(key)?.length) return;
  const a = await adapterFor(agent);
  if (a && !busy(a, native, key)) void drain(agent, native);
}

export function unqueue(agent: AgentId, native: string, id: string) {
  const key = sessionKey(agent, native);
  queues().set(key, (queues().get(key) ?? []).filter((q) => q.id !== id));
  forget(key);
  announce(key);
}

/** Puts one queued message first and stops the running turn, so it goes out next. */
async function sendQueuedNow(agent: AgentId, native: string, id: string) {
  const key = sessionKey(agent, native);
  const list = queues().get(key) ?? [];
  const i = list.findIndex((q) => q.id === id);
  if (i > 0) list.unshift(...list.splice(i, 1));
  announce(key);
  const a = await adapterFor(agent);
  if (!a) return;
  if (a.runState(native)?.status === "running") await stopRunning(a, native, key);
  else void drain(agent, native);
}

async function sendNow(agent: AgentId, native: string, text: string, o: { id?: string; model?: string; effort?: string | null; mode: PermissionMode; profile: unknown }): Promise<{ ok: true } | { ok: false; error: string; status: number; code?: string }> {
  const a = await adapterFor(agent);
  if (!a) return { ok: false, error: "Session not found.", status: 404 };
  const key = sessionKey(agent, native);
  const before = pickProfile(agent, null, key);
  const profile = pickProfile(agent, o.profile, key);
  if (!sameStore(before, profile)) return { ok: false, error: `Can't switch this session to ${profile.label}. Use Continue in another agent.`, status: 409, code: "other_store" };
  try {
    const effort = (o.effort === undefined ? profile.defaultEffort : o.effort) ?? undefined;
    await withProfile(profile, () => a.send(native, text, { model: o.model || profile.defaultModel || profile.models?.[0] || undefined, effort, mode: o.mode }));
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), status: 500 };
  }
  setSessionProfile(key, profile.id);
  guardTurn({ key, text, mode: o.mode, model: o.model, profile });
  if (o.id) void checkLanding(agent, native, o.id, text);
  return { ok: true };
}

export async function agentHistory(agent: AgentId, native: string, before: string | null) {
  const a = await adapterFor(agent);
  if (!a) return notFound();
  const key = sessionKey(agent, native);
  if (before !== null) {
    const page = await a.history(native, before);
    return NextResponse.json({ entries: page.entries, cursor: page.cursor });
  }
  const [session, terminal] = await Promise.all([a.get(native), terminalOf(a, native)]);
  if (!session && !a.runState(native)) return notFound();
  const page = await a.history(native, null);
  return NextResponse.json({
    type: "history",
    entries: page.entries,
    cursor: page.cursor,
    end: page.end,
    terminal,
    run: toRunState(key, a.runState(native), modeOf(key) ?? DEFAULT_MODE, session?.model ?? null),
    title: handoffTitle(session?.title ?? "") || `New ${a.label} session`,
    cwd: session?.cwd ?? "",
    permissionMode: modeOf(key) ?? null,
    profile: pickProfile(agent, null, key).id,
    agent,
  });
}

export async function agentEvents(req: NextRequest, agent: AgentId, native: string, from: string | null) {
  const a = await adapterFor(agent);
  if (!a) return new Response("Session not found.", { status: 404 });
  const key = sessionKey(agent, native);
  const encoder = new TextEncoder();
  let closed = false;
  const cleanups: (() => void)[] = [];
  const cleanup = () => {
    if (closed) return;
    closed = true;
    cleanups.splice(0).forEach((fn) => fn());
  };
  const [session, terminal] = await Promise.all([a.get(native), terminalOf(a, native)]);
  const start = from ?? (await a.history(native, null)).end;

  const body = new ReadableStream({
    start(controller) {
      const send = (event: ServerEvent, id?: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${id === undefined ? "" : `id: ${id}\n`}data: ${JSON.stringify(event)}\n\n`));
        } catch {
          cleanup();
        }
      };
      const runOf = () => toRunState(key, a.runState(native), modeOf(key) ?? DEFAULT_MODE, session?.model ?? null);
      send({ type: "history", entries: [], cursor: null, terminal, run: runOf(), title: getSessionMeta(key).title ?? (handoffTitle(session?.title ?? "") || `New ${a.label} session`), cwd: session?.cwd ?? "", permissionMode: modeOf(key) ?? null, profile: pickProfile(agent, null, key).id });
      /* always: a queue lost to a restart must clear what the client still shows */
      send(queueEvent(key));
      if (unsent.get(key)?.length) send(unsentEvent(key));
      cleanups.push(onSessionEvent(key, (e) => send(e)));
      cleanups.push(a.watch(native, start, (entries, end) => entries.length && send({ type: "entries", entries }, end)));
      cleanups.push(onTurn(key, () => send({ type: "run", run: runOf() })));
      /* live text of a web-driven turn; a running turn replays its text so far right after the history event */
      cleanups.push(onDelta(key, (delta) => send({ type: "delta", delta })));
      let last = JSON.stringify(terminal);
      let title = handoffTitle(session?.title ?? "");
      const tick = setInterval(async () => {
        const [t, s] = await Promise.all([terminalOf(a, native).catch(() => null), a.get(native).catch(() => null)]);
        const k = JSON.stringify(t);
        if (k !== last) {
          last = k;
          send({ type: "terminal", terminal: t });
        }
        /* new sessions get their title from the agent a little after the first turn */
        if (s?.title && handoffTitle(s.title) !== title) {
          title = handoffTitle(s.title);
          if (!getSessionMeta(key).title) send({ type: "title", title });
        }
      }, 3000);
      const ping = setInterval(() => send({ type: "ping" }), 15_000);
      cleanups.push(() => {
        clearInterval(tick);
        clearInterval(ping);
      });
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }, { once: true });
      /* the client may have left during the setup above; then cancel() never runs and the listener never fires */
      if (req.signal.aborted) {
        cleanup();
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
}

/** Same routing rule as Claude: an open terminal gets the keystrokes, otherwise the CLI resumes non-interactively. */
export async function agentMessage(agent: AgentId, native: string, body: Record<string, unknown>) {
  const a = await adapterFor(agent);
  if (!a) return notFound();
  const text = str(body.text)?.trim();
  if (!text) return NextResponse.json({ error: "Enter a message." }, { status: 400 });
  const key = sessionKey(agent, native);
  const mode = parseMode(body.permissionMode) ?? modeOf(key) ?? DEFAULT_MODE;
  setMode(key, mode);

  const terminal = await terminalOf(a, native);
  if (terminal) {
    const target = await inputTarget(terminal.pid);
    if (!target) return NextResponse.json({ error: "Can't send here. Reply in its terminal.", code: "no_pane" }, { status: 409 });
    try {
      /* the prompt check reads Claude's input box; other TUIs look different, so type directly */
      const { queued } = await typeIntoTerminal(target, text, { checkPrompt: false });
      return NextResponse.json({ id: key, via: "terminal", queued });
    } catch (err) {
      if (err instanceof InputRefused) return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
      return NextResponse.json({ error: `Couldn't send to the terminal: ${err instanceof Error ? err.message.slice(0, 160) : err}` }, { status: 500 });
    }
  }
  const model = str(body.model) || undefined;
  const effort = parseEffort(agent, body.effort);
  if (busy(a, native, key) || queues().get(key)?.length) {
    const before = pickProfile(agent, null, key);
    const next = pickProfile(agent, body.profile, key);
    if (!sameStore(before, next)) {
      return NextResponse.json({ error: `Can't switch this session to ${next.label}. Use Continue in another agent.`, code: "other_store" }, { status: 409 });
    }
    enqueue(agent, native, { id: str(body.clientId) || `q${Date.now().toString(36)}`, text, model, effort, mode, profile: body.profile, at: Date.now() });
    /* the turn may have ended while this was queued */
    void settle(agent, native);
    return NextResponse.json({ id: key, via: "queued" });
  }
  sending.add(key);
  const res = await sendNow(agent, native, text, { id: str(body.clientId), model, effort, mode, profile: body.profile }).finally(() => sending.delete(key));
  void settle(agent, native);
  if (!res.ok) return NextResponse.json({ error: res.error, code: res.code }, { status: res.status });
  return NextResponse.json({ id: key, via: "web" });
}

export async function agentStart(agent: AgentId, body: Record<string, unknown>) {
  const a = await adapterFor(agent);
  if (!a) return NextResponse.json({ error: "Unknown agent." }, { status: 400 });
  const chosen = pickProfile(agent, body.profile, null);
  if (!(chosen.bin ? chosen.binPath : await a.binary())) return NextResponse.json({ error: `${chosen.label} isn't installed.` }, { status: 400 });
  const text = str(body.text)?.trim();
  const cwd = str(body.cwd)?.trim();
  if (!text) return NextResponse.json({ error: "Enter a message." }, { status: 400 });
  if (!cwd || !path.isAbsolute(cwd) || !(await fs.stat(cwd).then((s) => s.isDirectory()).catch(() => false))) {
    return NextResponse.json({ error: cwd ? `Folder not found: ${cwd}` : "Choose a folder." }, { status: 400 });
  }
  const mode = parseMode(body.permissionMode) ?? DEFAULT_MODE;
  const profile = chosen;
  const model = str(body.model) || profile.defaultModel || profile.models?.[0] || undefined;
  const asked = parseEffort(agent, body.effort);
  const effort = (asked === undefined ? profile.defaultEffort : asked) ?? undefined;
  try {
    const { id } = await Promise.race([
      withProfile(profile, () => a.start({ cwd, text, model, effort, mode })),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${a.label} didn't start in time.`)), 90_000)),
    ]);
    const key = sessionKey(agent, id);
    setMode(key, mode);
    setSessionProfile(key, profile.id);
    guardTurn({ key, text, mode, model, profile });
    return NextResponse.json({ id: key });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function agentControl(agent: AgentId, native: string, body: Record<string, unknown>) {
  const a = await adapterFor(agent);
  if (!a) return notFound();
  const key = sessionKey(agent, native);
  if (body.action === "interrupt" || body.action === "stop") await stopRunning(a, native, key);
  else if (body.action === "unqueue") unqueue(agent, native, str(body.value) ?? "");
  else if (body.action === "sendQueued") await sendQueuedNow(agent, native, str(body.value) ?? "");
  else if (body.action === "mode") {
    const mode = parseMode(body.value);
    if (!mode) return NextResponse.json({ error: "Unknown approval mode." }, { status: 400 });
    setMode(key, mode);
    /* queued messages go out under the mode chosen now, not the one they were queued with */
    const waiting = queues().get(key);
    if (waiting?.length) {
      for (const q of waiting) q.mode = mode;
      saveQueues();
    }
  } else if (body.action !== "model" && body.action !== "effort") return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  return NextResponse.json({ ok: true });
}
