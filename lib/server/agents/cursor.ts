import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Entry, PermissionMode } from "@/lib/types";
import { liveStream, rekeyTurn, startTurn, stopTurn, turnState } from "./cli-run";
import { profileBin } from "../profiles";
import { storeEntries } from "./cursor-entries";
import { chatDirs, chatStat, findChatDir, readMetaJson, readStore, type StoreChat } from "./cursor-store";
import { isPartialAssistant, liveParser, streamEntries } from "./cursor-stream";
import type { AgentAdapter, AgentSession, HistoryPage } from "./types";

/* Cursor CLI (`cursor-agent`, also installed as `agent`).
 *
 * History: the CLI's own store, ~/.cursor/chats/<md5(cwd)>/<chatId>/store.db (see cursor-store.ts),
 * read-only via node:sqlite. It holds every chat (terminal or headless) with tool results and
 * timestamps, so it is the source of truth. Web-driven turns also capture their stream-json into
 * ~/.local/share/agent-u/cursor/<chatId>.jsonl, used only when the store can't be read.
 *
 * Driving: `cursor-agent -p --output-format stream-json --stream-partial-output --trust [--model M] [--force | --mode plan]
 * [--resume <chatId>] -- <text>`, run in the chat's folder (the store is keyed by md5 of the cwd,
 * so a resume from another folder wouldn't find the chat). Print mode never prompts: without
 * --force, commands outside the user's allowlist are declined and the agent carries on. */

const KEY = (id: string) => `cursor:${id}`;
const HOLD_MS = 4000;
const PAGE = 400;
const POLL_MS = 1000;

const captureDir = () => path.join(process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share"), "agent-u", "cursor");
const captureFile = (id: string) => path.join(captureDir(), `${id}.jsonl`);

/* folders of chats started from the web, until their store records one */
const startedCwds = (() => {
  const g = globalThis as typeof globalThis & { __cursorCwds?: Map<string, string> };
  return (g.__cursorCwds ??= new Map());
})();

/* ── binary ────────────────────────────────────────────────── */

let binCache: { at: number; path: string | null } | null = null;

function isExec(p: string) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** `agent` is a generic name: only accept it when it resolves into a cursor-agent install. */
const isCursorAgent = (p: string) => {
  try {
    return fs.realpathSync(p).includes(`${path.sep}cursor-agent${path.sep}`);
  } catch {
    return false;
  }
};

async function binary(): Promise<string | null> {
  if (binCache && Date.now() - binCache.at < 30_000) return binCache.path;
  const env = process.env.CURSOR_AGENT_BIN?.trim();
  const dirs = [...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean), path.join(os.homedir(), ".local", "bin")];
  const candidates = [
    ...(env ? [env] : []),
    ...dirs.map((d) => path.join(d, "cursor-agent")),
    ...dirs.map((d) => path.join(d, "agent")).filter(isCursorAgent),
  ];
  const found = candidates.find(isExec) ?? null;
  binCache = { at: Date.now(), path: found };
  return found;
}

/* ── reading ───────────────────────────────────────────────── */

type Summary = { mtime: number; title: string; cwd: string; model: string | null };
const summaries = new Map<string, Summary>();

/** title/cwd/model a chat's meta.json may lack, from its store; cached per mtime */
function storeSummary(dir: string, mtime: number): Summary {
  const hit = summaries.get(dir);
  if (hit && hit.mtime === mtime) return hit;
  const chat = readStore(dir);
  const first = chat?.turns.find((t) => t.kind === "agent");
  const name = chat?.meta.name && chat.meta.name !== "New Agent" ? chat.meta.name : "";
  const s: Summary = {
    mtime,
    title: name || (first?.kind === "agent" ? oneLine(first.userText) : ""),
    cwd: chat?.workspace ?? "",
    model: chat?.meta.lastUsedModel ?? null,
  };
  summaries.set(dir, s);
  return s;
}

const oneLine = (t: string) => {
  const l = t.replace(/\s+/g, " ").trim();
  return l.length > 80 ? `${l.slice(0, 79)}…` : l;
};

function session(id: string, dir: string): AgentSession | null {
  const st = chatStat(dir);
  if (!st.exists) return null;
  const meta = readMetaJson(dir);
  const sum = !meta?.title || !meta?.cwd ? storeSummary(dir, st.mtime) : summaries.get(dir);
  return {
    id,
    title: meta?.title || sum?.title || "Cursor chat",
    cwd: meta?.cwd || sum?.cwd || startedCwds.get(id) || "",
    mtime: meta?.updatedAtMs ? Math.max(meta.updatedAtMs, st.mtime) : st.mtime,
    created: meta?.createdAtMs || undefined,
    size: st.size,
    model: sum?.model ?? null,
  };
}

async function list(): Promise<AgentSession[]> {
  const out: AgentSession[] = [];
  for (const { id, dir } of chatDirs()) {
    const meta = readMetaJson(dir);
    /* chats opened but never used (`create-chat`, an idle TUI) */
    if (meta?.hasConversation === false && turnState(KEY(id))?.status !== "running") continue;
    const s = session(id, dir);
    if (s) out.push(s);
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

async function get(id: string): Promise<AgentSession | null> {
  const dir = findChatDir(id);
  const s = dir ? session(id, dir) : null;
  if (s) return s;
  if (!turnState(KEY(id)) && !fs.existsSync(captureFile(id))) return null;
  return { id, title: "New Cursor session", cwd: startedCwds.get(id) ?? "", mtime: Date.now(), size: 0, model: null };
}

type Snapshot = { dir: string | null; mtime: number; capMtime: number; holdTail: boolean; running: boolean; sig: string };

/** Cheap change detector: file stats plus whether a trailing text block is being held back. */
function snapshot(id: string): Snapshot {
  const dir = findChatDir(id);
  const st = dir ? chatStat(dir) : { mtime: 0, size: 0, exists: false };
  /* a trailing text block may still be growing while the store is being written */
  const holdTail = Date.now() - st.mtime < HOLD_MS;
  let capMtime = 0;
  try {
    capMtime = fs.statSync(captureFile(id)).mtimeMs;
  } catch {
    /* no capture */
  }
  const running = turnState(KEY(id))?.status === "running";
  return { dir, mtime: st.mtime, capMtime, holdTail, running, sig: `${dir}:${st.mtime}:${st.size}:${capMtime}:${holdTail}:${running}` };
}

/** Every entry of the chat, oldest first. */
function allEntries(id: string, snap = snapshot(id)): Entry[] {
  const chat: StoreChat | null = snap.dir ? readStore(snap.dir) : null;
  if (chat && (chat.turns.length || chat.messages.length)) {
    const meta = snap.dir ? readMetaJson(snap.dir) : null;
    const fallbackTs = meta?.createdAtMs ?? chat.meta.createdAt ?? snap.mtime;
    return storeEntries(chat, { fallbackTs, holdTail: snap.holdTail, model: chat.meta.lastUsedModel });
  }
  /* the store only gets a turn after its first step, so during a run an empty store is normal;
   * the capture stands in only when the store is unreadable, or a finished turn left it empty
   * (a store format this adapter doesn't understand) */
  if (snap.capMtime && !snap.running) {
    try {
      const capture = fs.readFileSync(captureFile(id), "utf8");
      if (!chat || capture.includes('"type":"result"')) return streamEntries(capture);
    } catch {
      /* unreadable capture */
    }
  }
  return [];
}

/** Pages end on a user message so a page never starts mid-turn. */
async function history(id: string, before?: string | null): Promise<HistoryPage> {
  const entries = allEntries(id);
  const stop = before == null ? entries.length : Math.min(Math.max(0, Number(before) || 0), entries.length);
  let start = Math.max(0, stop - PAGE);
  while (start > 0 && entries[start].kind !== "user") start--;
  return { entries: entries.slice(start, stop), cursor: start > 0 ? String(start) : null, end: String(entries.length) };
}

function watch(id: string, from: string, onEntries: (entries: Entry[], end: string) => void): () => void {
  const seen = new Set<string>();
  let seeded = false;
  let lastSig = "";
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = () => {
    if (stopped) return;
    try {
      const snap = snapshot(id);
      if (snap.sig !== lastSig) {
        lastSig = snap.sig;
        const entries = allEntries(id, snap);
        if (!seeded) {
          /* entries before `from` came with history; results are re-sent (the client keys them by tool id) */
          const n = Math.max(0, Number(from) || 0);
          for (const e of entries.slice(0, n)) if (e.kind !== "result") seen.add(e.id);
          seeded = true;
        }
        const fresh = entries.filter((e) => !seen.has(e.id));
        fresh.forEach((e) => seen.add(e.id));
        if (fresh.length) onEntries(fresh, String(entries.length));
      }
    } catch {
      /* store mid-write; next tick */
    }
    timer = setTimeout(tick, POLL_MS);
  };
  timer = setTimeout(tick, 0);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/* ── live terminals ────────────────────────────────────────── */

/** Interactive cursor-agent processes, mapped to the chat whose store.db they hold open. */
async function liveProcesses(): Promise<Map<string, { pid: number }>> {
  const out = new Map<string, { pid: number }>();
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
    const joined = argv.join(" ");
    if (!/cursor-agent/.test(joined) || !argv.some((a) => a.endsWith("index.js"))) continue;
    /* headless turns (ours or scripts), the background worker, ACP/MCP helpers */
    if (argv.some((a) => a === "-p" || a === "--print" || a === "worker-server" || a === "worker" || a === "acp" || a === "mcp" || a === "ls" || a === "status")) continue;
    let fds: string[];
    try {
      fds = fs.readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let target: string;
      try {
        target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      const m = /\/chats\/[^/]+\/([^/]+)\/store\.db$/.exec(target);
      if (m) {
        out.set(m[1], { pid: Number(pid) });
        break;
      }
    }
  }
  return out;
}

/* ── driving ───────────────────────────────────────────────── */

function modeArgs(mode: PermissionMode): string[] {
  if (mode === "bypassPermissions") return ["--force", "--approve-mcps"];
  if (mode === "plan") return ["--mode", "plan"];
  return [];
}

function args(text: string, o: { model?: string; mode: PermissionMode; resume?: string }): string[] {
  return [
    "-p",
    "--output-format",
    "stream-json",
    /* assistant text as deltas too, for the live view (cursor-stream.ts tells them apart) */
    "--stream-partial-output",
    "--trust",
    ...(o.model ? ["--model", o.model] : []),
    ...modeArgs(o.mode),
    ...(o.resume ? ["--resume", o.resume] : []),
    ...(viaStdin(text) ? [] : ["--", text]),
  ];
}

/** long prompts go on stdin: one argument is capped at 128 KiB */
const viaStdin = (text: string) => Buffer.byteLength(text) > 64 * 1024;
const stdinFor = (text: string) => (viaStdin(text) ? { stdin: text } : {});

const md5 = (p: string) => createHash("md5").update(path.resolve(p)).digest("hex");
const real = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

/** The folder a chat belongs to: the store is keyed by md5 of the CLI's process.cwd() (a real path), so only an exact match resumes it. */
function chatCwd(id: string, dir: string | null): string | null {
  const meta = dir ? readMetaJson(dir) : null;
  const candidates = [meta?.cwd, dir ? readStore(dir)?.workspace : null, startedCwds.get(id)].filter((c): c is string => !!c);
  if (!dir) return candidates[0] ?? null;
  const hash = path.basename(path.dirname(dir));
  return candidates.find((c) => md5(c) === hash || md5(real(c)) === hash) ?? null;
}

/** Appends raw stream events (with our timestamp and line number) for the fallback history. */
function capturer(initialId: string | null) {
  let id = initialId;
  let n = 0;
  const pending: string[] = [];
  const write = (lines: string[]) => {
    if (!id || !lines.length) return;
    try {
      fs.mkdirSync(captureDir(), { recursive: true, mode: 0o700 });
      const file = captureFile(id);
      if (!n) {
        try {
          n = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length;
        } catch {
          n = 0;
        }
      }
      fs.appendFileSync(file, lines.map((l) => {
        try {
          return `${JSON.stringify({ ...JSON.parse(l), _ts: Date.now(), _n: n++ })}\n`;
        } catch {
          return "";
        }
      }).join(""), { mode: 0o600 });
    } catch {
      /* capture is best effort */
    }
  };
  return {
    line(l: string) {
      /* partial text deltas are only for the live view; the full segment follows */
      if (l.includes('"type":"assistant"') && !l.includes('"model_call_id"')) {
        try {
          if (isPartialAssistant(JSON.parse(l))) return;
        } catch {
          /* not JSON: dropped by write() anyway */
        }
      }
      if (id) write([l]);
      else pending.push(l);
    },
    setId(next: string) {
      id = next;
      write(pending.splice(0));
    },
  };
}

async function start(opts: { cwd: string; text: string; model?: string; mode: PermissionMode }): Promise<{ id: string }> {
  const bin = await profileBin(binary);
  if (!bin) throw new Error("Cursor isn't installed.");
  const tmp = KEY(`new-${randomUUID()}`);
  const cap = capturer(null);
  return new Promise((resolve, reject) => {
    let settled = false;
    let run: ReturnType<typeof startTurn>;
    let live: (line: string) => void = () => {};
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      run = startTurn(tmp, { cmd: bin, args: args(opts.text, opts), cwd: opts.cwd, env: { NO_OPEN_BROWSER: "1" }, ...stdinFor(opts.text) }, (line) => {
        live(line);
        cap.line(line);
        if (settled || !line.startsWith("{")) return;
        try {
          const ev = JSON.parse(line) as { type?: string; subtype?: string; session_id?: string };
          if (ev.type === "system" && ev.subtype === "init" && typeof ev.session_id === "string") {
            settled = true;
            clearTimeout(deadline);
            startedCwds.set(ev.session_id, opts.cwd);
            rekeyTurn(tmp, KEY(ev.session_id));
            cap.setId(ev.session_id);
            resolve({ id: ev.session_id });
          }
        } catch {
          /* not JSON */
        }
      });
    } catch (err) {
      reject(err);
      return;
    }
    live = liveParser(liveStream(run).push);
    /* the route gives up at 90s; a start nobody waits for anymore must not go on editing files */
    deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      stopTurn(tmp);
      reject(new Error("Cursor didn't start a session in time."));
    }, 85_000);
    run.child.on("exit", (code) => {
      clearTimeout(deadline);
      if (settled) return;
      settled = true;
      reject(new Error(friendlyError(turnState(tmp)?.error ?? run.stderr) || `Cursor exited before starting a session (code ${code}).`));
    });
    run.child.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function friendlyError(msg: string | null | undefined): string {
  const m = (msg ?? "").trim().split("\n").filter(Boolean).slice(-1)[0] ?? "";
  if (/Authentication required|not logged in|agent login/i.test(m)) return "Cursor isn't logged in. Run cursor-agent login on the server.";
  return m;
}

async function send(id: string, text: string, opts: { model?: string; mode: PermissionMode }): Promise<void> {
  const bin = await profileBin(binary);
  if (!bin) throw new Error("Cursor isn't installed.");
  const dir = findChatDir(id);
  if (!dir && !startedCwds.has(id)) throw new Error("Cursor session not found.");
  const cwd = chatCwd(id, dir);
  if (!cwd || !fs.existsSync(cwd)) throw new Error("Can't resume: unknown folder.");
  const cap = capturer(id);
  /* failures (e.g. "Authentication required. Please run 'agent login' first") land in runState().error via cli-run */
  let live: (line: string) => void = () => {};
  const run = startTurn(KEY(id), { cmd: bin, args: args(text, { ...opts, resume: id }), cwd, env: { NO_OPEN_BROWSER: "1" }, ...stdinFor(text) }, (line) => {
    live(line);
    cap.line(line);
  });
  live = liveParser(liveStream(run).push);
}

const adapter: AgentAdapter = {
  id: "cursor",
  label: "Cursor",
  binary,
  list,
  get,
  history,
  watch,
  liveProcesses,
  start,
  send,
  runState: (id) => turnState(KEY(id)),
  stop: async (id) => stopTurn(KEY(id)),
};

export default adapter;
