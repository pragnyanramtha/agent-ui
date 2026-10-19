import type { AgentId, Entry, PendingAsk, PermissionMode } from "@/lib/types";
import type { Source } from "../handoff-shape";

export type { AgentId };

/* Every non-Claude coding agent (Codex, OpenCode, Cursor, Devin, ...) plugs in
 * through this adapter. Claude keeps its own richer path (Agent SDK runner,
 * lib/server/sessions.ts); these adapters produce the same Entry stream so the
 * UI renders every agent the same way. */


export type AgentSession = {
  /** the agent's own session id (no agent prefix) */
  id: string;
  title: string;
  cwd: string;
  /** last activity, epoch ms */
  mtime: number;
  /** bytes of history, for display only (0 if unknown) */
  size: number;
  model?: string | null;
};

/** `cursor`/`end` are opaque to callers: whatever the adapter needs to page back or resume live updates. */
export type HistoryPage = { entries: Entry[]; cursor: string | null; end: string };

export type CliRunState = {
  status: "running" | "idle" | "error";
  error: string | null;
  startedAt: number;
  /** approvals the agent is waiting on (drivers that can ask: Codex's app server) */
  pending?: PendingAsk[];
};

/** `effort` is a level from lib/agent-traits.ts; drivers without levels ignore it */
export type StartOptions = { cwd: string; text: string; model?: string; effort?: string; mode: PermissionMode };
export type SendOptions = { model?: string; effort?: string; mode: PermissionMode };

export interface AgentAdapter {
  id: AgentId;
  label: string;
  /** absolute path of the CLI, or null if it isn't installed */
  binary(): Promise<string | null>;
  /** newest first; cheap (no full transcript reads) */
  list(): Promise<AgentSession[]>;
  get(id: string): Promise<AgentSession | null>;
  /** latest page when `before` is null, else the page before that cursor */
  history(id: string, before?: string | null): Promise<HistoryPage>;
  /** live entries after `from` (a HistoryPage.end); calls back with the new `end`. Returns unsubscribe. */
  watch(id: string, from: string, onEntries: (entries: Entry[], end: string) => void): () => void;
  /** native ids of sessions an interactive CLI has open right now, with the pid (for terminal detection) */
  liveProcesses?(): Promise<Map<string, { pid: number }>>;
  /** start a new session driven by the web; resolves once the agent reports its session id */
  start(opts: StartOptions): Promise<{ id: string }>;
  /** start a session that already knows an earlier conversation (from another agent), natively if the agent can */
  importStart?(opts: StartOptions, src: Source): Promise<{ id: string }>;
  /** continue a session from the web (non-interactive resume) */
  send(id: string, text: string, opts: SendOptions): Promise<void>;
  /** state of the web-driven run for this session, if one exists */
  runState(id: string): CliRunState | null;
  stop(id: string): Promise<void>;
  /** every file the agent's own store keeps this session's history in, and the folders that store lives under;
   * agents without one file per session leave this out (their history can't be deleted from here) */
  transcriptFiles?(id: string): Promise<{ files: string[]; roots: string[] }>;
}
