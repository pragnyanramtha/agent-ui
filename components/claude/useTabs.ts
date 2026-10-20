"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { pushTab, replaceTab } from "@/lib/client/tab-history";


/** The tab id for the new-session screen. There is at most one. */
export const NEW_TAB = "new";
/** tabs that show a tool instead of a session */
export const FILES_TAB = "@files";
export const AGENTS_TAB = "@agents";
export const INBOX_TAB = "@inbox";
export const SETTINGS_TAB = "@settings";
export const USAGE_TAB = "@usage";
export const VIEW_TABS: Record<string, string> = { [FILES_TAB]: "Files", [AGENTS_TAB]: "Agents", [INBOX_TAB]: "Inbox", [SETTINGS_TAB]: "Settings", [USAGE_TAB]: "Usage" };
/** what a view button or palette entry can open */
export type ViewTab = "@agents" | "@files" | "@inbox" | "@settings" | "@usage";

/** An open tab: a session id (or NEW_TAB) plus the last title we saw, so reloads paint names before the list loads. */
export type Tab = { id: string; title?: string };
type State = { tabs: Tab[]; active: string };
type HistoryMode = "push" | "replace" | "none";

const KEY = "cui:tabs";
const CLOSED_CAP = 20;

const readUrl = () => new URLSearchParams(window.location.search).get("s");

function load(): State | null {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as unknown;
    if (!raw || typeof raw !== "object") return null;
    const { tabs, active } = raw as { tabs?: unknown; active?: unknown };
    if (!Array.isArray(tabs)) return null;
    const seen = new Set<string>();
    const clean: Tab[] = [];
    for (const t of tabs) {
      if (!t || typeof t !== "object" || typeof (t as Tab).id !== "string" || seen.has((t as Tab).id)) continue;
      seen.add((t as Tab).id);
      const title = (t as Tab).title;
      clean.push({ id: (t as Tab).id, title: typeof title === "string" ? title : undefined });
    }
    if (!clean.length) return null;
    return { tabs: clean, active: typeof active === "string" && seen.has(active) ? active : clean[0].id };
  } catch {
    return null;
  }
}

/** Focus `id`, opening it if needed. A session picked while the new-session tab is active takes that tab's place. */
function openIn(s: State, id: string): State {
  if (s.tabs.some((t) => t.id === id)) return { ...s, active: id };
  if (id !== NEW_TAB && s.active === NEW_TAB) {
    return { tabs: s.tabs.map((t) => (t.id === NEW_TAB ? { id } : t)), active: id };
  }
  return { tabs: [...s.tabs, { id }], active: id };
}

/**
 * Open tabs and the active one, persisted in localStorage and mirrored in the
 * URL as `?s=<id>` (absent for the new-session tab) so links and reloads land
 * on the same session. Back/forward walk between previously active tabs.
 */
export function useTabs() {
  const [state, setState] = useState<State | null>(null);
  const mode = useRef<HistoryMode>("replace");
  const closed = useRef<string[]>([]);

  const update = useCallback((how: HistoryMode, fn: (s: State) => State) => {
    mode.current = how;
    setState((s) => (s ? fn(s) : s));
  }, []);

  useEffect(() => {
    const url = readUrl();
    let s = load() ?? { tabs: [{ id: NEW_TAB }], active: NEW_TAB };
    if (url) s = openIn(s, url);
    mode.current = "replace";
    setState(s);
    const onPop = () => update("none", (cur) => openIn(cur, readUrl() ?? NEW_TAB));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [update]);

  const active = state?.active ?? null;
  useEffect(() => {
    if (active === null) return;
    const how = mode.current;
    mode.current = "push";
    const want = active === NEW_TAB ? null : active;
    if (how === "none" || readUrl() === want) return;
    const url = want ? `/?s=${want}` : "/";
    if (how === "replace") replaceTab(url);
    else pushTab(url);
  }, [active]);

  useEffect(() => {
    if (!state) return;
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {}
  }, [state]);

  const open = useCallback((id: string) => update("push", (s) => openIn(s, id)), [update]);
  const newTab = useCallback(() => update("push", (s) => openIn(s, NEW_TAB)), [update]);

  const close = useCallback(
    (id: string) =>
      update("replace", (s) => {
        const i = s.tabs.findIndex((t) => t.id === id);
        if (i < 0) return s;
        if (id !== NEW_TAB) closed.current = [...closed.current.filter((c) => c !== id), id].slice(-CLOSED_CAP);
        const tabs = s.tabs.filter((t) => t.id !== id);
        if (!tabs.length) return { tabs: [{ id: NEW_TAB }], active: NEW_TAB };
        /* like a browser: the tab to the right takes focus, else the one to the left */
        return { tabs, active: s.active === id ? (tabs[i] ?? tabs[i - 1]).id : s.active };
      }),
    [update],
  );

  /** Reopen the most recently closed session tab. */
  const reopen = useCallback(() => {
    const id = closed.current.pop();
    if (id) update("push", (s) => openIn(s, id));
  }, [update]);

  /** A tab's session became another id (a resume forked it, or the new-session tab started one). */
  const replace = useCallback(
    (from: string, to: string, how: HistoryMode = "replace") =>
      update(how, (s) => {
        if (from === to) return s;
        if (s.tabs.some((t) => t.id === to)) return { tabs: s.tabs.filter((t) => t.id !== from), active: to };
        if (!s.tabs.some((t) => t.id === from)) return openIn(s, to);
        return { tabs: s.tabs.map((t) => (t.id === from ? { id: to } : t)), active: s.active === from ? to : s.active };
      }),
    [update],
  );

  const move = useCallback(
    (id: string, to: number) =>
      update("replace", (s) => {
        const from = s.tabs.findIndex((t) => t.id === id);
        if (from < 0 || from === to) return s;
        const tabs = [...s.tabs];
        const [tab] = tabs.splice(from, 1);
        tabs.splice(Math.max(0, Math.min(to, tabs.length)), 0, tab);
        return { ...s, tabs };
      }),
    [update],
  );

  const cycle = useCallback(
    (delta: number) =>
      update("push", (s) => {
        const i = s.tabs.findIndex((t) => t.id === s.active);
        const n = s.tabs.length;
        return { ...s, active: s.tabs[(((i + delta) % n) + n) % n].id };
      }),
    [update],
  );

  /** Jump to the tab at `index`; -1 is the last one. */
  const select = useCallback(
    (index: number) =>
      update("push", (s) => {
        const t = index < 0 ? s.tabs[s.tabs.length - 1] : s.tabs[index];
        return t ? { ...s, active: t.id } : s;
      }),
    [update],
  );

  /** Refresh cached titles from the session list; skips the state update when nothing changed. */
  const syncTitles = useCallback((titleOf: (id: string) => string | undefined) => {
    setState((s) => {
      if (!s) return s;
      let changed = false;
      const tabs = s.tabs.map((t) => {
        const title = t.id === NEW_TAB ? undefined : titleOf(t.id);
        if (!title || title === t.title) return t;
        changed = true;
        return { ...t, title };
      });
      return changed ? { ...s, tabs } : s;
    });
  }, []);

  return { ready: state !== null, tabs: state?.tabs ?? [], active, open, newTab, close, reopen, replace, move, cycle, select, syncTitles };
}
