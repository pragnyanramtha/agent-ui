"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, BellOff } from "iconoir-react";
import { disablePush, enablePush, pushStatus, type PushStatus } from "@/lib/client/push";
import { toast } from "@/lib/client/toast";
import { IconButton } from "./SessionList";

const HINT: Partial<Record<PushStatus, string>> = {
  install: "On iPhone and iPad, add agent-u to the Home Screen first.",
  denied: "Notifications are blocked. Allow them in site settings.",
  unsupported: "This browser can't show notifications.",
};

/** Push notifications (finished, needs you, failed) for this browser: the status (null while checking) and a toggle. */
export function usePush() {
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void pushStatus()
      .then(setStatus)
      .catch(() => setStatus("unsupported"));
  }, []);

  const toggle = useCallback(async () => {
    if (busy) return;
    if (status && HINT[status] && status !== "denied") return void toast({ key: "push", title: "Notifications aren't available", body: HINT[status] });
    setBusy(true);
    try {
      if (status === "on") {
        await disablePush();
        toast({ key: "push", title: "Notifications off" });
      } else {
        await enablePush();
        toast({ key: "push", tone: "success", title: "Notifications on", body: "Test sent." });
      }
    } catch (err) {
      toast({ key: "push", tone: "error", title: "Couldn't change notifications", body: err instanceof Error ? err.message : String(err) });
    } finally {
      setStatus(await pushStatus().catch(() => "unsupported" as const));
      setBusy(false);
    }
  }, [busy, status]);

  return { status, on: status === "on", busy, toggle };
}

/** Turns push notifications on and off for this browser. */
export function NotifyButton() {
  const { status, on, toggle } = usePush();
  if (status === null) return null;
  return (
    <IconButton label={on ? "Turn off notifications" : "Turn on notifications"} tipPos="bottom" pressed={on} onClick={() => void toggle()}>
      {on ? <Bell width={17} height={17} strokeWidth={1.8} aria-hidden /> : <BellOff width={17} height={17} strokeWidth={1.8} aria-hidden />}
    </IconButton>
  );
}
