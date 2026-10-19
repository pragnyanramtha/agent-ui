import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { PendingAsk, StreamDelta } from "@/lib/types";
import { activeProfile } from "../profiles";
import type { CliRunState } from "./types";

/* Web-driven turns for CLI agents: each send/start spawns the agent's
 * non-interactive mode (e.g. `codex app-server`, `opencode run`, `cursor-agent -p`)
 * and tracks it here, keyed "<agent>:<sessionId>". One turn per session at a
 * time; the transcript on disk stays the source of truth for content.
 *
 * While a turn runs, adapters can also push live text/thinking deltas parsed
 * from the CLI's output (emitDelta / liveStream). They are buffered for the
 * turn so a client that connects late (e.g. right after starting a session)
 * gets the text so far, and dropped when the turn ends: by then the persisted
 * entries have taken over. */

export type Run = {
  child: ChildProcess;
  state: CliRunState;
  stderr: string;
  listeners: Set<(s: CliRunState) => void>;
  /** current key (changes when a new session's id becomes known) */
  key: string;
  /** live deltas of this turn, accumulated per stream ("<msgId>\0<index>") */
  deltas: Map<string, StreamDelta>;
  /** answers to the approvals in state.pending, by request id */
  asks: Map<string, (a: Answer) => void>;
  /** set by failTurn: the turn ends as an error with this message, however the process exits */
  failure?: string;
};

export type Answer = { allow: boolean; always: boolean };

const runs: Map<string, Run> = (() => {
  const g = globalThis as typeof globalThis & { __cliRuns?: Map<string, Run> };
  return (g.__cliRuns ??= new Map());
})();

const deltaListeners: Map<string, Set<(d: StreamDelta) => void>> = (() => {
  const g = globalThis as typeof globalThis & { __cliDeltaListeners?: Map<string, Set<(d: StreamDelta) => void>> };
  return (g.__cliDeltaListeners ??= new Map());
})();

/** streams kept per turn for late subscribers; the oldest go first */
const MAX_STREAMS = 200;
export const MAX_ARG = 120 * 1024;
const MAX_ARGS = 1536 * 1024;

export type SpawnSpec = {
  cmd: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  /** written to stdin, which is then closed */
  stdin?: string;
  /** keep stdin open as a pipe (for JSON-RPC style drivers); the adapter writes to `run.child.stdin` */
  keepStdin?: boolean;
};

/**
 * Spawns one turn. `onStdout` sees each stdout line (adapters parse JSON event
 * streams here, e.g. to learn a new session id); `onChunk` sees raw decoded
 * stdout as it arrives (for plain-text output). Throws if a turn is already
 * running for the key.
 */
export function startTurn(key: string, spec: SpawnSpec, onStdout?: (line: string) => void, onChunk?: (text: string) => void): Run {
  const existing = runs.get(key);
  if (existing?.state.status === "running") throw new Error("A turn is already running for this session.");
  /* Linux caps one argument at 128 KiB (and all of them at a few MB); spawn would fail with a bare E2BIG */
  const big = Math.max(0, ...spec.args.map((a) => Buffer.byteLength(a)));
  if (big > MAX_ARG || spec.args.reduce((n, a) => n + Buffer.byteLength(a), 0) > MAX_ARGS) {
    throw new Error(`Message too long (${Math.round(big / 1024)} KB). Shorten it or attach a file.`);
  }
  const piped = spec.keepStdin || spec.stdin !== undefined;
  /* a profile (another backend, an API key, a proxy) adds its global flags and environment */
  const profile = activeProfile();
  const child = spawn(spec.cmd, [...(profile?.args ?? []), ...spec.args], {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env, ...profile?.env },
    stdio: [piped ? "pipe" : "ignore", "pipe", "pipe"],
    /* its own process group, so Stop also ends the commands and helpers the agent started */
    detached: true,
  });
  const run: Run = {
    child,
    state: { status: "running", error: null, startedAt: Date.now() },
    stderr: "",
    listeners: existing?.listeners ?? new Set(),
    key,
    deltas: new Map(),
    asks: new Map(),
  };
  runs.set(key, run);
  const emit = () => run.listeners.forEach((fn) => fn(run.state));
  /* writes after the child exited must not crash the server */
  child.stdin?.on("error", () => undefined);
  if (spec.stdin !== undefined && !spec.keepStdin) child.stdin?.end(spec.stdin);
  let buf = "";
  const decoder = new StringDecoder("utf8");
  child.stdout?.on("data", (chunk: Buffer) => {
    const text = decoder.write(chunk);
    if (!text) return;
    onChunk?.(text);
    buf += text;
    /* a line this long isn't an event anyone can use */
    if (buf.length > 16 << 20) buf = buf.slice(buf.lastIndexOf("\n") + 1 || buf.length);
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onStdout?.(line);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    run.stderr = (run.stderr + chunk.toString("utf8")).slice(-4000);
  });
  child.on("error", (err) => {
    run.asks.clear();
    run.state = { ...run.state, status: "error", error: err.message, pending: [] };
    run.deltas.clear();
    emit();
    release(run);
  });
  /* stdout can still deliver the last lines (a final error or result) after "exit"; "close" waits for them,
   * but an orphaned helper holding stdout open would keep it from ever firing */
  let finished = false;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  child.on("exit", (code, signal) => {
    exitTimer = setTimeout(() => finish(code, signal), 1500);
  });
  child.on("close", (code, signal) => finish(code, signal));
  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (finished) return;
    finished = true;
    clearTimeout(exitTimer);
    const tail = decoder.end();
    if (tail) onChunk?.(tail);
    buf += tail;
    if (buf.trim()) onStdout?.(buf.trim());
    buf = "";
    if (run.state.status !== "running") return;
    run.asks.clear();
    run.state = run.failure
      ? { ...run.state, status: "error", error: run.failure, pending: [] }
      : code === 0 || signal === "SIGTERM" || signal === "SIGKILL"
        ? { ...run.state, status: "idle", pending: [] }
        : { ...run.state, status: "error", error: lastLine(run.stderr) || `Exited with code ${code}`, pending: [] };
    run.deltas.clear();
    emit();
    release(run);
  };
  emit();
  return run;
}

/** a turn that ended cleanly shows as no run at all (toRunState), so it can go */
const forgettable = (run: Run) => run.state.status === "idle" && !run.state.error;

/* Adapters still read a finished run's state and stderr for a moment (start promises, close handlers), so this
 * waits. Failures stay in the map: their error is shown and notified until the next turn. */
function release(run: Run) {
  setTimeout(() => {
    run.stderr = "";
    if (forgettable(run) && !run.listeners.size && runs.get(run.key) === run) runs.delete(run.key);
  }, 5000).unref();
}

const lastLine = (s: string) => s.trim().split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 300) ?? "";

export const turnState = (key: string) => runs.get(key)?.state ?? null;

/** The agent reported the turn failed (its own message, clearer than stderr): it ends as an error, kept until the next turn. */
export function failTurn(run: Run, error: string) {
  run.failure = error;
  if (run.state.status === "running") return;
  run.state = { ...run.state, status: "error", error };
  /* a clean finish may already have been forgotten */
  if (!runs.has(run.key)) runs.set(run.key, run);
  run.listeners.forEach((fn) => fn(run.state));
}

/** The agent asks before acting: the approval shows in the session (and the inbox) until it's answered or the turn ends. */
export function askUser(run: Run, ask: PendingAsk, onAnswer: (a: Answer) => void) {
  run.asks.set(ask.requestId, onAnswer);
  run.state = { ...run.state, pending: [...(run.state.pending ?? []), ask] };
  run.listeners.forEach((fn) => fn(run.state));
}

/** false when nothing with that id is waiting (answered already, or the turn ended) */
export function answerTurn(key: string, requestId: string, a: Answer): boolean {
  const run = runs.get(key);
  const fn = run?.asks.get(requestId);
  if (!run || !fn) return false;
  run.asks.delete(requestId);
  run.state = { ...run.state, pending: (run.state.pending ?? []).filter((p) => p.requestId !== requestId) };
  run.listeners.forEach((l) => l(run.state));
  fn(a);
  return true;
}
/** keys of turns still running */
export const runningTurns = () => [...runs].filter(([, r]) => r.state.status === "running").map(([k]) => k);

/** Re-key a run (a new session whose id is only known after the CLI starts). Live deltas follow the run. */
export function rekeyTurn(from: string, to: string) {
  const run = runs.get(from);
  if (!run || from === to) return;
  runs.delete(from);
  /* keep state listeners someone attached to the final key before the run moved there */
  const waiting = runs.get(to);
  if (waiting && waiting !== run) waiting.listeners.forEach((fn) => run.listeners.add(fn));
  run.key = to;
  runs.set(to, run);
  /* anyone already watching the final key gets the text so far */
  const fns = deltaListeners.get(to);
  if (fns?.size) for (const d of run.deltas.values()) fns.forEach((fn) => fn({ ...d }));
}

/** SIGTERM to the turn's whole process group, then SIGKILL whatever ignored it. */
export function killGroup(child: ChildProcess) {
  const pid = child.pid;
  if (!pid) return;
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        /* gone */
      }
    }
  };
  signal("SIGTERM");
  setTimeout(() => signal("SIGKILL"), 5000).unref();
}

/** ppid and process group of every process (empty without /proc) */
function processTable(): Map<number, { ppid: number; pgid: number }> {
  const out = new Map<number, { ppid: number; pgid: number }>();
  let names: string[];
  try {
    names = fs.readdirSync("/proc");
  } catch {
    return out;
  }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${n}/stat`, "utf8");
      /* the command name (field 2) can hold spaces and parentheses; state, ppid and pgrp follow it */
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      out.set(Number(n), { ppid: Number(f[1]), pgid: Number(f[2]) });
    } catch {
      /* gone */
    }
  }
  return out;
}

/** What to signal so `pid` and everything it started end: the process groups inside its tree (negative), else single pids. */
function treeTargets(pid: number): number[] {
  const table = processTable();
  const kids = new Map<number, number[]>();
  for (const [p, { ppid }] of table) kids.set(ppid, [...(kids.get(ppid) ?? []), p]);
  const tree = new Set([pid]);
  for (const queue = [pid]; queue.length; ) {
    for (const k of kids.get(queue.shift()!) ?? []) {
      if (tree.has(k)) continue;
      tree.add(k);
      queue.push(k);
    }
  }
  /* a group led from outside the tree isn't ours to end */
  const out = new Set<number>();
  for (const p of tree) {
    const g = table.get(p)?.pgid;
    if (p !== pid) out.add(g && tree.has(g) ? -g : p);
  }
  out.delete(-pid);
  return [...out];
}

/**
 * killGroup plus the process groups the agent's descendants made for themselves (Gemini runs each shell command
 * detached). The tree is read before the first signal: once a parent dies its children move to init and can't be found.
 */
export function killTree(child: ChildProcess) {
  const pid = child.pid;
  if (!pid) return;
  const targets = new Set(treeTargets(pid));
  const signal = (sig: NodeJS.Signals) => {
    for (const t of targets) {
      try {
        process.kill(t, sig);
      } catch {
        /* gone */
      }
    }
  };
  signal("SIGTERM");
  killGroup(child);
  setTimeout(() => {
    /* only while the pid is still ours: once Node has reaped it, it may belong to someone else */
    if (child.exitCode === null && child.signalCode === null) for (const t of treeTargets(pid)) targets.add(t);
    signal("SIGKILL");
  }, 5000).unref();
}

export function stopTurn(key: string) {
  const run = runs.get(key);
  if (run?.state.status === "running") killTree(run.child);
}

export function onTurn(key: string, fn: (s: CliRunState) => void) {
  let run = runs.get(key);
  if (!run) {
    run = {
      child: undefined as unknown as ChildProcess,
      state: { status: "idle", error: null, startedAt: 0 },
      stderr: "",
      listeners: new Set(),
      key,
      deltas: new Map(),
      asks: new Map(),
    };
    runs.set(key, run);
  }
  run.listeners.add(fn);
  const r = run;
  return () => {
    r.listeners.delete(fn);
    /* a rekey moved this listener onto the run that took the key */
    runs.get(r.key)?.listeners.delete(fn);
    /* a placeholder for a session someone only looked at, or a finished turn, goes once nobody listens */
    if ((!r.child || forgettable(r)) && !r.listeners.size && runs.get(r.key) === r) runs.delete(r.key);
  };
}

/* ---------- live deltas ---------- */

/** Appends live text to the running turn under `key` and tells its subscribers. Ignored once the turn ended. */
export function emitDelta(key: string, delta: StreamDelta) {
  const run = runs.get(key);
  if (!run || run.state.status !== "running" || !delta.text) return;
  const k = `${delta.msgId}\0${delta.index}`;
  const prev = run.deltas.get(k);
  if (prev) prev.text += delta.text;
  else {
    run.deltas.set(k, { ...delta });
    if (run.deltas.size > MAX_STREAMS) run.deltas.delete(run.deltas.keys().next().value!);
  }
  deltaListeners.get(key)?.forEach((fn) => fn(delta));
}

/** Live deltas for `key`. A turn already running replays its text so far first (one delta per stream). */
export function onDelta(key: string, fn: (d: StreamDelta) => void): () => void {
  let set = deltaListeners.get(key);
  if (!set) deltaListeners.set(key, (set = new Set()));
  set.add(fn);
  const run = runs.get(key);
  /* `?.`: runs that outlived a dev hot reload predate the buffer */
  if (run?.state.status === "running") for (const d of run.deltas?.values() ?? []) fn({ ...d });
  const own = set;
  return () => {
    own.delete(fn);
    if (!own.size && deltaListeners.get(key) === own) deltaListeners.delete(key);
  };
}

/**
 * Per-turn writer for adapters: `push(segment, kind, text)` appends to the live
 * stream of one assistant message/part ("segment", any id unique within the
 * turn). msgIds are "live:<key at start>:<turn start>:<segment>", which the
 * client recognises as replaceable by persisted entries. Follows rekeys.
 */
export function liveStream(run: Run) {
  const base = `live:${run.key}:${run.state.startedAt.toString(36)}`;
  return {
    push(segment: string | number, kind: StreamDelta["kind"], text: string) {
      if (text) emitDelta(run.key, { msgId: `${base}:${segment}`, index: 0, kind, text });
    },
  };
}
