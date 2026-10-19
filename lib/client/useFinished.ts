"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { terminalBusy } from "@/lib/status";
import type { SessionSummary } from "@/lib/types";
import { load, save } from "./storage";

/* Sessions that finished a turn while you weren't looking at them, until you open them (or dismiss them).
 * Kept per device, so every tab agrees on what's unread. */

const KEY = "inbox:finished";
const MAX = 40;

export type Finished = Record<string, number>;

const busyOf = (s: SessionSummary) => (s.web ? s.web.status === "running" || s.web.status === "starting" : terminalBusy(s.terminal?.status));

const cap = (f: Finished): Finished => (Object.keys(f).length > MAX ? Object.fromEntries(Object.entries(f).sort((a, b) => b[1] - a[1]).slice(0, MAX)) : f);

/** Turns that ended since the last poll, outside the session on screen. The open session is never added here;
 * opening one clears it (`markRead`), so a session marked unread while open stays unread until it's opened again. */
export function nextFinished(prev: Finished, wasBusy: Map<string, boolean>, sessions: SessionSummary[], activeId: string | null, now: number): Finished {
  let next = prev;
  const put = (id: string, v: number | null) => {
    if (next === prev) next = { ...prev };
    if (v === null) delete next[id];
    else next[id] = v;
  };
  for (const s of sessions) {
    const busy = busyOf(s);
    const before = wasBusy.get(s.id);
    wasBusy.set(s.id, busy);
    if (s.id === activeId) continue;
    if (before === true && !busy && !s.web?.pending.length) put(s.id, now);
    else if (busy && next[s.id]) put(s.id, null);
  }
  return next === prev ? prev : cap(next);
}

export function markRead(prev: Finished, id: string | null): Finished {
  if (!id) return Object.keys(prev).length ? {} : prev;
  if (!(id in prev)) return prev;
  const next = { ...prev };
  delete next[id];
  return next;
}

export function markUnread(prev: Finished, id: string, at: number): Finished {
  return prev[id] ? prev : cap({ ...prev, [id]: at });
}

export function parseFinished(raw: string | null): Finished {
  try {
    const j = JSON.parse(raw ?? "{}") as unknown;
    if (!j || typeof j !== "object" || Array.isArray(j)) return {};
    return Object.fromEntries(Object.entries(j).filter((e): e is [string, number] => typeof e[1] === "number" && e[1] > 0));
  } catch {
    return {};
  }
}

function read(): Finished {
  try {
    const own = localStorage.getItem(KEY);
    if (own !== null) return parseFinished(own);
    /* older builds kept it per tab */
    const old = parseFinished(load(KEY));
    save(KEY, null);
    write(old);
    return old;
  } catch {
    return parseFinished(load(KEY));
  }
}

function write(f: Finished) {
  try {
    localStorage.setItem(KEY, JSON.stringify(f));
  } catch {
    /* over quota or storage disabled: the value just isn't kept */
  }
}

export function useFinished(sessions: SessionSummary[] | null, activeId: string | null) {
  const [finished, setFinished] = useState<Finished>({});
  const wasBusy = useRef(new Map<string, boolean>());
  const update = useCallback((fn: (prev: Finished) => Finished) => {
    setFinished((prev) => {
      const next = fn(prev);
      if (next !== prev) write(next);
      return next;
    });
  }, []);
  useEffect(() => {
    setFinished(read());
    const onStorage = (e: StorageEvent) => e.key === KEY && setFinished(parseFinished(e.newValue));
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  useEffect(() => {
    if (activeId) update((prev) => markRead(prev, activeId));
  }, [activeId, update]);
  useEffect(() => {
    if (!sessions) return;
    update((prev) => nextFinished(prev, wasBusy.current, sessions, activeId, Date.now()));
  }, [sessions, activeId, update]);
  const dismiss = useCallback((id: string | null) => update((prev) => markRead(prev, id)), [update]);
  const unread = useCallback((id: string, at: number) => update((prev) => markUnread(prev, id, at)), [update]);
  return { finished, dismiss, unread };
}
