/* The toast list as plain data, so the rules are testable without a DOM: newest last, one per key, a few at most,
 * and each one's time left kept across pauses (hover, or the window in the background). */

export type ToastTone = "info" | "success" | "warning" | "error";
export type ToastAction = { label: string; run: () => void };

export type ToastInput = {
  title: string;
  body?: string;
  tone?: ToastTone;
  action?: ToastAction;
  /** a toast with the same key replaces the old one instead of stacking */
  key?: string;
  /** ms on screen while the window is in front; 0 stays until closed */
  duration?: number;
};

export type Toast = Omit<ToastInput, "tone" | "duration"> & {
  id: number;
  tone: ToastTone;
  duration: number;
  /** ms left on its clock */
  remaining: number;
  /** when its clock last started; null while paused */
  since: number | null;
  /** fading out; removed shortly after */
  leaving?: boolean;
};

export const MAX_TOASTS = 4;

const DURATION: Record<ToastTone, number> = { info: 4000, success: 4000, warning: 8000, error: 8000 };
/** an action needs time to reach */
const ACTION_MIN_MS = 6000;

export function durationFor(input: ToastInput): number {
  if (input.duration !== undefined) return Math.max(0, input.duration);
  const base = DURATION[input.tone ?? "info"];
  return input.action ? Math.max(base, ACTION_MIN_MS) : base;
}

/** Adds a toast. One with the same key is replaced (and moves to the front); past the limit the oldest go. */
export function addToast(list: readonly Toast[], input: ToastInput, id: number, now: number, running: boolean): Toast[] {
  const duration = durationFor(input);
  const { tone = "info", duration: _d, ...rest } = input;
  const item: Toast = { ...rest, id, tone, duration, remaining: duration, since: running ? now : null };
  const kept = list.filter((t) => !(input.key && t.key === input.key) && !t.leaving);
  const leaving = list.filter((t) => t.leaving && !(input.key && t.key === input.key));
  return [...leaving, ...kept.slice(Math.max(0, kept.length + 1 - MAX_TOASTS)), item];
}

const left = (t: Toast, now: number) => (t.since === null ? t.remaining : t.remaining - (now - t.since));

/** Stops every clock (keeping the time left). */
export function pauseToasts(list: readonly Toast[], now: number): Toast[] {
  return list.map((t) => (t.since === null ? t : { ...t, remaining: Math.max(0, left(t, now)), since: null }));
}

/** Starts every clock again. */
export function resumeToasts(list: readonly Toast[], now: number): Toast[] {
  return list.map((t) => (t.since !== null ? t : { ...t, since: now }));
}

/** Ids whose time is up. Toasts with no time limit never expire. */
export function expiredToasts(list: readonly Toast[], now: number): number[] {
  return list.filter((t) => !t.leaving && t.duration > 0 && t.since !== null && left(t, now) <= 0).map((t) => t.id);
}

/** When the next toast runs out, or null if no clock is running. */
export function nextDeadline(list: readonly Toast[], now: number): number | null {
  let best: number | null = null;
  for (const t of list) {
    if (t.leaving || t.duration <= 0 || t.since === null) continue;
    const at = now + Math.max(0, left(t, now));
    if (best === null || at < best) best = at;
  }
  return best;
}

export const markLeaving = (list: readonly Toast[], ids: readonly number[]): Toast[] => list.map((t) => (ids.includes(t.id) && !t.leaving ? { ...t, leaving: true } : t));

export const removeToasts = (list: readonly Toast[], ids: readonly number[]): Toast[] => list.filter((t) => !ids.includes(t.id));
