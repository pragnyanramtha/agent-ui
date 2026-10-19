"use client";

import { useEffect, useRef, useState } from "react";
import { step, type NotifyMessage, type Seen } from "@/lib/notify-events";
import { alertFor, attentionCount, nextFailedSeen, type FailedSeen, type NotifyPrefs } from "@/lib/notify-prefs";
import type { SessionSummary } from "@/lib/types";
import { flashAttention, setAttention, setBadgeStyle } from "./attention";
import { pushStatus, testPush } from "./push";
import { getSettings, useSettings } from "./settings";
import { armSounds, playTone } from "./sounds";
import { dismissToast, peekToasts, setToastsAway, toast, type ToastTone } from "./toast";
import { onSessionsPoll } from "./useSessions";

/* Finished turns, approvals and failures in sessions you aren't looking at: a toast, a tone and the tab badge, as
 * Settings > Notifications says. Push comes from the server (lib/server/notify.ts) on the same events. */

/** The window is in front: visible and focused. */
export function useLooking() {
  const [looking, setLooking] = useState(true);
  useEffect(() => {
    const on = () => setLooking(document.visibilityState === "visible" && document.hasFocus());
    on();
    document.addEventListener("visibilitychange", on);
    window.addEventListener("focus", on);
    window.addEventListener("blur", on);
    return () => {
      document.removeEventListener("visibilitychange", on);
      window.removeEventListener("focus", on);
      window.removeEventListener("blur", on);
    };
  }, []);
  return looking;
}

const TONE: Record<NotifyMessage["kind"], ToastTone> = { done: "success", needs: "warning", failed: "error", test: "info" };
const FAILED_KEY = "cui:failed-seen";
const SOUND_CLAIM = "cui:notify-sound";
const CLAIM_MS = 20_000;

/** Every open agent-u tab sees the same event; only the first to claim it plays the tone. */
function claimSound(tag: string, now: number): boolean {
  try {
    const prev = JSON.parse(localStorage.getItem(SOUND_CLAIM) ?? "null") as { tag?: string; at?: number } | null;
    if (prev?.tag === tag && typeof prev.at === "number" && now - prev.at < CLAIM_MS) return false;
    localStorage.setItem(SOUND_CLAIM, JSON.stringify({ tag, at: now }));
  } catch {}
  return true;
}

function readFailedSeen(): FailedSeen {
  try {
    const raw = JSON.parse(localStorage.getItem(FAILED_KEY) ?? "{}") as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}

export function useNotifications(o: { sessions: SessionSummary[] | null; activeId: string | null; looking: boolean; finished: Record<string, number>; onOpen: (id: string) => void }) {
  const { sessions, activeId, looking, finished } = o;
  const settings = useSettings();
  const latest = useRef(o);
  latest.current = o;

  useEffect(() => armSounds(), []);
  useEffect(() => setToastsAway(!looking), [looking]);
  useEffect(() => setBadgeStyle(settings.notifyBadge), [settings.notifyBadge]);

  /* events: the same rules as push, run on every poll so a turn that settles is noticed without a change in the list */
  useEffect(() => {
    const seen = new Map<string, Seen>();
    return onSessionsPoll((rows) => {
      const now = Date.now();
      const cur = latest.current;
      const prefs: NotifyPrefs = getSettings();
      for (const m of step(seen, rows, now)) {
        if (m.kind === "test") continue;
        const a = alertFor(m.kind, prefs, { onScreen: m.session === cur.activeId && cur.looking, away: !cur.looking });
        if (a.toast) {
          const id = m.session;
          toast({ key: m.tag, tone: TONE[m.kind], title: m.title, body: m.body, action: id ? { label: "Open", run: () => latest.current.onOpen(id) } : undefined });
        }
        if (a.sound && claimSound(m.tag, now)) playTone(m.kind, prefs.notifyVolume);
      }
    });
  }, []);

  /* the tab badge: what needs you, minus the session on screen */
  const [failedSeen, setFailedSeen] = useState<FailedSeen>({});
  useEffect(() => setFailedSeen(readFailedSeen()), []);
  const onScreen = looking ? activeId : null;
  /* a session's toasts are old news once you're looking at it */
  useEffect(() => {
    if (!onScreen) return;
    const ids = peekToasts()
      .filter((t) => t.key === `done:${onScreen}` || t.key === `act:${onScreen}`)
      .map((t) => t.id);
    if (ids.length) dismissToast(...ids);
  }, [onScreen]);
  useEffect(() => {
    if (!sessions) return;
    setFailedSeen((prev) => {
      const next = nextFailedSeen(prev, sessions, onScreen);
      if (next !== prev)
        try {
          localStorage.setItem(FAILED_KEY, JSON.stringify(next));
        } catch {}
      return next;
    });
  }, [sessions, onScreen]);
  useEffect(() => {
    if (sessions) setAttention(attentionCount(sessions, { finished, failedSeen, onScreen, prefs: settings }));
  }, [sessions, finished, failedSeen, onScreen, settings]);
}

/** Settings > Notifications: tries every alert that's on for this device, and push if this browser gets it. */
export async function sendTestNotification() {
  const p = getSettings();
  const parts: string[] = [];
  if (p.notifySound) {
    playTone("done", p.notifyVolume);
    parts.push("sound");
  }
  if (p.notifyBadge !== "off") {
    flashAttention();
    parts.push("tab badge");
  }
  const push = await pushStatus().catch(() => "unsupported" as const);
  toast({
    key: "test",
    tone: "success",
    title: "Test notification",
    body: parts.length ? `This is an in-app alert. Also tried: ${parts.join(", ")}.` : "This is an in-app alert.",
  });
  if (push !== "on") return;
  try {
    await testPush();
    toast({ key: "test-push", tone: "success", title: "Push sent", body: "It should show up on this device in a moment." });
  } catch (err) {
    toast({ key: "test-push", tone: "error", title: "Push didn't go through", body: err instanceof Error ? err.message : String(err) });
  }
}
