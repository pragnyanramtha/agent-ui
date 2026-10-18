"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionSummary } from "@/lib/types";
import { api, ApiError } from "./api";

type Listing = { sessions: SessionSummary[]; projects: string[] };

export type SessionChange = { pinned?: boolean; archived?: boolean; title?: string | null };

/* Edits shown before the server confirms them, shared by every mounted list. */
const overrides = new Map<string, Partial<SessionSummary>>();
const hooks = new Set<{ bump: () => void; refresh: (fresh?: boolean) => Promise<void> }>();
const bumpAll = () => hooks.forEach((h) => h.bump());

/** Pin, archive or rename a session: shows at once, saves, then reloads the list. Throws when the save fails. */
export async function patchSession(id: string, change: SessionChange): Promise<void> {
  const shown: Partial<SessionSummary> = { ...overrides.get(id) };
  if (change.pinned !== undefined) shown.pinned = change.pinned;
  if (change.archived !== undefined) shown.archived = change.archived;
  if (change.archived === true && change.pinned === undefined) shown.pinned = false;
  if (change.pinned === true && change.archived === undefined) shown.archived = false;
  if (change.title) shown.title = change.title;
  overrides.set(id, shown);
  bumpAll();
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(change),
      cache: "no-store",
    });
    if (res.status === 401) {
      window.location.href = "/login";
      throw new ApiError("Signed out", 401);
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status);
    }
    await Promise.all([...hooks].map((h) => h.refresh(true)));
  } finally {
    if (overrides.get(id) === shown) overrides.delete(id);
    bumpAll();
  }
}

/** Session list, refreshed every few seconds while the tab is visible. */
export function useSessions(intervalMs = 5000) {
  const [data, setData] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const inflight = useRef<Promise<void> | null>(null);
  const fails = useRef(0);
  const loaded = useRef(false);
  const last = useRef("");

  const load = useCallback(async () => {
    try {
      const next = await api<Listing>("/api/sessions");
      /* the poll mostly returns what's on screen; same text, same object, no re-render of the list */
      const text = JSON.stringify(next);
      if (text !== last.current) {
        last.current = text;
        setData(next);
      }
      setError(null);
      fails.current = 0;
      loaded.current = true;
    } catch (err) {
      /* a list on screen outlives short drops; the offline banner covers no network at all */
      fails.current += 1;
      if (navigator.onLine && (fails.current >= 3 || !loaded.current)) setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  /** `fresh` waits for a poll already on its way, then loads again, so the answer reflects a change just saved. */
  const refresh = useCallback(
    async (fresh = false) => {
      if (inflight.current) {
        if (!fresh) return;
        await inflight.current;
      }
      const p = load().finally(() => {
        if (inflight.current === p) inflight.current = null;
      });
      inflight.current = p;
      await p;
    },
    [load],
  );

  useEffect(() => {
    const h = { bump: () => setVersion((v) => v + 1), refresh };
    hooks.add(h);
    return () => {
      hooks.delete(h);
    };
  }, [refresh]);

  useEffect(() => {
    const tick = () => void refresh();
    tick();
    let timer = setInterval(tick, intervalMs);
    const onVisibility = () => {
      clearInterval(timer);
      if (document.visibilityState === "visible") {
        tick();
        timer = setInterval(tick, intervalMs);
      }
    };
    const onOnline = () => void refresh();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
    };
  }, [refresh, intervalMs]);

  const sessions = useMemo(() => {
    if (!data) return null;
    if (!overrides.size) return data.sessions;
    return data.sessions.map((s) => {
      const o = overrides.get(s.id);
      return o ? { ...s, ...o } : s;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, version]);

  const refreshNow = useCallback(() => refresh(), [refresh]);
  return { sessions, projects: data?.projects ?? [], error, refresh: refreshNow };
}
