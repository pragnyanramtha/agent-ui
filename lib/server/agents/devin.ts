import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Entry, PermissionMode } from "@/lib/types";
import { liveStream, rekeyTurn, startTurn, stopTurn, turnState, type Run, type SpawnSpec } from "./cli-run";
import { profileBin } from "../profiles";
import {
  devinDataDir,
  devinLocksDir,
  getSession,
  historyItems,
  itemsToEntries,
  listSessions,
  openDb,
  signature,
  type DevinSessionRow,
} from "./devin-store";
import type { AgentAdapter, AgentSession, CliRunState, HistoryPage } from "./types";

/* Devin CLI (Cognition) adapter.
 * History comes from Devin's SQLite store (see devin-store.ts). Web turns run `devin -p` (print mode, plain text
 * output, no session id on stdout); a new session's id is learned from session_locks/<id>.lock, which holds the
 * pid of the ACP agent child that `devin -p` spawns, with the sessions table as a fallback. */

const PAGE = 60;
const POLL_MS = 1000;
const keyOf = (id: string) => `devin:${id}`;

/* ---------- binary ---------- */

let binCache: { path: string | null; at: number } | null = null;

async function findBinary(): Promise<string | null> {
  if (binCache && Date.now() - binCache.at < 30_000) return binCache.path;
  const candidates = [
    process.env.DEVIN_BIN,
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((d) => path.join(d, "devin")),
    path.join(os.homedir(), ".local", "bin", "devin"),
  ].filter((p): p is string => Boolean(p));
  let found: string | null = null;
  for (const p of candidates) {
    try {
      await fs.promises.access(p, fs.constants.X_OK);
      if ((await fs.promises.stat(p)).isFile()) {
        found = path.resolve(p);
        break;
      }
    } catch {
      /* next */
    }
  }
  binCache = { path: found, at: Date.now() };
  return found;
}

/* ---------- sessions ---------- */

const toSession = (r: DevinSessionRow): AgentSession => ({
  id: r.id,
  title: r.title,
  cwd: r.cwd,
  mtime: r.lastActivity * 1000,
  size: 0,
  model: r.model || null,
});

function page(id: string, before: string | null): HistoryPage {
  const db = openDb();
  const row = db ? getSession(db, id) : null;
  if (!db || !row) return { entries: [], cursor: null, end: "" };
  const items = historyItems(db, id, row.head);
  const end = items.at(-1)?.messageId ?? "";
  let stop = items.length;
  if (before) {
    const i = items.findIndex((it) => it.messageId === before.replace(/^m:/, ""));
    if (i === -1) return { entries: [], cursor: null, end };
    stop = i;
  }
  const start = Math.max(0, stop - PAGE);
  const slice = items.slice(start, stop);
  return {
    entries: itemsToEntries(db, id, slice, row.model),
    cursor: start > 0 ? `m:${items[start].messageId}` : null,
    end,
  };
}

function watch(id: string, from: string, onEntries: (entries: Entry[], end: string) => void): () => void {
  let last = from;
  let sig = "";
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    try {
      const db = openDb();
      if (!db) return;
      const next = signature(db, id);
      if (next === sig || next === "missing") return;
      sig = next;
      const row = getSession(db, id);
      const items = historyItems(db, id, row?.head ?? null);
      let idx = -1;
      if (last) {
        idx = items.findIndex((it) => it.messageId === last);
        if (idx === -1) {
          /* the chain was rewritten without our last message (revert/rewind): resync without replaying */
          last = items.at(-1)?.messageId ?? last;
          return;
        }
      }
      const fresh = items.slice(idx + 1);
      if (!fresh.length) return;
      last = fresh.at(-1)!.messageId;
      const entries = itemsToEntries(db, id, fresh, row?.model ?? "");
      if (entries.length) onEntries(entries, last);
    } catch {
      /* transient (db busy/replaced): retry next tick */
    }
  };
  const timer = setInterval(tick, POLL_MS);
  setTimeout(tick, 0);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/* ---------- processes ---------- */

function readProc(pid: number): { ppid: number; cmd: string[] } | null {
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const ppid = Number(/^PPid:\s*(\d+)/m.exec(status)?.[1] ?? 0);
    return { ppid, cmd };
  } catch {
    return null;
  }
}

const isDevin = (cmd: string[]) => cmd.length > 0 && path.basename(cmd[0]) === "devin";
const isPrint = (cmd: string[]) => cmd.some((a) => a === "-p" || a === "--print" || a.startsWith("--print="));

type Lock = { id: string; pid: number; mtime: number };

function readLocks(sinceMs = 0): Lock[] {
  const dir = devinLocksDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: Lock[] = [];
  for (const n of names) {
    if (!n.endsWith(".lock")) continue;
    const file = path.join(dir, n);
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs < sinceMs) continue;
      const pid = Number(fs.readFileSync(file, "utf8").trim());
      if (pid > 0) out.push({ id: n.slice(0, -5), pid, mtime: st.mtimeMs });
    } catch {
      /* raced with deletion */
    }
  }
  return out;
}

/** Interactive `devin` processes: the lock holds the ACP child's pid; its parent is the TUI in the terminal. */
async function liveProcesses(): Promise<Map<string, { pid: number }>> {
  const map = new Map<string, { pid: number }>();
  if (process.platform !== "linux") return map;
  for (const lock of readLocks()) {
    const proc = readProc(lock.pid);
    if (!proc || !isDevin(proc.cmd)) continue;
    const parent = readProc(proc.ppid);
    if (!parent || !isDevin(parent.cmd) || isPrint(parent.cmd)) continue; /* web/scripted turns and IDE ACP hosts aren't terminals */
    map.set(lock.id, { pid: proc.ppid });
  }
  return map;
}

function descendants(root: number): number[] {
  if (process.platform !== "linux") return [];
  const children = new Map<number, number[]>();
  try {
    for (const d of fs.readdirSync("/proc")) {
      const pid = Number(d);
      if (!pid) continue;
      const p = readProc(pid);
      if (p) children.set(p.ppid, [...(children.get(p.ppid) ?? []), pid]);
    }
  } catch {
    return [];
  }
  const out: number[] = [];
  const walk = (pid: number) => (children.get(pid) ?? []).forEach((c) => (out.push(c), walk(c)));
  walk(root);
  return out;
}

/* ---------- turns ---------- */

const pids = (() => {
  const gg = globalThis as typeof globalThis & { __devinTurnPids?: Map<string, number> };
  return (gg.__devinTurnPids ??= new Map());
})();

const LOGIN_HINT = "Devin isn't logged in. Run devin auth login --force-manual-token-flow on the server.";

function friendly(err: string | null): string | null {
  if (!err) return err;
  const clean = err.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim();
  if (/login canceled|not logged in|unauthenticated|unauthori[sz]ed|auth login|credentials/i.test(clean)) return LOGIN_HINT;
  if (/untrusted|workspace trust/i.test(clean)) return `Devin refused the folder: ${clean}`;
  return clean || err;
}

function hasCredentials(): boolean {
  if (fs.existsSync(path.join(devinDataDir(), "credentials.toml"))) return true;
  return Object.keys(process.env).some((k) => /^(DEVIN|WINDSURF|CODEIUM)_.*(API_KEY|TOKEN)$/.test(k));
}

const CLI_MODE: Record<PermissionMode, string> = {
  default: "auto",
  acceptEdits: "accept-edits",
  bypassPermissions: "dangerous",
  plan: "auto",
};

/**
 * Plan is an agent profile, not a permission mode: print mode switches it with prompt prefixes (`/plan`, `/code`,
 * `/bypass` take a prompt; there is no `/accept-edits <prompt>`). `/code` also resets the permission mode to normal,
 * so leaving plan in accept-edits runs that one turn as normal; later turns get --permission-mode again.
 */
function promptFor(text: string, mode: PermissionMode, savedMode: string | null): string {
  if (text.startsWith("/")) return text;
  if (mode === "plan") return savedMode === "plan" ? text : `/plan ${text}`;
  if (savedMode === "plan" || savedMode === "ask") return mode === "bypassPermissions" ? `/bypass ${text}` : `/code ${text}`;
  return text;
}

function argsFor(text: string, mode: PermissionMode, model: string | undefined, resume: string | null): string[] {
  const args = ["--permission-mode", CLI_MODE[mode] ?? "auto", "--respect-workspace-trust", "false"];
  if (model) args.push("--model", model);
  if (resume) args.push("--resume", resume);
  /* one argument is capped at 128 KiB; long prompts go in a private file (Devin reads it at start; removed later) */
  if (Buffer.byteLength(text) > 64 * 1024) args.push("-p", "--prompt-file", promptFile(text));
  else args.push("-p", "--", text);
  return args;
}

/* a folder of its own per prompt (mkdtemp is 0700), so no other user can plant or swap the file */
function promptFile(text: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-u-"));
  const file = path.join(dir, "devin-prompt.md");
  fs.writeFileSync(file, text, { mode: 0o600 });
  setTimeout(() => fs.rm(dir, { recursive: true, force: true }, () => undefined), 30 * 60_000).unref();
  return file;
}

/** startTurn; a prompt file's folder goes when the turn's process does */
function startDevinTurn(key: string, spec: SpawnSpec, onChunk: (chunk: string) => void): Run {
  const i = spec.args.indexOf("--prompt-file");
  const drop = () => i >= 0 && fs.rm(path.dirname(spec.args[i + 1]), { recursive: true, force: true }, () => undefined);
  try {
    const run = startTurn(key, spec, undefined, onChunk);
    run.child.once("close", drop);
    run.child.once("error", drop);
    return run;
  } catch (err) {
    drop();
    throw err;
  }
}

async function start(opts: { cwd: string; text: string; model?: string; mode: PermissionMode }): Promise<{ id: string }> {
  const bin = await profileBin(findBinary);
  if (!bin) throw new Error("Devin isn't installed.");
  if (!hasCredentials()) throw new Error(LOGIN_HINT);
  const db = openDb();
  const known = new Set(db ? listAllIds(db) : []);
  const t0 = Date.now();
  const tempKey = `devin:pending-${t0.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let onChunk: (chunk: string) => void = () => {};
  const run = startDevinTurn(tempKey, { cmd: bin, args: argsFor(promptFor(opts.text, opts.mode, null), opts.mode, opts.model, null), cwd: opts.cwd }, (c) => onChunk(c));
  onChunk = liveText(run);
  const rootPid = run.child.pid ?? -1;

  const discover = (): string | null => {
    for (const lock of readLocks(t0 - 2000)) {
      if (lock.pid === rootPid || readProc(lock.pid)?.ppid === rootPid) return lock.id;
    }
    const d = openDb();
    if (!d) return null;
    const rows = d
      .prepare("SELECT id FROM sessions WHERE working_directory = ? AND created_at >= ? ORDER BY created_at DESC")
      .all(path.resolve(opts.cwd), Math.floor(t0 / 1000) - 2) as { id: string }[];
    return rows.map((r) => String(r.id)).find((id) => !known.has(id)) ?? null;
  };

  return new Promise((resolve, reject) => {
    const deadline = t0 + 85_000;
    const tick = () => {
      let id: string | null = null;
      try {
        id = discover();
      } catch {
        /* db busy: retry */
      }
      if (id) {
        rekeyTurn(tempKey, keyOf(id));
        if (rootPid > 0) pids.set(keyOf(id), rootPid);
        return resolve({ id });
      }
      const st = run.state;
      if (st.status !== "running") {
        return reject(new Error(friendly(st.error) || "Devin exited before it created a session."));
      }
      if (Date.now() > deadline) {
        stopTurn(tempKey);
        return reject(new Error("Devin didn't start a session in time."));
      }
      setTimeout(tick, 300);
    };
    setTimeout(tick, 300);
  });
}

/* Print mode writes the reply to stdout as plain text while it streams. There is no message boundary
 * in it, so a pause (a tool running) starts a new live segment; the client swaps each for the
 * persisted message that contains it. */
const SEGMENT_GAP_MS = 2000;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

function liveText(run: Run) {
  const live = liveStream(run);
  let segment = 0;
  let last = 0;
  return (chunk: string) => {
    const text = chunk.replace(ANSI, "").replace(/\r/g, "");
    if (!text) return;
    const now = Date.now();
    if (last && now - last > SEGMENT_GAP_MS) segment++;
    last = now;
    live.push(segment, "text", text);
  };
}

function listAllIds(db: NonNullable<ReturnType<typeof openDb>>): string[] {
  return (db.prepare("SELECT id FROM sessions").all() as { id: string }[]).map((r) => String(r.id));
}

async function send(id: string, text: string, opts: { model?: string; mode: PermissionMode }): Promise<void> {
  const bin = await profileBin(findBinary);
  if (!bin) throw new Error("Devin isn't installed.");
  const db = openDb();
  const row = db ? getSession(db, id) : null;
  if (!row) throw new Error("Devin session not found.");
  const cwd = row.cwd && fs.existsSync(row.cwd) ? row.cwd : os.homedir();
  let onChunk: (chunk: string) => void = () => {};
  const run = startDevinTurn(keyOf(id), { cmd: bin, args: argsFor(promptFor(text, opts.mode, row.agentMode), opts.mode, opts.model, id), cwd }, (c) => onChunk(c));
  onChunk = liveText(run);
  if (run.child.pid) pids.set(keyOf(id), run.child.pid);
}

function runState(id: string): CliRunState | null {
  const st = turnState(keyOf(id));
  if (!st) return null;
  return st.error ? { ...st, error: friendly(st.error) } : st;
}

async function stop(id: string): Promise<void> {
  const key = keyOf(id);
  const root = pids.get(key);
  const kids = root && turnState(key)?.status === "running" ? descendants(root) : [];
  stopTurn(key);
  if (kids.length) {
    /* the ACP child can outlive its print-mode parent; make sure the whole turn stops */
    setTimeout(() => {
      for (const pid of kids) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* already gone */
        }
      }
    }, 1500);
  }
}

const adapter: AgentAdapter = {
  id: "devin",
  label: "Devin",
  binary: findBinary,
  list: async () => {
    const db = openDb();
    return db ? listSessions(db).map(toSession) : [];
  },
  get: async (id) => {
    const db = openDb();
    const row = db ? getSession(db, id) : null;
    return row ? toSession(row) : null;
  },
  history: async (id, before) => page(id, before ?? null),
  watch,
  liveProcesses,
  start,
  send,
  runState,
  stop,
};

export default adapter;
