import { handoffTitle } from "@/lib/handoff-text";
import path from "node:path";
import type { PermissionMode, RunState, SessionSummary, TerminalInfo } from "@/lib/types";
import { liveTerminals, multiplexer } from "../sessions";
import { adapterFor, allAdapters, parseSessionKey, sessionKey } from "./index";
import type { AgentAdapter, CliRunState } from "./types";

/* Glue between the agent adapters and the routes/UI types. */

/** The web-driven turn of a CLI agent as the UI's RunState (approvals only where the driver can ask). */
export function toRunState(key: string, s: CliRunState | null, mode: PermissionMode = "default", model: string | null = null): RunState | null {
  /* a finished turn isn't a live session; only a running one (or one that just failed) is */
  if (!s || (s.status !== "running" && !s.error)) return null;
  return {
    status: s.status === "running" ? "running" : s.status === "error" ? "error" : "idle",
    model,
    permissionMode: mode,
    slashCommands: [],
    pending: s.pending ?? [],
    error: s.error,
    costUsd: null,
    sessionId: key,
  };
}


export async function terminalOf(adapter: AgentAdapter, native: string): Promise<TerminalInfo | null> {
  const live = await adapter.liveProcesses?.().catch(() => null);
  const hit = live?.get(native);
  if (!hit) return null;
  return { pid: hit.pid, status: "unknown", name: null, multiplexer: await multiplexer(hit.pid) };
}

/** Sessions of every installed non-Claude agent, as sidebar rows. One slow or broken adapter never blocks the rest. */
export async function agentSummaries(): Promise<SessionSummary[]> {
  const adapters = await allAdapters();
  const lists = await Promise.all(
    adapters.map(async (a) => {
      const [sessions, live] = await Promise.all([
        withTimeout(a.list(), 4000).catch(() => []),
        withTimeout(a.liveProcesses?.() ?? Promise.resolve(new Map<string, { pid: number }>()), 2000).catch(() => new Map<string, { pid: number }>()),
      ]);
      return Promise.all(
        (sessions ?? []).slice(0, 150).map(async (s): Promise<SessionSummary> => {
          const key = sessionKey(a.id, s.id);
          const proc = live?.get(s.id);
          return {
            id: key,
            agent: a.id,
            title: handoffTitle(s.title) || "Untitled",
            cwd: s.cwd,
            project: path.basename(s.cwd) || s.cwd,
            mtime: s.mtime,
            ...(s.created ? { created: s.created } : {}),
            size: s.size,
            terminal: proc ? { pid: proc.pid, status: "unknown", name: null, multiplexer: await multiplexer(proc.pid) } : null,
            web: toRunState(key, a.runState(s.id), "default", s.model ?? null),
          };
        }),
      );
    }),
  );
  return lists.flat();
}

export async function installedAgents() {
  const adapters = await allAdapters();
  return Promise.all(adapters.map(async (a) => ({ id: a.id, label: a.label, installed: Boolean(await withTimeout(a.binary(), 3000).catch(() => null)) })));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
}

/** The live terminal of any session key ("<agent>:<id>" or a bare Claude id). */
export async function terminalForKey(raw: string): Promise<TerminalInfo | null> {
  const key = parseSessionKey(decodeURIComponent(raw));
  if (!key) return null;
  if (key.agent === "claude") return (await liveTerminals(0)).get(key.native) ?? null;
  const a = await adapterFor(key.agent);
  return a ? terminalOf(a, key.native) : null;
}
