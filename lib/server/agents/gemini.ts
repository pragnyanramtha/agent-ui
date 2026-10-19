import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Entry, PermissionMode } from "@/lib/types";
import { failTurn, liveStream, startTurn, stopTurn, turnState, type Run } from "./cli-run";
import { activeProfile, allProfiles, profileBin, resolveBin } from "../profiles";
import { chatFiles, chatSummary, geminiEntries, geminiRoot, readChat, type ChatFile } from "./gemini-store";
import { pageOf, pollEntries } from "./poll-watch";
import type { AgentAdapter, AgentSession, CliRunState, HistoryPage } from "./types";

/* Gemini CLI adapter.
 *
 * History: the CLI's own chat logs (see gemini-store.ts), under every root a Gemini profile points
 * at with GEMINI_CLI_HOME. Web turns run
 *   gemini -p "" --output-format stream-json --skip-trust --approval-mode <m> (--session-id <uuid> | --resume <uuid>) [-m model]
 * with the prompt on stdin (appended to -p). The id is ours, so a new session's key is known before
 * the CLI starts. A resume only searches the current project, so it runs in the chat's project root. */

const KEY = (id: string) => `gemini:${id}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const g = globalThis as typeof globalThis & { __geminiCwds?: Map<string, string> };
/* folders of sessions started from the web, until the CLI has written their chat */
const startedCwds = (g.__geminiCwds ??= new Map());

/* ── binary ────────────────────────────────────────────────── */

let binCache: { at: number; path: string | null } | null = null;
async function binary(): Promise<string | null> {
  if (binCache && Date.now() - binCache.at < 30_000) return binCache.path;
  const found = resolveBin(process.env.GEMINI_BIN || "gemini");
  binCache = { at: Date.now(), path: found };
  return found;
}

/* ── reading ───────────────────────────────────────────────── */

function roots(): string[] {
  const out = new Set<string>([geminiRoot()]);
  for (const p of allProfiles()) if (p.agent === "gemini" && p.env.GEMINI_CLI_HOME) out.add(geminiRoot(p.env.GEMINI_CLI_HOME));
  return [...out];
}

const findChat = (id: string): ChatFile | null => chatFiles(roots()).get(id) ?? null;

function toSession(c: ChatFile): AgentSession {
  const s = chatSummary(c);
  return { id: c.id, title: s.title || "Gemini chat", cwd: c.cwd || startedCwds.get(c.id) || "", mtime: c.mtime, size: c.size, model: s.model };
}

async function list(): Promise<AgentSession[]> {
  return [...chatFiles(roots()).values()].map(toSession).sort((a, b) => b.mtime - a.mtime);
}

async function get(id: string): Promise<AgentSession | null> {
  const c = findChat(id);
  if (c) return toSession(c);
  if (!turnState(KEY(id))) return null;
  return { id, title: "New Gemini session", cwd: startedCwds.get(id) ?? "", mtime: Date.now(), size: 0, model: null };
}

function entriesOf(file: string | null): Entry[] {
  const fold = file ? readChat(file) : null;
  return fold ? geminiEntries(fold) : [];
}

async function history(id: string, before?: string | null): Promise<HistoryPage> {
  return pageOf(entriesOf(findChat(id)?.file ?? null), before);
}

/** Re-folds the chat whenever its file changes (records are replaced in place, so a tail read can't work). */
function watch(id: string, from: string, onEntries: (entries: Entry[], end: string) => void): () => void {
  let file: string | null = null;
  return pollEntries(
    () => {
      if (!file || !fs.existsSync(file)) file = findChat(id)?.file ?? null;
      const st = file ? fs.statSync(file) : null;
      const f = file;
      return { sig: st ? `${st.mtimeMs}:${st.size}` : "none", entries: () => entriesOf(f) };
    },
    from,
    onEntries,
  );
}

/* ── live terminals ────────────────────────────────────────── */

/** argv of an interactive gemini: the session from --resume / --session-id (print-mode turns are skipped). */
export function geminiSessionOf(argv: string[]): string | null {
  const isGemini = argv.slice(0, 3).some((a) => path.basename(a) === "gemini" || /[\\/]gemini-cli[\\/]/.test(a));
  if (!isGemini || argv.some((a) => a === "-p" || a === "--prompt" || a.startsWith("--prompt="))) return null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let v: string | undefined;
    if (a === "--resume" || a === "-r" || a === "--session-id") v = argv[i + 1];
    else if (a.startsWith("--resume=") || a.startsWith("--session-id=")) v = a.slice(a.indexOf("=") + 1);
    if (v && UUID.test(v)) return v;
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
    const id = geminiSessionOf(argv);
    /* the CLI relaunches itself as a child with more heap; the first (outer) process is the terminal's */
    if (id && !out.has(id)) out.set(id, { pid: Number(pid) });
  }
  return out;
}

/* ── stream-json ───────────────────────────────────────────── */

export type GeminiStreamHandlers = {
  /** assistant text for live segment `segment` (a new one starts after each tool call) */
  text(segment: number, text: string): void;
  init?(sessionId: string, model: string | null): void;
  /** an error event (severity error); the turn may still go on */
  error?(message: string): void;
  result?(r: { ok: boolean; error: string | null; stats: Record<string, unknown> | null }): void;
};

/** One handler per turn for `--output-format stream-json` lines. */
export function geminiStreamParser(h: GeminiStreamHandlers): (line: string) => void {
  let segment = 0;
  let hasText = false;
  return (line: string) => {
    if (!line.startsWith("{")) return;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    switch (ev.type) {
      case "init":
        if (typeof ev.session_id === "string") h.init?.(ev.session_id, typeof ev.model === "string" ? ev.model : null);
        return;
      case "message":
        if (ev.role !== "assistant" || typeof ev.content !== "string" || !ev.content) return;
        /* a whole message after its deltas would repeat them */
        if (ev.delta !== true && hasText) return;
        hasText = true;
        h.text(segment, ev.content);
        return;
      case "tool_use":
        if (hasText) segment++;
        hasText = false;
        return;
      case "error":
        if (ev.severity !== "warning" && typeof ev.message === "string") h.error?.(ev.message);
        return;
      case "result": {
        const err = ev.error && typeof ev.error === "object" ? (ev.error as { message?: unknown }).message : ev.error;
        const ok = ev.status !== "error";
        h.result?.({ ok, error: ok ? null : typeof err === "string" && err ? err : "Gemini CLI reported an error.", stats: ev.stats && typeof ev.stats === "object" ? (ev.stats as Record<string, unknown>) : null });
        return;
      }
    }
  };
}

/* ── driving ───────────────────────────────────────────────── */

const LOGIN_HINT = "Gemini CLI has no credentials. Set GEMINI_API_KEY (or Vertex AI / Code Assist) for it on the server; Google account sign-in moved to Antigravity.";

export function friendlyGeminiError(err: string | null): string | null {
  if (!err) return err;
  const clean = err.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim();
  if (/exited with code 41\b|auth method|GEMINI_API_KEY|GOOGLE_GENAI_USE_VERTEXAI|not authenticated|login required/i.test(clean)) return LOGIN_HINT;
  return clean || err;
}

const MODE: Record<PermissionMode, string> = { default: "default", acceptEdits: "auto_edit", bypassPermissions: "yolo", plan: "plan" };

export function geminiArgs(o: { mode: PermissionMode; model?: string; id: string; resume: boolean }): string[] {
  return [
    "-p",
    "",
    "--output-format",
    "stream-json",
    "--skip-trust",
    "--approval-mode",
    MODE[o.mode] ?? "default",
    o.resume ? "--resume" : "--session-id",
    o.id,
    ...(o.model ? ["-m", o.model] : []),
  ];
}

function onLine(run: Run, onInit?: () => void) {
  const live = liveStream(run);
  /* an error event the turn recovers from explains nothing; it's the reason only if the CLI then fails */
  let lastError: string | null = null;
  run.child.on("exit", (code, signal) => {
    if (lastError && !run.failure && code !== 0 && signal !== "SIGTERM" && signal !== "SIGKILL") failTurn(run, lastError);
  });
  return geminiStreamParser({
    text: (seg, t) => live.push(seg, "text", t),
    init: () => onInit?.(),
    error: (m) => {
      lastError = m;
    },
    result: (r) => {
      if (!r.ok) failTurn(run, r.error ?? "Gemini CLI reported an error.");
    },
  });
}

const lastStderr = (s: string) => s.trim().split("\n").filter(Boolean).slice(-1)[0] ?? "";

async function start(opts: { cwd: string; text: string; model?: string; mode: PermissionMode }): Promise<{ id: string }> {
  const bin = await profileBin(binary);
  if (!bin) throw new Error("Gemini CLI isn't installed.");
  const id = randomUUID();
  const key = KEY(id);
  startedCwds.set(id, opts.cwd);
  const model = opts.model ?? activeProfile()?.defaultModel;
  return new Promise((resolve, reject) => {
    let settled = false;
    let handle: (line: string) => void = () => {};
    let run: Run;
    try {
      run = startTurn(key, { cmd: bin, args: geminiArgs({ mode: opts.mode, model, id, resume: false }), cwd: opts.cwd, stdin: opts.text }, (l) => handle(l));
    } catch (err) {
      startedCwds.delete(id);
      reject(err);
      return;
    }
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (err) reject(err);
      else resolve({ id });
    };
    handle = onLine(run, () => done());
    /* the route gives up at 90s; a start nobody waits for anymore must not go on editing files */
    const deadline = setTimeout(() => {
      if (settled) return;
      stopTurn(key);
      done(new Error("Gemini CLI didn't start a session in time."));
    }, 85_000);
    run.child.on("exit", (code) => {
      /* the last stdout lines (the result) can arrive just after exit */
      setTimeout(() => {
        if (settled) return;
        if (code === 0 || findChat(id)) return done();
        done(new Error(friendlyGeminiError(run.failure ?? turnState(key)?.error ?? lastStderr(run.stderr)) || `Gemini CLI exited before starting (code ${code}).`));
      }, 300);
    });
    run.child.on("error", (err) => done(err));
  });
}

async function send(id: string, text: string, opts: { model?: string; mode: PermissionMode }): Promise<void> {
  const bin = await profileBin(binary);
  if (!bin) throw new Error("Gemini CLI isn't installed.");
  const c = findChat(id);
  const cwd = c?.cwd || startedCwds.get(id);
  if (!c && !cwd) throw new Error("Gemini session not found.");
  if (!cwd || !fs.existsSync(cwd)) throw new Error("Can't resume: the session's project folder is gone.");
  let handle: (line: string) => void = () => {};
  const run = startTurn(KEY(id), { cmd: bin, args: geminiArgs({ mode: opts.mode, model: opts.model ?? activeProfile()?.defaultModel, id, resume: true }), cwd, stdin: text }, (l) => handle(l));
  handle = onLine(run);
}

function runState(id: string): CliRunState | null {
  const st = turnState(KEY(id));
  return st?.error ? { ...st, error: friendlyGeminiError(st.error) } : st;
}

const adapter: AgentAdapter = {
  id: "gemini",
  label: "Gemini CLI",
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
