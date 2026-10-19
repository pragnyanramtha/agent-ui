import { phaseOf, type NotifyKind } from "@/lib/notify-events";
import type { Settings } from "@/lib/settings-schema";
import type { SessionSummary } from "@/lib/types";

/* Which notification goes where. The event choices and do not disturb are synced settings, so push (which reaches
 * every device) follows them on the server; toasts, sounds and the tab badge are this device's own. */

type EventPrefs = Pick<Settings, "notifyDone" | "notifyNeeds" | "notifyFailed" | "notifyDnd">;
export type NotifyPrefs = EventPrefs & Pick<Settings, "notifyToasts" | "notifySound" | "notifyVolume" | "notifyBadge" | "notifyWhen">;

export function eventOn(kind: NotifyKind, p: Pick<EventPrefs, "notifyDone" | "notifyNeeds" | "notifyFailed">): boolean {
  return kind === "done" ? p.notifyDone : kind === "needs" ? p.notifyNeeds : p.notifyFailed;
}

/** Whether the server pushes this event. Test pushes always go out. */
export function pushWanted(kind: NotifyKind | "test", p: EventPrefs): boolean {
  if (kind === "test") return true;
  return !p.notifyDnd && eventOn(kind, p);
}

export type Alert = { toast: boolean; sound: boolean };

/**
 * What this device does for an event. `onScreen`: the session is the one open here and the window is in front.
 * `away`: the window is hidden or another app has focus. The session on screen never alerts; "away" only alerts
 * while the window is in the background.
 */
export function alertFor(kind: NotifyKind, p: NotifyPrefs, where: { onScreen: boolean; away: boolean }): Alert {
  const off = { toast: false, sound: false };
  if (p.notifyDnd || !eventOn(kind, p) || where.onScreen) return off;
  if (p.notifyWhen === "away" && !where.away) return off;
  return { toast: p.notifyToasts, sound: p.notifySound && p.notifyVolume > 0 };
}

/** failed turns already looked at, by session id: the error that was showing */
export type FailedSeen = Record<string, string>;

/**
 * How many sessions need you, for the tab title and badge: open approvals, unread finished turns and failures you
 * haven't looked at, for the events that are turned on. The session on screen doesn't count.
 */
export function attentionCount(
  sessions: readonly SessionSummary[],
  o: { finished: Record<string, number>; failedSeen: FailedSeen; onScreen: string | null; prefs: Pick<EventPrefs, "notifyDone" | "notifyNeeds" | "notifyFailed"> },
): number {
  let n = 0;
  for (const s of sessions) {
    if (s.id === o.onScreen) continue;
    const phase = phaseOf(s);
    if (phase === "needs") n += o.prefs.notifyNeeds ? 1 : 0;
    else if (phase === "failed") n += o.prefs.notifyFailed && o.failedSeen[s.id] !== failureKey(s) ? 1 : 0;
    else if (o.finished[s.id]) n += o.prefs.notifyDone ? 1 : 0;
  }
  return n;
}

export const failureKey = (s: Pick<SessionSummary, "web">) => s.web?.error ?? "failed";

/** Marks the failure on screen as seen, and forgets sessions that aren't failed any more. Same object when nothing changed. */
export function nextFailedSeen(prev: FailedSeen, sessions: readonly SessionSummary[], onScreen: string | null): FailedSeen {
  let next = prev;
  const edit = () => (next === prev ? (next = { ...prev }) : next);
  const failed = new Map(sessions.filter((s) => phaseOf(s) === "failed").map((s) => [s.id, s]));
  for (const id of Object.keys(prev)) if (!failed.has(id)) delete edit()[id];
  const s = onScreen ? failed.get(onScreen) : undefined;
  if (s && next[s.id] !== failureKey(s)) edit()[s.id] = failureKey(s);
  return next;
}
