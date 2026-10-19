import { forgetSeen, step, type Seen } from "@/lib/notify-events";
import { pushWanted } from "@/lib/notify-prefs";
import { DEFAULTS } from "@/lib/settings-schema";
import type { SessionSummary } from "@/lib/types";
import { pushAll, subscriptionCount, type PushMessage } from "./push";
import { signRespondToken } from "./push-token";
import { sessionRows } from "./rows";
import { readSynced } from "./settings";

/* Watches every session's state and pushes a notification when one finishes, needs an answer, or fails. Which of
 * those go out, and do not disturb, are synced settings: push reaches every device, so it follows the shared choice. */

export { phaseOf, SETTLE_MS, step, type Phase, type Seen } from "@/lib/notify-events";

/** The messages the synced settings let through. */
export function wanted(messages: PushMessage[], settings = readSynced().settings): PushMessage[] {
  if (!messages.length) return messages;
  const prefs = { ...DEFAULTS, ...settings };
  return messages.filter((m) => pushWanted(m.kind, prefs));
}

/** "Needs you" for a tool approval gets Allow and Deny: a token for that one request. Questions only open the session. */
export function withActions(messages: PushMessage[], rows: SessionSummary[], sign = signRespondToken): PushMessage[] {
  return messages.map((m) => {
    if (m.kind !== "needs" || !m.session) return m;
    const ask = rows.find((r) => r.id === m.session)?.web?.pending[0];
    if (ask?.kind !== "permission") return m;
    try {
      return { ...m, respond: { token: sign(m.session, ask.requestId) } };
    } catch {
      return m;
    }
  });
}

const POLL_MS = 3000;
const g = globalThis as { __agentuNotify?: boolean };

/** Starts the watcher once per server process. It only reads sessions while some browser is subscribed. */
export function startNotify() {
  if (g.__agentuNotify) return;
  g.__agentuNotify = true;
  const seen = new Map<string, Seen>();
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      if (!subscriptionCount()) {
        forgetSeen(seen);
        return;
      }
      const rows = await sessionRows();
      /* the state moves on either way, so turning an event back on doesn't replay old ones */
      for (const m of withActions(wanted(step(seen, rows, Date.now())), rows)) await pushAll(m);
    } catch (err) {
      console.warn(`notify: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };
  setInterval(() => void tick(), POLL_MS).unref();
}
