import { getRun } from "./runner";
import { listSessions, type ListingSeen } from "./sessions";
import { newestFirst } from "./order";
import { agentSummaries } from "./agents/bridge";
import { allSessionMeta, type SessionMeta } from "./profiles";
import type { SessionSummary } from "@/lib/types";

/** A row with what the user set on it: their own title, pinned, archived. */
export function withMeta(s: SessionSummary, m: SessionMeta | undefined): SessionSummary {
  if (!m) return s;
  return { ...s, ...(m.title ? { title: m.title } : {}), ...(m.pinned ? { pinned: true } : {}), ...(m.archived ? { archived: true } : {}) };
}

/** Every session the list shows, Claude and the other agents, newest first. Archived ones included. */
export async function sessionRows(limit?: number, seen?: ListingSeen): Promise<SessionSummary[]> {
  const [sessions, others] = await Promise.all([listSessions(limit, seen), agentSummaries().catch(() => [])]);
  const meta = allSessionMeta();
  return [
    ...sessions.map((s) => {
      const run = getRun(s.id);
      return run ? { ...s, terminal: null, web: run.state } : { ...s, web: null };
    }),
    ...others,
  ]
    .map((s) => withMeta(s, meta[s.id]))
    .sort(newestFirst);
}
