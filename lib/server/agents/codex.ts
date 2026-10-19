import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Entry, PermissionMode } from "@/lib/types";
import { rekeyTurn, startTurn, stopTurn, turnState } from "./cli-run";
import { profileBin } from "../profiles";
import { responsesItems, type Source } from "../handoff-shape";
import { appServerTurn } from "./codex-app";
import { allRollouts, fileMeta, findRollout, idOfRollout, readRecords, rolloutRoots, tailRollout, threadNames, type FileMeta } from "./codex-files";
import { errorText, parseLines, safeParse } from "./codex-parse";
import type { AgentAdapter, AgentSession, HistoryPage } from "./types";

/* Codex CLI (codex-cli 0.15x). History comes from the rollout JSONL files,
 * web turns run `codex app-server` (thread/start or thread/resume, then turn/start;
 * see codex-app.ts) so the reply streams live, and terminal sessions are found by the rollout file
 * the interactive `codex` process holds open. */

const LIST_CAP = 200;
const PAGE_BYTES = 2_500_000;
const MAX_PAGE_BYTES = 4 * PAGE_BYTES;
const MIN_ENTRIES = 60;
const START_TIMEOUT_MS = 90_000;

const key = (id: string) => `codex:${id}`;

async function executable(p: string) {
  try {
    await fs.access(p, fs.constants.X_OK);
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

let binCache: { at: number; path: string | null } | null = null;

async function binary(): Promise<string | null> {
  if (binCache && Date.now() - binCache.at < 60_000) return binCache.path;
  const dirs = [...(process.env.PATH ?? "").split(path.delimiter), path.join(os.homedir(), ".local", "bin"), "/usr/local/bin", "/opt/homebrew/bin"].filter(Boolean);
  let found: string | null = null;
  const override = process.env.CODEX_BIN;
  if (override && (await executable(override))) found = override;
  for (const dir of dirs) {
    if (found) break;
    const p = path.join(dir, "codex");
    if (await executable(p)) found = p;
  }
  binCache = { at: Date.now(), path: found };
  return found;
}

const oneLine = (s: string, max = 120) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

function toSession(m: FileMeta, names: Map<string, string>): AgentSession {
  const title = names.get(m.id) ?? (m.firstPrompt ? oneLine(m.firstPrompt) : "");
  return { id: m.id, title, cwd: m.cwd, mtime: m.mtime, size: m.size, model: m.model };
}

async function list(): Promise<AgentSession[]> {
  const files = await allRollouts();
  const stats = await Promise.all(files.map(async (f) => ({ f, st: await fs.stat(f).catch(() => null) })));
  const recent = stats.filter((s) => s.st).sort((a, b) => b.st!.mtimeMs - a.st!.mtimeMs);
  const [names, metas] = await Promise.all([threadNames(), Promise.all(recent.slice(0, LIST_CAP + 50).map((s) => fileMeta(s.f).catch(() => null)))]);
  return metas
    .filter((m): m is FileMeta => Boolean(m && !m.subagent))
    .slice(0, LIST_CAP)
    .map((m) => toSession(m, names))
    .sort((a, b) => b.mtime - a.mtime);
}

async function get(id: string): Promise<AgentSession | null> {
  const file = await findRollout(id);
  const meta = file ? await fileMeta(file).catch(() => null) : null;
  return meta ? toSession(meta, await threadNames()) : null;
}

async function history(id: string, before?: string | null): Promise<HistoryPage> {
  const file = await findRollout(id);
  const stat = file ? await fs.stat(file).catch(() => null) : null;
  if (!file || !stat) return { entries: [], cursor: null, end: "0" };
  const model = (await fileMeta(file).catch(() => null))?.model ?? "";
  const limit = Math.min(before ? Number(before) || stat.size : stat.size, stat.size);
  let window = PAGE_BYTES;
  for (;;) {
    const start = Math.max(0, limit - window);
    const { lines, begin, end } = await readRecords(file, start, limit);
    /* the model is set by turn_context lines; a page that starts mid-turn falls back to the session's latest */
    const entries = parseLines(lines, { model });
    if (entries.length >= MIN_ENTRIES || start === 0 || window >= MAX_PAGE_BYTES) {
      const top = lines.length ? begin : start;
      /* `end` is only meaningful on the newest page; older pages report it anyway */
      return { entries, cursor: top === 0 ? null : String(top), end: String(before ? stat.size : end) };
    }
    window *= 2;
  }
}

function watchSession(id: string, from: string, onEntries: (entries: Entry[], end: string) => void) {
  const offset = Number(from) || 0;
  const ctx = { model: "" };
  let stopped = false;
  void findRollout(id).then(async (f) => {
    if (f && !ctx.model && !stopped) ctx.model = (await fileMeta(f).catch(() => null))?.model ?? "";
  });
  const unsub = tailRollout(() => findRollout(id), offset, ctx, (entries, end) => onEntries(entries, String(end)));
  return () => {
    stopped = true;
    unsub();
  };
}

/* ---------- live terminals ---------- */

const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const NOT_TERMINAL = new Set(["app-server", "exec", "e", "mcp", "mcp-server", "login", "logout", "apply", "completion", "sandbox", "debug", "cloud", "proto"]);

async function liveProcesses(): Promise<Map<string, { pid: number }>> {
  const out = new Map<string, { pid: number }>();
  const pids = (await fs.readdir("/proc").catch(() => [] as string[])).filter((d) => /^\d+$/.test(d));
  await Promise.all(
    pids.map(async (pid) => {
      const argv = (await fs.readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).split("\0").filter(Boolean);
      if (!argv.length) return;
      /* the native binary, or the npm wrapper (`node .../codex.js`) */
      const exe = path.basename(argv[0]);
      const isCodex = exe === "codex" || (/^node(js)?$/.test(exe) && argv.slice(1, 3).some((a) => /(^|\/)codex(\.js)?$/.test(a)));
      if (!isCodex) return;
      const args = argv.slice(exe === "codex" ? 1 : 2);
      /* app-server daemons and non-interactive runs (including our own web turns) aren't terminals */
      if (args.slice(0, 8).some((a) => NOT_TERMINAL.has(a))) return;
      let session: string | null = null;
      const fds = await fs.readdir(`/proc/${pid}/fd`).catch(() => [] as string[]);
      for (const fd of fds) {
        const target = await fs.readlink(`/proc/${pid}/fd/${fd}`).catch(() => "");
        if (!target) continue;
        session = idOfRollout(target) ?? (/thread-writer-locks\//.test(target) ? UUID.exec(path.basename(target))?.[1] ?? null : null);
        if (session) break;
      }
      if (!session) {
        const i = args.indexOf("resume");
        const m = i !== -1 ? UUID.exec(args[i + 1] ?? "") : null;
        session = m ? m[1] : null;
      }
      if (session) out.set(session.toLowerCase(), { pid: Number(pid) });
    }),
  );
  return out;
}

/* ---------- web-driven turns ---------- */

function modeArgs(mode: PermissionMode, resume: boolean): string[] {
  if (mode === "bypassPermissions") return ["--dangerously-bypass-approvals-and-sandbox"];
  /* exec can't show approval prompts, so never ask; the sandbox is the only guard */
  const sandbox = mode === "plan" ? "read-only" : "workspace-write";
  return [...(resume ? ["-c", `sandbox_mode="${sandbox}"`] : ["--sandbox", sandbox]), "-c", 'approval_policy="never"'];
}

type Run = ReturnType<typeof startTurn>;

/** Errors arrive as JSON events (`error`, `turn.failed`); they beat the generic stderr line cli-run would show. */
function trackErrors(run: Run) {
  let failure: string | null = null;
  const onLine = (line: string) => {
    if (!line.startsWith("{")) return;
    const ev = safeParse(line) as { type?: string; message?: string; error?: { message?: string } } | null;
    if (ev?.type === "turn.failed" && ev.error?.message) failure = errorText(ev.error.message);
    else if (ev?.type === "error" && ev.message) failure = errorText(ev.message);
  };
  run.child.on("exit", () => {
    if (!failure) return;
    /* cli-run's own exit handler already ran (registered first); replace its message */
    run.state = { ...run.state, status: "error", error: failure };
    run.listeners.forEach((fn) => fn(run.state));
  });
  return onLine;
}

async function requireBinary() {
  const bin = await profileBin(binary);
  if (!bin) throw new Error("Codex isn't installed.");
  return bin;
}

/* Web turns run over `codex app-server` (codex-app.ts), which streams the reply as it's written;
 * CODEX_WEB_DRIVER=exec falls back to `codex exec --json`, which only reports finished items. */
const useExec = () => process.env.CODEX_WEB_DRIVER === "exec";

async function start(opts: { cwd: string; text: string; model?: string; mode: PermissionMode }): Promise<{ id: string }> {
  const bin = await requireBinary();
  const st = await fs.stat(opts.cwd).catch(() => null);
  if (!st?.isDirectory()) throw new Error(`Folder not found: ${opts.cwd}`);
  if (!useExec()) return startApp(bin, opts);
  const args = ["exec", "--json", "--skip-git-repo-check", "--cd", opts.cwd, ...(opts.model ? ["--model", opts.model] : []), ...modeArgs(opts.mode, false), "-"];
  const pending = key(`pending-${randomUUID()}`);
  return new Promise((resolve, reject) => {
    let id: string | null = null;
    let lineHandler: (line: string) => void = () => {};
    let run: Run;
    try {
      run = startTurn(pending, { cmd: bin, args, cwd: opts.cwd, stdin: opts.text }, (line) => {
        lineHandler(line);
        if (id || !line.startsWith("{")) return;
        const ev = safeParse(line) as { type?: string; thread_id?: string } | null;
        if (ev?.type === "thread.started" && ev.thread_id) {
          id = ev.thread_id;
          rekeyTurn(pending, key(id));
          clearTimeout(timer);
          resolve({ id });
        }
      });
    } catch (err) {
      reject(err);
      return;
    }
    lineHandler = trackErrors(run);
    const timer = setTimeout(() => {
      if (id) return;
      stopTurn(pending);
      reject(new Error("Codex didn't start a session in time."));
    }, START_TIMEOUT_MS);
    run.child.on("exit", () => {
      clearTimeout(timer);
      /* let cli-run and trackErrors settle the state first */
      setImmediate(() => {
        if (!id) reject(new Error(run.state.error || "Codex exited before starting a session."));
      });
    });
    run.child.on("error", (err) => {
      clearTimeout(timer);
      if (!id) reject(err);
    });
  });
}

/** New session over the app server; resolves once the thread exists (before the model answers). */
function startApp(bin: string, opts: { cwd: string; text: string; model?: string; mode: PermissionMode }, inject?: unknown[]): Promise<{ id: string }> {
  const pending = key(`pending-${randomUUID()}`);
  return new Promise((resolve, reject) => {
    let id: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let run: Run;
    try {
      run = appServerTurn({
        key: pending,
        bin,
        cwd: opts.cwd,
        text: opts.text,
        model: opts.model,
        mode: opts.mode,
        inject,
        onThread: (thread) => {
          if (id) return;
          id = thread;
          rekeyTurn(pending, key(thread));
          clearTimeout(timer);
          resolve({ id: thread });
        },
      });
    } catch (err) {
      reject(err);
      return;
    }
    timer = setTimeout(() => {
      if (id) return;
      stopTurn(pending);
      reject(new Error("Codex didn't start a session in time."));
    }, START_TIMEOUT_MS);
    run.child.on("exit", () => {
      clearTimeout(timer);
      /* let cli-run and the driver settle the state first */
      setImmediate(() => {
        if (!id) reject(new Error(run.state.error || "Codex exited before starting a session."));
      });
    });
    run.child.on("error", (err) => {
      clearTimeout(timer);
      if (!id) reject(err);
    });
  });
}

async function send(id: string, text: string, opts: { model?: string; mode: PermissionMode }): Promise<void> {
  const bin = await requireBinary();
  const file = await findRollout(id);
  if (!file) throw new Error("Codex session not found.");
  const meta = await fileMeta(file).catch(() => null);
  const cwdOk = meta?.cwd ? (await fs.stat(meta.cwd).catch(() => null))?.isDirectory() : false;
  const cwd = cwdOk ? meta!.cwd : os.homedir();
  if (!useExec()) {
    appServerTurn({ key: key(id), bin, cwd, text, model: opts.model, mode: opts.mode, threadId: id });
    return;
  }
  const args = ["exec", "resume", "--json", "--skip-git-repo-check", ...(opts.model ? ["--model", opts.model] : []), ...modeArgs(opts.mode, true), id, "-"];
  let lineHandler: (line: string) => void = () => {};
  const run = startTurn(key(id), { cmd: bin, args, cwd, stdin: text }, (line) => lineHandler(line));
  lineHandler = trackErrors(run);
}

/** A new thread with another agent's conversation injected as its history, then the first turn. */
async function importStart(opts: { cwd: string; text: string; model?: string; mode: PermissionMode }, src: Source): Promise<{ id: string }> {
  const bin = await requireBinary();
  return startApp(bin, opts, responsesItems(src));
}

const adapter: AgentAdapter = {
  id: "codex",
  label: "Codex",
  binary,
  list,
  get,
  history,
  watch: watchSession,
  liveProcesses,
  start,
  importStart,
  send,
  runState: (id) => turnState(key(id)),
  stop: async (id) => stopTurn(key(id)),
  transcriptFiles: async (id) => ({ files: (await allRollouts()).filter((f) => idOfRollout(f) === id), roots: rolloutRoots() }),
};

export default adapter;
