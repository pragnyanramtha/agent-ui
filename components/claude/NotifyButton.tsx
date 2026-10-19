"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, BellOff } from "iconoir-react";
import { disablePush, enablePush, pushStatus, type PushStatus } from "@/lib/client/push";
import { IconButton } from "./SessionList";

const HINT: Partial<Record<PushStatus, string>> = {
  install: "On iPhone and iPad, add agent-u to the Home Screen first.",
  denied: "Notifications are blocked. Allow them in site settings.",
  unsupported: "This browser can't show notifications.",
};

/** Turns push notifications (finished, needs you, failed) on and off for this browser. */
export function NotifyButton() {
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void pushStatus()
      .then(setStatus)
      .catch(() => setStatus("unsupported"));
  }, []);

  const toggle = useCallback(async () => {
    if (busy) return;
    if (status && HINT[status] && status !== "denied") return setNote((n) => (n ? null : HINT[status]!));
    setBusy(true);
    setNote(null);
    try {
      if (status === "on") await disablePush();
      else {
        await enablePush();
        setNote("Notifications on. Test sent.");
      }
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setStatus(await pushStatus().catch(() => "unsupported" as const));
      setBusy(false);
    }
  }, [busy, status]);

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 8000);
    return () => clearTimeout(t);
  }, [note]);

  if (status === null) return null;
  const on = status === "on";
  return (
    <span className="relative">
      <IconButton label={on ? "Turn off notifications" : "Turn on notifications"} tipPos="bottom" pressed={on} onClick={() => void toggle()}>
        {on ? <Bell width={17} height={17} strokeWidth={1.8} aria-hidden /> : <BellOff width={17} height={17} strokeWidth={1.8} aria-hidden />}
      </IconButton>
      {note && (
        <span role="status" className="absolute bottom-full left-1/2 z-20 mb-2 w-60 -translate-x-1/2 rounded-[10px] border border-line bg-surface px-3 py-2 text-sm leading-snug text-ink-2 shadow-overlay">
          {note}
        </span>
      )}
    </span>
  );
}
