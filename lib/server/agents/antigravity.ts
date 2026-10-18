import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Entry, PermissionMode } from "@/lib/types";
import { liveStream, rekeyTurn, startTurn, stopTurn, turnState, type Run } from "./cli-run";
import { activeProfile, profileBin, resolveBin } from "../profiles";
import { agyDbPath, agyTranscriptPaths, readSummaries, readTranscript, summaryEntries, type AgyRow } from "./antigravity-store";
import { pageOf, pollEntries } from "./poll-watch";
import type { AgentAdapter, AgentSession, CliRunState, HistoryPage } from "./types";

/* Antigravity CLI (`agy`) adapter.
 *
 * History: the summaries db and per-conversation transcripts under ~/.gemini/antigravity-cli
 * (see antigravity-store.ts). Web turns run
 *   agy --output-format stream-json [--conversation <id>] [--model M] [--mode accept-edits|plan | --dangerously-skip-permissions] -p <text>
 * whose first event (`init`) names the conversation. Headless default mode soft-denies shell commands,
 * so the UI defaults to Bypass as for the other print-mode agents. Without a sign-in agy prints
 * "Authentication required" on stderr and only gives up a minute later; that is caught and the turn ended. */

const KEY = (id: string) => `antigravity:${id}`;

const g = globalThis as typeof globalThis & {
  __agyCwds?: Map<string, string>;
  __agyErrors?: Map<string, { startedAt: number; message: string; fatal: boolean }>;
};
/* folders of conversations started from the web, until the summaries db lists them */
const startedCwds = (g.__agyCwds ??= new Map());
const turnErrors = (g.__agyErrors ??= new Map());

/* ── binary ────────────────────────────────────────────────── */

let binCache: { at: number; path: string | null } | null = null;
async function binary(): Promise<string | null> {
  if (binCache && Date.now() - binCache.at < 30_000) return binCache.path;
  const found = resolveBin(process.env.AGY_BIN || "agy");
  binCache = { at: Date.now(), path: found };
  return found;
}

/* ── reading ───────────────────────────────────────────────── */

const rowOf = (id: string): AgyRow | null => readSummaries().find((r) => r.id === id) ?? null;

function transcriptMtime(id: string): number {
  for (const f of agyTranscriptPaths(id)) {
    try {
      return fs.statSync(f).mtimeMs;
    } catch {
      /* next */
    }
  }
  return 0;
}

function toSession(r: AgyRow): AgentSession {
  return {
    id: r.id,
    title: r.title || r.preview.split("\n")[0].slice(0, 120) || "Antigravity conversation",
    cwd: r.cwd || startedCwds.get(r.id) || "",
    mtime: Math.max(r.mtime, transcriptMtime(r.id)),
    size: 0,
    model: null,
  };
}

async function list(): Promise<AgentSession[]> {
  return readSummaries().map(toSession).sort((a, b) => b.mtime - a.mtime);
}

async function get(id: string): Promise<AgentSession | null> {
  const r = rowOf(id);
  if (r) return toSession(r);
  if (!turnState(KEY(id)) && !readTranscript(id)) return null;
  return { id, title: "New Antigravity session", cwd: startedCwds.get(id) ?? "", mtime: Date.now(), size: 0, model: null };
}

function entriesOf(id: string): Entry[] {
  const t = readTranscript(id);
  if (t) return t.entries;
  const r = rowOf(id);
  return r ? summaryEntries(r) : [];
}

async function history(id: string, before?: string | null): Promise<HistoryPage> {
  return pageOf(entriesOf(id), before);
}

function statSig(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "-";
  }
}

function watch(id: string, from: string, onEntries: (entries: Entry[], end: string) => void): () => void {
  return pollEntries(() => ({ sig: [...agyTranscriptPaths(id), agyDbPath()].map(statSig).join("|"), entries: () => entriesOf(id) }), from, onEntries);
}

/* ── live terminals ────────────────────────────────────────── */

/** argv of an interactive agy resuming a conversation (print-mode turns are skipped). */
export function agySessionOf(argv: string[]): string | null {
  if (!argv.slice(0, 2).some((a) => path.basename(a) === "agy")) return null;
  if (argv.some((a) => a === "-p" || a === "--print" || a === "--prompt" || a.startsWith("--prompt="))) return null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--conversation" && argv[i + 1]) return argv[i + 1];
    if (a.startsWith("--conversation=")) return a.slice("--conversation=".length) || null;
  }
  return null;
}

async function liveProcesses(): Promise<Map<string, { pid: number }>> {
  const out = new Map<string, { pid: number }>();
  if (process.platform !== "linux") return out;
  let pids: string[];
  try {
    pids = fs.readdirSync("/proc").filter((p) => /^\d+$/.test(p));
  } catch {
    return out;
  }
  for (const pid of pids) {
    let argv: string[];
    try {
      argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    } catch {
      continue;
    }
    const id = agySessionOf(argv);
    if (id && !out.has(id)) out.set(id, { pid: Number(pid) });
  }
  return out;
}

/* ── stream-json ───────────────────────────────────────────── */

export type AgyStreamHandlers = {
  init?(conversationId: string): void;
  /** live text of step `step` (each agent_response step is its own segment) */
  text(step: number | string, text: string): void;
  thinking?(step: number | string, text: string): void;
  result?(r: { ok: boolean; status: string; error: string | null; usage: Record<string, unknown> | null }): void;
};

const errText = (e: unknown): string | null => {
  if (typeof e === "string") return e.trim() || null;
  if (e && typeof e === "object") {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string" && m.trim()) return m.trim();
  }
  return null;
};

/** One handler per turn for agy's `--output-format stream-json` lines (key `event`). */
export function agyStreamParser(h: AgyStreamHandlers): (line: string) => void {
  let known = false;
  return (line: string) => {
    if (!line.startsWith("{")) return;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    const learn = (id: unknown) => {
      if (known || typeof id !== "string" || !id) return;
      known = true;
      h.init?.(id);
    };
    if (ev.event === "init") {
      const init = (ev.init ?? {}) as Record<string, unknown>;
      learn(ev.conversation_id ?? init.conversation_id);
      return;
    }
    if (ev.event === "step_update") {
      const su = (ev.step_update ?? {}) as Record<string, unknown>;
      learn(su.conversation_id ?? ev.conversation_id);
      const step = typeof su.step_index === "number" || typeof su.step_index === "string" ? su.step_index : "x";
      const kind = String(su.step_type ?? "").toLowerCase();
      if (kind === "agent_response" || kind === "planner_response") {
        if (typeof su.thinking_delta === "string" && su.thinking_delta) h.thinking?.(step, su.thinking_delta);
        if (typeof su.text_delta === "string" && su.text_delta) h.text(step, su.text_delta);
      }
      return;
    }
    if (ev.event === "result") {
      const r = (ev.result ?? {}) as Record<string, unknown>;
      learn(r.conversation_id ?? ev.conversation_id);
      const status = String(r.status ?? "").toUpperCase();
      const ok = status === "SUCCESS" || status === "" || /^CANCEL/.test(status);
      h.result?.({ ok, status, error: ok ? null : (errText(r.error) ?? `Antigravity ended the turn (${status.toLowerCase()}).`), usage: r.usage && typeof r.usage === "object" ? (r.usage as Record<string, unknown>) : null });
    }
  };
}

/* ── driving ───────────────────────────────────────────────── */

const LOGIN_HINT = "Antigravity isn't signed in. Run agy on the server once to sign in.";
const NOT_SIGNED_IN = /authentication required|not signed in|please (sign|log) ?in/i;

export function friendlyAgyError(err: string | null): string | null {
  if (!err) return err;
  const clean = err.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim();
  if (NOT_SIGNED_IN.test(clean)) return LOGIN_HINT;
  return clean || err;
}

function modeArgs(mode: PermissionMode): string[] {
  if (mode === "acceptEdits") return ["--mode", "accept-edits"];
  if (mode === "plan") return ["--mode", "plan"];
  if (mode === "bypassPermissions") return ["--dangerously-skip-permissions"];
  return [];
}

/** one argument is capped at 128 KiB: long prompts go in a private file the prompt points at */
function promptText(text: string): string {
  if (Buffer.byteLength(text) <= 64 * 1024) return text.startsWith("-") ? ` ${text}` : text;
  const dir = path.join(os.tmpdir(), "agent-u-prompts");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `agy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.md`);
  fs.writeFileSync(file, text, { mode: 0o600 });
  setTimeout(() => fs.rm(file, { force: true }, () => undefined), 30 * 60_000).unref();
  return `My message is too long to pass directly. Read it from ${file} and treat its contents as my message.`;
}

export function agyArgs(text: string, o: { mode: PermissionMode; model?: string; conversation?: string | null }): string[] {
  return [
    "--output-format",
    "stream-json",
    ...(o.conversation ? ["--conversation", o.conversation] : []),
    ...(o.model ? ["--model", o.model] : []),
    ...modeArgs(o.mode),
    "-p",
    promptText(text),
  ];
}

function drive(run: Run, onInit?: (id: string) => void) {
  const live = liveStream(run);
  const note = (message: string, fatal: boolean) => turnErrors.set(run.key, { startedAt: run.state.startedAt, message, fatal });
  /* cli-run's own listener came first, so run.stderr already holds this chunk (and any split before it) */
  let failed = false;
  run.child.stderr?.on("data", () => {
    if (!failed && run.state.status === "running" && NOT_SIGNED_IN.test(run.stderr)) {
      failed = true;
      note(LOGIN_HINT, true);
      stopTurn(run.key);
    }
  });
  return agyStreamParser({
    init: (id) => onInit?.(id),
    text: (step, t) => live.push(`s${step}`, "text", t),
    thinking: (step, t) => live.push(`s${step}:t`, "thinking", t),
    result: (r) => {
      if (!r.ok) note(r.error ?? "Antigravity reported an error.", true);
    },
  });
}

const lastStderr = (s: string) => s.trim().split("\n").filter(Boolean).slice(-1)[0] ?? "";

async function start(opts: { cwd: string; text: string; model?: string; mode: PermissionMode }): Promise<{ id: string }> {
  const bin = await profileBin(binary);
  if (!bin) throw new Error("Antigravity isn't installed.");
  const t0 = Date.now();
  const tempKey = KEY(`pending-${t0.toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  return new Promise((resolve, reject) => {
    let settled = false;
    let handle: (line: string) => void = () => {};
    let run: Run;
    try {
      run = startTurn(tempKey, { cmd: bin, args: agyArgs(opts.text, { mode: opts.mode, model: opts.model ?? activeProfile()?.defaultModel }), cwd: opts.cwd }, (l) => handle(l));
    } catch (err) {
      reject(err);
      return;
    }
    const done = (err: Error | null, id?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (err) reject(err);
      else resolve({ id: id! });
    };
    handle = drive(run, (id) => {
      startedCwds.set(id, opts.cwd);
      const own = turnErrors.get(tempKey);
      rekeyTurn(tempKey, KEY(id));
      if (own) {
        turnErrors.delete(tempKey);
        turnErrors.set(KEY(id), own);
      }
      done(null, id);
    });
    /* the route gives up at 90s; a start nobody waits for anymore must not go on editing files */
    const deadline = setTimeout(() => {
      if (settled) return;
      stopTurn(run.key);
      done(new Error("Antigravity didn't start a conversation in time."));
    }, 85_000);
    run.child.on("exit", (code) => {
      setTimeout(() => {
        if (settled) return;
        const own = turnErrors.get(run.key);
        done(new Error(friendlyAgyError(own?.message ?? turnState(run.key)?.error ?? lastStderr(run.stderr)) || `Antigravity exited before starting a conversation (code ${code}).`));
      }, 300);
    });
    run.child.on("error", (err) => done(err));
  });
}

async function send(id: string, text: string, opts: { model?: string; mode: PermissionMode }): Promise<void> {
  const bin = await profileBin(binary);
  if (!bin) throw new Error("Antigravity isn't installed.");
  const r = rowOf(id);
  const known = r?.cwd || startedCwds.get(id);
  if (!r && !known && !readTranscript(id)) throw new Error("Antigravity conversation not found.");
  const cwd = known && fs.existsSync(known) ? known : os.homedir();
  let handle: (line: string) => void = () => {};
  const run = startTurn(KEY(id), { cmd: bin, args: agyArgs(text, { mode: opts.mode, model: opts.model ?? activeProfile()?.defaultModel, conversation: id }), cwd }, (l) => handle(l));
  handle = drive(run);
}

function runState(id: string): CliRunState | null {
  const st = turnState(KEY(id));
  if (!st) return null;
  const own = turnErrors.get(KEY(id));
  if (own && own.startedAt === st.startedAt && st.status !== "running" && (own.fatal || st.status === "error")) {
    return { ...st, status: "error", error: friendlyAgyError(own.message) };
  }
  return st.error ? { ...st, error: friendlyAgyError(st.error) } : st;
}

const adapter: AgentAdapter = {
  id: "antigravity",
  label: "Antigravity",
  binary,
  list,
  get,
  history,
  watch,
  liveProcesses,
  start,
  send,
  runState,
  stop: async (id) => stopTurn(KEY(id)),
};

export default adapter;
