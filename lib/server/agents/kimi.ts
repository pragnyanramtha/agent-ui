import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Entry, PermissionMode } from "@/lib/types";
import { liveStream, rekeyTurn, startTurn, stopTurn, turnState } from "./cli-run";
import { activeProfile, allProfiles, profileBin, resolveBin } from "../profiles";
import type { AgentAdapter, AgentSession, CliRunState, HistoryPage } from "./types";

/* Kimi Code CLI (Moonshot) adapter.
 * A home (KIMI_CODE_HOME, default ~/.kimi-code) keeps session_index.jsonl and, per session,
 * sessions/<workspace>/<session_id>/{state.json, agents/main/wire.jsonl}. wire.jsonl is an
 * append-only event log (prompts, content parts, tool calls/results, usage) and the source of
 * truth for history. Every Kimi profile can point at its own home, so all of them are read.
 * Web turns run `kimi --prompt=<text> --output-format stream-json` (`-S <id>` to continue). */

const PAGE = 120;
const POLL_MS = 1000;
const keyOf = (id: string) => `kimi:${id}`;

/* ---------- binary ---------- */

let binCache: { at: number; path: string | null } | null = null;
async function binary(): Promise<string | null> {
  if (binCache && Date.now() - binCache.at < 30_000) return binCache.path;
  const found = resolveBin(process.env.KIMI_BIN || "kimi");
  binCache = { at: Date.now(), path: found };
  return found;
}

/* ---------- sessions ---------- */

function homes(): string[] {
  const out = new Set<string>([process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code")]);
  for (const p of allProfiles()) if (p.agent === "kimi" && p.env.KIMI_CODE_HOME) out.add(p.env.KIMI_CODE_HOME);
  return [...out];
}

type Meta = { id: string; dir: string; cwd: string };

function index(): Map<string, Meta> {
  const map = new Map<string, Meta>();
  for (const home of homes()) {
    let raw = "";
    try {
      raw = fs.readFileSync(path.join(home, "session_index.jsonl"), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as { sessionDir?: string; sessionId?: string; workDir?: string };
        if (r.sessionId && r.sessionDir) map.set(r.sessionId, { id: r.sessionId, dir: r.sessionDir, cwd: r.workDir ?? "" });
      } catch {
        /* partial line */
      }
    }
  }
  return map;
}

const wireOf = (m: Meta) => path.join(m.dir, "agents", "main", "wire.jsonl");

const heads = new Map<string, { title: string; model: string | null }>();

/** The first prompt and the model, from the start of the log (prompts follow a large system-prompt record). */
function head(m: Meta): { title: string; model: string | null } {
  const hit = heads.get(m.id);
  if (hit?.title) return hit;
  let title = "";
  let model: string | null = null;
  try {
    const fd = fs.openSync(wireOf(m), "r");
    try {
      const buf = Buffer.alloc(1 << 20);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      for (const line of buf.subarray(0, n).toString("utf8").split("\n")) {
        if (!line.startsWith("{")) continue;
        if (!model && line.includes('"profile.bind"')) model = /"modelAlias":"([^"]+)"/.exec(line)?.[1] ?? null;
        if (line.includes('"turn.prompt"')) {
          try {
            const ev = JSON.parse(line) as { input?: { type: string; text?: string }[]; origin?: { kind?: string } };
            if (ev.origin?.kind && ev.origin.kind !== "user") continue;
            title = (ev.input ?? []).map((x) => x.text ?? "").join(" ").replace(/\s+/g, " ").trim().slice(0, 120);
            if (title) break;
          } catch {
            /* cut off at the read limit */
          }
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* no log yet */
  }
  const out = { title, model };
  heads.set(m.id, out);
  return out;
}

function toSession(m: Meta): AgentSession | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(wireOf(m));
  } catch {
    return null;
  }
  let state: { title?: string; isCustomTitle?: boolean; archived?: boolean; updatedAt?: number; cwd?: string } = {};
  try {
    state = JSON.parse(fs.readFileSync(path.join(m.dir, "state.json"), "utf8"));
  } catch {
    /* fine */
  }
  if (state.archived) return null;
  const h = head(m);
  return {
    id: m.id,
    title: (state.isCustomTitle && state.title) || h.title || "Untitled",
    cwd: state.cwd || m.cwd,
    mtime: Math.max(st.mtimeMs, state.updatedAt ?? 0),
    size: st.size,
    model: h.model,
  };
}

/* ---------- wire.jsonl → entries ---------- */

type Ev = Record<string, unknown> & { type?: string; time?: number };
type Part = { type?: string; text?: string; think?: string };
type LoopEv = {
  type?: string;
  uuid?: string;
  stepUuid?: string;
  toolCallId?: string;
  name?: string;
  args?: Record<string, unknown>;
  part?: Part;
  result?: { output?: unknown; error?: unknown; isError?: boolean; is_error?: boolean };
};

const CLIP = 8000;
const iso = (t: unknown) => new Date(typeof t === "number" ? t : Date.now()).toISOString();
const textOf = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : Array.isArray(v) ? v.map(textOf).join("\n") : typeof v === "object" && "text" in (v as object) ? textOf((v as { text: unknown }).text) : JSON.stringify(v));

/** Kimi's tools mostly share Claude's names; their path argument is `path`. */
function toolInput(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (["Write", "Edit", "Read", "MultiEdit"].includes(name) && typeof args.path === "string" && !args.file_path) return { ...args, file_path: args.path };
  return args;
}

function toEntries(ev: Ev, at: number): Entry[] {
  const ts = iso(ev.time);
  const id = `k${at}`;
  if (ev.type === "turn.prompt") {
    const origin = (ev.origin as { kind?: string } | undefined)?.kind;
    if (origin && origin !== "user") return [];
    const input = (ev.input as { type: string; text?: string }[] | undefined) ?? [];
    const text = input.filter((x) => x.type === "text").map((x) => x.text ?? "").join("\n").trim();
    const images = input.filter((x) => x.type === "image" || x.type === "image_url").length;
    return text || images ? [{ kind: "user", id, ts, text, images }] : [];
  }
  if (ev.type === "context.append_loop_event") {
    const e = (ev.event ?? {}) as LoopEv;
    const msgId = e.stepUuid ?? e.uuid ?? id;
    if (e.type === "content.part") {
      if (e.part?.type === "text" && e.part.text) return [{ kind: "text", id: e.uuid ?? id, ts, msgId, text: e.part.text }];
      if (e.part?.type === "think" && e.part.think) return [{ kind: "thinking", id: e.uuid ?? id, ts, msgId, text: e.part.think }];
      return [];
    }
    if (e.type === "tool.call" && e.toolCallId) {
      const name = e.name ?? "tool";
      return [{ kind: "tool", id: e.uuid ?? id, ts, msgId, toolUseId: e.toolCallId, name, input: toolInput(name, e.args ?? {}) }];
    }
    if (e.type === "tool.result" && e.toolCallId) {
      const r = e.result ?? {};
      const isError = Boolean(r.isError ?? r.is_error ?? (r.error !== undefined && r.error !== null));
      const text = textOf(isError && r.error !== undefined ? r.error : (r.output ?? r));
      return [{ kind: "result", id, ts, toolUseId: e.toolCallId, result: { text: text.slice(0, CLIP), isError, truncated: text.length > CLIP } }];
    }
    return [];
  }
  if (ev.type === "usage.record") {
    const u = (ev.usage ?? {}) as { inputOther?: number; output?: number; inputCacheRead?: number; inputCacheCreation?: number };
    return [{ kind: "usage", id, ts, model: String(ev.model ?? ""), input: u.inputOther ?? 0, cacheRead: u.inputCacheRead ?? 0, cacheWrite: u.inputCacheCreation ?? 0, output: u.output ?? 0 }];
  }
  if (ev.type === "turn.ended" && ev.reason && ev.reason !== "completed") {
    const why = String(ev.reason);
    const detail = textOf(ev.error ?? ev.message ?? "");
    return [{ kind: "notice", id, ts, tone: why === "cancelled" || why === "interrupted" ? "info" : "warn", text: detail ? `Turn ${why}: ${detail.slice(0, 300)}` : `Turn ${why}.` }];
  }
  return [];
}

/** Complete lines of `buf` (which starts at byte `base` of the file) as entries; `used` is how many bytes were consumed. */
function parse(buf: Buffer, base: number): { entries: Entry[]; used: number } {
  const entries: Entry[] = [];
  let pos = 0;
  for (;;) {
    const nl = buf.indexOf(10, pos);
    if (nl === -1) break;
    const line = buf.subarray(pos, nl);
    if (line.length > 1 && line[0] === 0x7b) {
      try {
        entries.push(...toEntries(JSON.parse(line.toString("utf8")) as Ev, base + pos));
      } catch {
        /* skip a bad line */
      }
    }
    pos = nl + 1;
  }
  return { entries, used: pos };
}

function page(id: string, before: string | null): HistoryPage {
  const m = index().get(id);
  if (!m) return { entries: [], cursor: null, end: "b:0" };
  let buf: Buffer;
  try {
    buf = fs.readFileSync(wireOf(m));
  } catch {
    return { entries: [], cursor: null, end: "b:0" };
  }
  const { entries, used } = parse(buf, 0);
  const stop = before?.startsWith("i:") ? Math.min(entries.length, Number(before.slice(2)) || 0) : entries.length;
  let start = Math.max(0, stop - PAGE);
  /* don't split a tool call from its result */
  while (start > 0 && entries[start].kind === "result") start--;
  return { entries: entries.slice(start, stop), cursor: start > 0 ? `i:${start}` : null, end: `b:${used}` };
}

function watch(id: string, from: string, onEntries: (entries: Entry[], end: string) => void): () => void {
  let offset = Number(from.replace(/^b:/, "")) || 0;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const m = index().get(id);
    if (!m) return;
    try {
      const size = fs.statSync(wireOf(m)).size;
      if (size < offset) offset = 0;
      if (size === offset) return;
      const fd = fs.openSync(wireOf(m), "r");
      try {
        const buf = Buffer.alloc(Math.min(size - offset, 32 << 20));
        const n = fs.readSync(fd, buf, 0, buf.length, offset);
        const { entries, used } = parse(buf.subarray(0, n), offset);
        if (!used) return;
        offset += used;
        if (entries.length) onEntries(entries, `b:${offset}`);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* not there yet */
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

function cmdline(pid: number): string[] | null {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

const isPrint = (cmd: string[]) => cmd.some((a) => a === "-p" || a === "--prompt" || a.startsWith("--prompt="));

/** Interactive kimi TUIs: the session comes from -S/-r, or from an open file under a session folder. */
async function liveProcesses(): Promise<Map<string, { pid: number }>> {
  const map = new Map<string, { pid: number }>();
  if (process.platform !== "linux") return map;
  let pids: string[] = [];
  try {
    pids = fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d));
  } catch {
    return map;
  }
  for (const d of pids) {
    const pid = Number(d);
    const cmd = cmdline(pid);
    if (!cmd?.length || path.basename(cmd[0]) !== "kimi" || isPrint(cmd) || cmd.includes("acp") || cmd.includes("web")) continue;
    const i = cmd.findIndex((a) => a === "-S" || a === "--session" || a === "-r");
    let id = i !== -1 ? cmd[i + 1] : null;
    if (!id) {
      try {
        for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
          const target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
          const m = /\/(session_[0-9a-f-]{36})\//.exec(target);
          if (m) {
            id = m[1];
            break;
          }
        }
      } catch {
        /* not ours to read */
      }
    }
    if (id) map.set(id, { pid });
  }
  return map;
}

/* ---------- turns ---------- */

const LOGIN_HINT = "Kimi isn't logged in. Run kimi, then /login, on the server.";

function friendly(err: string | null): string | null {
  if (!err) return err;
  const clean = err.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/^error:\s*/i, "").trim();
  if (/no model configured|not logged in|\/login|unauthori[sz]ed|401/i.test(clean)) return LOGIN_HINT;
  return clean || err;
}

function argsFor(text: string, mode: PermissionMode, model: string | undefined, resume: string | null): string[] {
  const args: string[] = [];
  if (resume) args.push("-S", resume);
  if (model) args.push("-m", model);
  if (mode === "plan" && !resume) args.push("--plan");
  args.push(`--prompt=${text}`, "--output-format", "stream-json");
  return args;
}

/** stream-json prints whole assistant messages; show each as live text until the log has it. */
function onLine(run: Parameters<typeof liveStream>[0], learn?: (id: string) => void) {
  const live = liveStream(run);
  let n = 0;
  return (line: string) => {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.role === "assistant" && typeof ev.content === "string" && ev.content) live.push(n++, "text", ev.content);
    if (ev.type === "session.resume_hint" && typeof ev.session_id === "string") learn?.(ev.session_id);
  };
}

async function start(opts: { cwd: string; text: string; model?: string; mode: PermissionMode }): Promise<{ id: string }> {
  const bin = await profileBin(binary);
  if (!bin) throw new Error("Kimi isn't installed.");
  const known = new Set(index().keys());
  const t0 = Date.now();
  const tempKey = `kimi:pending-${t0.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let learned: string | null = null;
  const run = startTurn(tempKey, { cmd: bin, args: argsFor(opts.text, opts.mode, opts.model ?? activeProfile()?.defaultModel, null), cwd: opts.cwd }, (line) => handle(line));
  const handle = onLine(run, (id) => (learned = id));
  const cwd = path.resolve(opts.cwd);
  return new Promise((resolve, reject) => {
    const tick = () => {
      const id =
        learned ??
        [...index().values()].find((m) => !known.has(m.id) && path.resolve(m.cwd) === cwd)?.id ??
        null;
      if (id) {
        rekeyTurn(tempKey, keyOf(id));
        return resolve({ id });
      }
      if (run.state.status !== "running") return reject(new Error(friendly(run.state.error ?? lastStderr(run.stderr)) || "Kimi exited before it created a session."));
      if (Date.now() - t0 > 85_000) {
        stopTurn(tempKey);
        return reject(new Error("Kimi didn't start a session in time."));
      }
      setTimeout(tick, 300);
    };
    setTimeout(tick, 300);
  });
}

const lastStderr = (s: string) => s.trim().split("\n").filter(Boolean).slice(-1)[0] ?? "";

async function send(id: string, text: string, opts: { model?: string; mode: PermissionMode }): Promise<void> {
  const bin = await profileBin(binary);
  if (!bin) throw new Error("Kimi isn't installed.");
  const m = index().get(id);
  if (!m) throw new Error("Kimi session not found.");
  const cwd = m.cwd && fs.existsSync(m.cwd) ? m.cwd : os.homedir();
  const run = startTurn(keyOf(id), { cmd: bin, args: argsFor(text, opts.mode, opts.model ?? activeProfile()?.defaultModel, id), cwd }, (line) => handle(line));
  const handle = onLine(run);
}

function runState(id: string): CliRunState | null {
  const st = turnState(keyOf(id));
  if (!st) return null;
  return st.error ? { ...st, error: friendly(st.error) } : st;
}

const adapter: AgentAdapter = {
  id: "kimi",
  label: "Kimi",
  binary,
  list: async () =>
    [...index().values()]
      .map(toSession)
      .filter((s): s is AgentSession => s !== null)
      .sort((a, b) => b.mtime - a.mtime),
  get: async (id) => {
    const m = index().get(id);
    return m ? toSession(m) : null;
  },
  history: async (id, before) => page(id, before ?? null),
  watch,
  liveProcesses,
  start,
  send,
  runState,
  stop: async (id) => stopTurn(keyOf(id)),
};

export default adapter;
