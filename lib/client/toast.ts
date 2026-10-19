"use client";

import { useSyncExternalStore } from "react";
import { addToast, expiredToasts, markLeaving, nextDeadline, pauseToasts, removeToasts, resumeToasts, type Toast, type ToastInput } from "./toast-queue";

/* App-wide toasts: call toast() from anywhere, <Toaster /> shows them. Clocks run only while the window is in front
 * and the pointer isn't over the stack, so nothing disappears unread. */

export type { Toast, ToastInput, ToastTone } from "./toast-queue";

const LEAVE_MS = 180;

let list: Toast[] = [];
let nextId = 1;
let hovering = false;
let away = false;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

const running = () => !hovering && !away;

function set(next: Toast[]) {
  list = next;
  /* the last toast closed under the pointer never sends a leave */
  if (!next.length) hovering = false;
  schedule();
  for (const l of listeners) l();
}

function schedule() {
  clearTimeout(timer);
  const at = nextDeadline(list, Date.now());
  if (at === null) return;
  timer = setTimeout(() => {
    const ids = expiredToasts(list, Date.now());
    if (ids.length) dismissToast(...ids);
    else schedule();
  }, Math.max(0, at - Date.now()) + 5);
}

/** Shows a toast and returns its id. */
export function toast(input: ToastInput): number {
  const id = nextId++;
  set(addToast(list, input, id, Date.now(), running()));
  return id;
}

export function dismissToast(...ids: number[]) {
  if (!ids.some((id) => list.some((t) => t.id === id && !t.leaving))) return;
  set(markLeaving(list, ids));
  setTimeout(() => set(removeToasts(list, ids)), LEAVE_MS);
}

function sync() {
  set(running() ? resumeToasts(list, Date.now()) : pauseToasts(list, Date.now()));
}

/** The pointer is over the stack (or focus is inside it): clocks stop. */
export function holdToasts(on: boolean) {
  if (hovering === on) return;
  hovering = on;
  sync();
}

/** The window went to the background or came back. */
export function setToastsAway(on: boolean) {
  if (away === on) return;
  away = on;
  sync();
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
const empty: Toast[] = [];

export const peekToasts = () => list;

export const useToasts = () => useSyncExternalStore(subscribe, () => list, () => empty);

/** test hook */
export function resetToasts() {
  clearTimeout(timer);
  list = [];
  hovering = false;
  away = false;
}
