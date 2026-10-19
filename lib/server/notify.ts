import { runFailed, terminalBusy } from "@/lib/status";
import { AGENT_LABEL, type SessionSummary } from "@/lib/types";
import { pushAll, subscriptionCount, type PushMessage } from "./push";
import { sessionRows } from "./rows";

/* Watches every session's state and pushes a notification when one finishes, needs an answer, or fails. */

export type Phase = "busy" | "needs" | "failed" | "idle";
export type Seen = { phase: Phase; idleSince?: number; doneSent?: boolean };

/** how long a session has to stay idle before it counts as done (a queued message starts the next turn sooner) */
export const SETTLE_MS = 4000;

export function phaseOf(s: Pick<SessionSummary, "terminal" | "web">): Phase {
  if (s.web?.pending.length) return "needs";
  if (runFailed(s.web)) return "failed";
  const busy = s.web ? s.web.status === "running" || s.web.status === "starting" : terminalBusy(s.terminal?.status);
  return busy ? "busy" : "idle";
}

const clip = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function detail(s: SessionSummary): string {
  const ask = s.web?.pending[0];
  if (!ask) return "";
  if (ask.kind === "question") return ask.questions[0]?.question ?? "";
  return ask.title || ask.toolName;
}

/** One poll: the notifications this change of state calls for, and the state to remember. A session seen for the
 * first time only seeds its state. */
export function step(seen: Map<string, Seen>, rows: SessionSummary[], now: number): PushMessage[] {
  const out: PushMessage[] = [];
  const live = new Set<string>();
  for (const s of rows) {
    live.add(s.id);
    const phase = phaseOf(s);
    const prev = seen.get(s.id);
    if (!prev) {
      seen.set(s.id, { phase, idleSince: phase === "idle" ? now : undefined, doneSent: true });
      continue;
    }
    const agent = AGENT_LABEL[s.agent] ?? "Agent";
    const title = s.title || s.project || "Session";
    const msg = (kind: PushMessage["kind"], head: string, body: string): PushMessage => ({
      kind,
      title: head,
      body: clip(body ? `${title}: ${body}` : title),
      tag: `${kind === "done" ? "done" : "act"}:${s.id}`,
      url: `/?s=${encodeURIComponent(s.id)}`,
    });
    const next: Seen = { phase, idleSince: prev.idleSince, doneSent: prev.doneSent };
    if (phase === "needs" && prev.phase !== "needs") out.push(msg("needs", `${agent} needs you`, detail(s)));
    if (phase === "failed" && prev.phase !== "failed") out.push(msg("failed", `${agent} failed`, s.web?.error ?? ""));
    if (phase === "busy") {
      next.idleSince = undefined;
      next.doneSent = false;
    } else if (phase === "idle") {
      if (prev.phase !== "idle") next.idleSince = now;
      if (!next.doneSent && next.idleSince !== undefined && now - next.idleSince >= SETTLE_MS) {
        out.push(msg("done", `${agent} finished`, ""));
        next.doneSent = true;
      }
    } else {
      /* an answer or a failure ends the turn's "done" */
      next.doneSent = true;
    }
    seen.set(s.id, next);
  }
  for (const id of seen.keys()) if (!live.has(id)) seen.delete(id);
  return out;
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
        seen.clear();
        return;
      }
      const rows = await sessionRows();
      for (const m of step(seen, rows, Date.now())) await pushAll(m);
    } catch (err) {
      console.warn(`notify: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };
  setInterval(() => void tick(), POLL_MS).unref();
}
