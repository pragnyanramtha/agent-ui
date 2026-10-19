import { terminalBusy } from "@/lib/status";
import type { SessionSummary } from "@/lib/types";

/* What a sidebar row says about a session, most urgent first:
 * an approval > a question > working > a failed turn > a finished turn you haven't seen. */

export type SessionStatus = "approval" | "input" | "working" | "failed" | "unread";

export const STATUS_LABEL: Record<SessionStatus, string> = {
  approval: "Needs approval",
  input: "Needs input",
  working: "Working",
  failed: "Failed",
  unread: "Finished",
};

type Row = Pick<SessionSummary, "terminal" | "web">;

export function sessionStatus(s: Row, unread: boolean): SessionStatus | null {
  const pending = s.web?.pending ?? [];
  if (pending.some((p) => p.kind === "permission")) return "approval";
  if (pending.length) return "input";
  if (s.web ? s.web.status === "running" || s.web.status === "starting" : terminalBusy(s.terminal?.status)) return "working";
  if (s.web?.status === "error") return "failed";
  return unread ? "unread" : null;
}
