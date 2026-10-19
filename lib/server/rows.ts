import { getRun, lastFailure } from "./runner";
import { listSessions } from "./sessions";
import { agentSummaries } from "./agents/bridge";
import { allSessionMeta, type SessionMeta } from "./profiles";
import type { SessionSummary } from "@/lib/types";

/** A row with what the user set on it: their own title, pinned, archived, snoozed. */
export function withMeta(s: SessionSummary, m: SessionMeta | undefined): SessionSummary {
  if (!m) return s;
  return {
    ...s,
    ...(m.title ? { title: m.title } : {}),
    ...(m.pinned ? { pinned: true } : {}),
    ...(m.archived ? { archived: true } : {}),
    ...(m.snoozedUntil ? { snoozedUntil: m.snoozedUntil } : {}),
  };
}

/** Every session the list shows, Claude and the other agents, newest first. Archived ones included, deleted ones not. */
export async function sessionRows(): Promise<SessionSummary[]> {
  const [sessions, others] = await Promise.all([listSessions(), agentSummaries().catch(() => [])]);
  const meta = allSessionMeta();
  return [
    ...sessions.map((s) => {
      const run = getRun(s.id);
      if (run) return { ...s, terminal: null, web: run.state };
      /* a run that ended on a failure still reports it, until the session is used again (here or in a terminal) */
      const failed = s.terminal ? null : lastFailure(s.id);
      return { ...s, web: failed };
    }),
    ...others,
  ]
    .filter((s) => !meta[s.id]?.deleted)
    .map((s) => withMeta(s, meta[s.id]))
    .sort((a, b) => b.mtime - a.mtime);
}
