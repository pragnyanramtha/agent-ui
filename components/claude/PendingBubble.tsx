"use client";

import { useEffect, useState } from "react";
import { Check, Clock, WarningTriangle } from "iconoir-react";
import type { Pending } from "@/lib/client/useSession";
import { splitAttachments } from "@/lib/attachments";
import { SentFiles } from "./Attachments";

/* How long a delivered message can go unseen in the transcript before we say so. */
const SLOW_MS = 90_000;

/**
 * A message that isn't in the transcript yet, with where it is in delivery:
 * sending, handed to the terminal/web run (and queued if Claude is mid-turn),
 * or failed with the reason and a way out.
 */
export function PendingBubble({
  pending,
  claudeBusy,
  queued = false,
  onRetry,
  onDiscard,
  onUnqueue,
  onSendNow,
}: {
  pending: Pending;
  where: string | null;
  agentName?: string;
  claudeBusy: boolean;
  /** held by the server until the agent's running turn ends */
  queued?: boolean;
  onRetry: () => void;
  onDiscard: () => void;
  onUnqueue?: () => void;
  /** stops the running turn so this goes out now */
  onSendNow?: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (pending.state !== "sent") return;
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, [pending.state]);

  const { text: body, paths } = splitAttachments(pending.text);
  const slow = pending.state === "sent" && !queued && pending.via !== "queued" && now - pending.at > SLOW_MS;
  const status =
    pending.state === "sending"
      ? { icon: <Clock width={12} height={12} strokeWidth={2} />, text: "Sending…", tone: "text-ink-3" }
      : pending.state === "failed"
        ? { icon: <WarningTriangle width={12} height={12} strokeWidth={2} />, text: pending.error ?? "Couldn't send.", tone: "text-red-ink" }
        : queued
          ? { icon: <Clock width={12} height={12} strokeWidth={2} />, text: "Queued", tone: "text-ink-3" }
        : slow
          ? { icon: <WarningTriangle width={12} height={12} strokeWidth={2} />, text: "Sent, not in history yet", tone: "text-orange-ink" }
          : claudeBusy && pending.via !== "queued"
            ? { icon: <Clock width={12} height={12} strokeWidth={2} />, text: "Queued", tone: "text-ink-3" }
            : { icon: <Check width={12} height={12} strokeWidth={2.2} />, text: "Delivered", tone: "text-ink-3" };

  return (
    <div className="flex flex-col items-end gap-1" style={{ animation: "fade-up 260ms cubic-bezier(0.23,1,0.32,1) both" }}>
      <SentFiles paths={paths} />
      <div
        className={`max-w-[80%] min-w-0 rounded-2xl border border-dashed px-3.5 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-ink [overflow-wrap:anywhere] sm:px-4 sm:py-3 sm:text-[14px] ${
          pending.state === "failed" ? "border-red/40 bg-red-tint" : "border-line-strong bg-field/60"
        }`}
        aria-busy={pending.state === "sending" || undefined}
      >
        {body}
      </div>
      <div role="status" className={`flex max-w-full items-center gap-1.5 text-[11.5px] ${status.tone}`}>
        <span className="shrink-0">{status.icon}</span>
        <span className="min-w-0">{status.text}</span>
        {queued && (
          <span className="ml-1 flex shrink-0 items-center gap-1">
            {onSendNow && (
              <button type="button" onClick={onSendNow} title="Stop turn and send" className="tap relative rounded-full px-2 py-0.5 font-medium text-ink hover:bg-hover">
                Send now
              </button>
            )}
            {onUnqueue && (
              <button type="button" onClick={onUnqueue} className="tap relative rounded-full px-2 py-0.5 font-medium text-ink-2 hover:bg-hover">
                Remove
              </button>
            )}
          </span>
        )}
        {(pending.state === "failed" || slow) && (
          <span className="ml-1 flex shrink-0 items-center gap-1">
            {/* a long-unseen message with nothing running was most likely lost (e.g. the server restarted) */}
            {(pending.state === "failed" || !claudeBusy) && (
              <button type="button" onClick={onRetry} className="tap relative rounded-full px-2 py-0.5 font-medium text-ink hover:bg-hover">
                {pending.state === "failed" ? "Retry" : "Send again"}
              </button>
            )}
            <button type="button" onClick={onDiscard} className="tap relative rounded-full px-2 py-0.5 font-medium text-ink-2 hover:bg-hover">
              Discard
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
