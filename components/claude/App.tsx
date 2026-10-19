"use client";

import { AskHost } from "./Ask";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSessions } from "@/lib/client/useSessions";
import { CommandPalette, OPEN_TERMINAL_EVENT, TOGGLE_SIDEBAR_EVENT } from "./CommandPalette";
import { type TerminalTarget } from "./WebTerminal";
import { TerminalDrawer } from "./TerminalDrawer";
import { NewSession } from "./NewSession";
import { SessionList, SessionRail } from "./SessionList";
import { SessionScreen } from "./SessionScreen";
import { describeTab, TabBar, TabSheet, TabsButton } from "./TabBar";
import { AGENTS_TAB, FILES_TAB, INBOX_TAB, NEW_TAB, SETTINGS_TAB, useTabs, VIEW_TABS } from "./useTabs";
import { SettingsScreen } from "./SettingsScreen";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { applyTheme, useSetting } from "@/lib/client/settings";
import { InboxScreen, inboxCount } from "./InboxScreen";
import { useFinished } from "@/lib/client/useFinished";
import { AgentsScreen } from "./AgentsScreen";
import { FilesScreen, OPEN_FILES_EVENT } from "./FilesScreen";
import { OfflineBanner } from "./OfflineBanner";
import { useKeyboardInset } from "@/lib/client/useKeyboardInset";
import { setAttention, setBaseTitle } from "@/lib/client/attention";
import { Toaster } from "./Toaster";
import { registerWorker, resyncPush } from "@/lib/client/push";
import { shortPath } from "@/lib/client/api";
import { hasMod, isMac } from "@/lib/client/shortcuts";
import type { SessionSummary } from "@/lib/types";

const isEditable = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === "TEXTAREA" || (t.tagName === "INPUT" && !["checkbox", "radio", "button"].includes((t as HTMLInputElement).type)));

const SIDEBAR_KEY = "cui:sidebar";
function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return matches;
}

/** Desktop sidebar fold state, persisted. `anim` turns on after the stored state lands so reloads don't animate. */
function useSidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const [anim, setAnim] = useState(false);
  useLayoutEffect(() => {
    try {
      setCollapsed(localStorage.getItem(SIDEBAR_KEY) === "collapsed");
    } catch {}
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setAnim(true)));
    return () => cancelAnimationFrame(id);
  }, []);
  const toggle = useCallback(() => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(SIDEBAR_KEY, c ? "open" : "collapsed");
      } catch {}
      return !c;
    });
  }, []);
  return { collapsed, anim, toggle };
}

export function App() {
  const { ready, active, tabs: openTabs, open, newTab: openNewTab, close, reopen, replace, move, cycle, select, syncTitles } = useTabs();
  const [drawer, setDrawer] = useState(false);
  const sidebar = useSidebar();
  const [sheet, setSheet] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const { sessions, projects, error, refresh } = useSessions();
  useKeyboardInset();
  const [terminal, setTerminal] = useState<TerminalTarget | null>(null);
  const [termKey, setTermKey] = useState(0);
  const [termHidden, setTermHidden] = useState(false);
  const [dockPref, setDock] = useSetting("terminalDocked");
  const [theme] = useSetting("theme");
  /* "System" follows the OS while the app is open */
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => applyTheme("system");
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [theme]);
  const desktop = useMediaQuery("(min-width: 1024px)");
  const docked = desktop && dockPref;
  useEffect(() => {
    const open = (e: Event) => {
      setTerminal((e as CustomEvent<TerminalTarget>).detail);
      setTermKey((k) => k + 1);
      setTermHidden(false);
    };
    window.addEventListener(OPEN_TERMINAL_EVENT, open);
    return () => window.removeEventListener(OPEN_TERMINAL_EVENT, open);
  }, []);

  const byId = useMemo(() => new Map((sessions ?? []).map((s) => [s.id, s])), [sessions]);
  useEffect(() => {
    if (sessions) syncTitles((id) => byId.get(id)?.title);
  }, [sessions, byId, syncTitles]);
  const infos = useMemo(() => openTabs.map((t) => describeTab(t, byId.get(t.id), sessions !== null)), [openTabs, byId, sessions]);
  const sessionId = active && active !== NEW_TAB && !VIEW_TABS[active] ? active : null;
  const { finished, dismiss, unread } = useFinished(sessions, sessionId);
  const setUnread = useCallback((s: SessionSummary, on: boolean) => (on ? unread(s.id, s.mtime || Date.now()) : dismiss(s.id)), [unread, dismiss]);
  const inbox = inboxCount(sessions, finished);

  useEffect(() => {
    if (active === NEW_TAB) setBaseTitle("New session · agent-u");
    else if (active && VIEW_TABS[active]) setBaseTitle(`${VIEW_TABS[active]} · agent-u`);
  }, [active]);
  useEffect(() => {
    if (sessions) setAttention(sessions.filter((s) => s.web?.pending.length).length);
  }, [sessions]);

  /* "Browse files here" from a session: the Files tab, at that folder */
  const [filesStart, setFilesStart] = useState<{ path: string | null; n: number }>({ path: null, n: 0 });
  useEffect(() => {
    const on = (e: Event) => {
      const detail = (e as CustomEvent<{ path?: string; hideTerminal?: boolean }>).detail;
      setFilesStart((f) => ({ path: detail?.path ?? null, n: f.n + 1 }));
      if (detail?.hideTerminal) setTermHidden(true);
      open(FILES_TAB);
    };
    window.addEventListener(OPEN_FILES_EVENT, on);
    return () => window.removeEventListener(OPEN_FILES_EVENT, on);
  }, [open]);

  const openSession = useCallback(
    (id: string) => {
      open(id);
      setDrawer(false);
      setSheet(false);
      void refresh();
    },
    [open, refresh],
  );
  /* the service worker: a tapped notification opens its session, a push means the list just changed */
  useEffect(() => {
    registerWorker();
    void resyncPush().catch(() => undefined);
    if (!("serviceWorker" in navigator)) return;
    const on = (e: MessageEvent) => {
      const d = e.data as { type?: string; url?: string } | null;
      if (d?.type === "push") void refresh();
      if (d?.type !== "open" || !d.url) return;
      const id = new URL(d.url, location.href).searchParams.get("s");
      if (id) openSession(id);
    };
    navigator.serviceWorker.addEventListener("message", on);
    return () => navigator.serviceWorker.removeEventListener("message", on);
  }, [openSession, refresh]);
  const newTab = useCallback(() => {
    openNewTab();
    setDrawer(false);
    setSheet(false);
  }, [openNewTab]);
  const openView = useCallback(
    (tab: string) => {
      open(tab);
      setDrawer(false);
      setSheet(false);
    },
    [open],
  );

  /* Tab shortcuts. Ctrl+Tab when the browser lets it through; Alt+arrows, Alt+1..9,
   * Alt+T (Alt+Shift+T reopens) and Alt+W otherwise, so the browser's own Ctrl+T/W keep working.
   * On a Mac, Option+arrows in a text field stay word jumps. */
  useEffect(() => {
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || drawer || sheet) return;
      if (e.ctrlKey && !e.altKey && !e.metaKey && e.key === "Tab") {
        e.preventDefault();
        cycle(e.shiftKey ? -1 : 1);
        return;
      }
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && !e.shiftKey) {
        if (mac && isEditable(e.target)) return;
        e.preventDefault();
        cycle(e.key === "ArrowRight" ? 1 : -1);
      } else if (e.code === "KeyT") {
        e.preventDefault();
        if (e.shiftKey) reopen();
        else newTab();
      } else if (e.code === "KeyW" && !e.shiftKey) {
        e.preventDefault();
        if (active) close(active);
      } else if (/^Digit[1-9]$/.test(e.code) && !e.shiftKey) {
        e.preventDefault();
        const n = Number(e.code.slice(5));
        select(n === 9 ? -1 : n - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cycle, reopen, close, select, active, newTab, drawer, sheet]);

  /* Mod+J or Ctrl+`: open a shell in the current session's folder, or show/hide the terminal. Ctrl+Shift+` adds a terminal tab.
   * Capture phase, so a focused terminal can't swallow Ctrl+`. Ctrl+J inside a terminal is a line feed
   * (newline in Claude Code, accept-line in bash), so off a Mac it's left to the terminal. */
  const activeCwd = sessionId ? byId.get(sessionId)?.cwd || undefined : undefined;
  useEffect(() => {
    const mac = isMac();
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.isComposing) return;
      if (e.shiftKey) {
        if (e.code !== "Backquote" || !(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        e.stopPropagation();
        setTermHidden(false);
        window.dispatchEvent(new CustomEvent(OPEN_TERMINAL_EVENT, { detail: { cwd: activeCwd, label: activeCwd ? `Shell: ${shortPath(activeCwd)}` : "Shell", newTab: true } }));
        return;
      }
      const inTerm = e.target instanceof Element && Boolean(e.target.closest(".xterm"));
      const backquote = e.code === "Backquote" && e.ctrlKey && !e.metaKey;
      const modJ = e.code === "KeyJ" && hasMod(e, mac) && (mac || !inTerm);
      if (!backquote && !modJ) return;
      e.preventDefault();
      e.stopPropagation();
      if (!terminal) {
        window.dispatchEvent(new CustomEvent(OPEN_TERMINAL_EVENT, { detail: { cwd: activeCwd, label: activeCwd ? `Shell: ${shortPath(activeCwd)}` : "Shell" } }));
      } else setTermHidden((h) => !h);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [terminal, activeCwd]);

  /* Ctrl/Cmd+, opens Settings */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key !== ",") return;
      e.preventDefault();
      openView(SETTINGS_TAB);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openView]);

  /* Ctrl/Cmd+B (or Ctrl+Shift+S) folds the desktop sidebar, or opens the drawer on a phone */
  const toggleSidebar = sidebar.toggle;
  useEffect(() => {
    const flip = () => {
      if (window.matchMedia("(min-width: 1024px)").matches) toggleSidebar();
      else setDrawer((d) => !d);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.altKey) return;
      const mod = e.ctrlKey || e.metaKey;
      if ((mod && !e.shiftKey && e.code === "KeyB") || (e.ctrlKey && e.shiftKey && e.code === "KeyS")) {
        e.preventDefault();
        flip();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(TOGGLE_SIDEBAR_EVENT, flip);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(TOGGLE_SIDEBAR_EVENT, flip);
    };
  }, [toggleSidebar]);

  /* Drawer: focus moves in on open and back to the menu button on close,
   * Escape closes, the page behind can't scroll, and it closes itself if the
   * window grows into the desktop layout. */
  useEffect(() => {
    if (!drawer) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = drawerRef.current;
    const target = panel?.querySelector<HTMLElement>('[aria-current="page"]') ?? panel;
    target?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(false);
    const desktop = window.matchMedia("(min-width: 1024px)");
    const onWide = () => desktop.matches && setDrawer(false);
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    desktop.addEventListener("change", onWide);
    return () => {
      window.removeEventListener("keydown", onKey);
      desktop.removeEventListener("change", onWide);
      root.style.overflow = overflow;
      /* after a pick the old screen is gone, so fall back to the new screen's menu button */
      const back = opener?.isConnected ? opener : document.querySelector<HTMLElement>("[data-drawer-opener]");
      requestAnimationFrame(() => back?.focus({ preventScroll: true }));
    };
  }, [drawer]);

  const dismissSheet = useCallback(() => setSheet(false), []);
  const closeDrawer = useCallback(() => setDrawer(false), []);
  const list = (onCollapse: () => void) => (
    <SessionList sessions={sessions} activeId={sessionId} onPick={openSession} onNew={newTab} onCollapse={onCollapse} error={error} onView={openView} activeView={active} inbox={inbox} finished={finished} onUnread={setUnread} onDeleted={close} />
  );
  const tabsButton = (
    <TabsButton count={infos.length} attention={infos.some((t) => t.needsYou && t.id !== active)} onClick={() => setSheet(true)} />
  );
  const activeIndex = openTabs.findIndex((t) => t.id === active);

  return (
    <main className="flex h-[calc(100dvh-var(--kb,0px))] bg-page text-ink lg:bg-sidebar lg:py-1.5 lg:pr-1.5">
      <a
        href="#session-panel"
        onClick={(e) => {
          e.preventDefault();
          const composer = document.querySelector<HTMLElement>("#session-panel [data-composer] textarea");
          if (composer) return composer.focus();
          /* screens without a composer: land on the main area, focusable only for this visit so clicks inside it don't take focus */
          const panel = document.getElementById("session-panel");
          if (!panel) return;
          panel.tabIndex = -1;
          panel.addEventListener("blur", () => panel.removeAttribute("tabindex"), { once: true });
          panel.focus();
        }}
        className="fixed top-[max(0.5rem,env(safe-area-inset-top))] left-2 z-[60] rounded-full bg-ink px-4 py-2 text-[13px] font-medium text-page shadow-overlay not-focus:sr-only"
      >
        Skip to message
      </a>
      <aside
        className="shell-sidebar relative z-20 hidden shrink-0 bg-sidebar lg:block"
        style={{ width: sidebar.collapsed ? 52 : 260 }}
        data-anim={sidebar.anim || undefined}
        data-collapsed={sidebar.collapsed || undefined}
      >
        <div className="shell-face absolute inset-0 overflow-hidden" data-hidden={sidebar.collapsed || undefined} inert={sidebar.collapsed}>
          <div className="h-full w-[260px]">{list(sidebar.toggle)}</div>
        </div>
        <div className="shell-face absolute inset-y-0 left-0 w-[52px]" data-hidden={!sidebar.collapsed || undefined} inert={!sidebar.collapsed}>
          <SessionRail sessions={sessions} activeId={sessionId} onPick={openSession} onNew={newTab} onExpand={sidebar.toggle} onView={openView} inbox={inbox} />
        </div>
      </aside>

      <div
        className={`fixed inset-0 z-40 lg:hidden ${drawer ? "" : "pointer-events-none"}`}
        aria-hidden={!drawer}
        role="dialog"
        aria-modal="true"
        aria-label="Sessions"
      >
        <div
          className="absolute inset-0 touch-none bg-black/50 transition-opacity duration-300"
          style={{ opacity: drawer ? 1 : 0, transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)" }}
          onClick={() => setDrawer(false)}
        />
        <div
          ref={drawerRef}
          tabIndex={-1}
          className="safe-top absolute inset-y-0 left-0 flex w-[86%] max-w-[320px] overscroll-contain bg-sidebar pl-[env(safe-area-inset-left)] shadow-overlay outline-none"
          style={{
            transform: drawer ? "translateX(0)" : "translateX(-104%)",
            /* visible at once on open (so focus can land), hidden only after the slide out */
            visibility: drawer ? "visible" : "hidden",
            transition: `transform 300ms cubic-bezier(0.23, 1, 0.32, 1)${drawer ? "" : ", visibility 0s linear 300ms"}`,
          }}
          inert={!drawer}
        >
          {list(closeDrawer)}
        </div>
      </div>

      <TabSheet
        open={sheet}
        tabs={infos}
        active={active}
        onSelect={(id) => {
          open(id);
          setSheet(false);
        }}
        onClose={close}
        onNew={newTab}
        onAllSessions={() => {
          setSheet(false);
          setDrawer(true);
        }}
        onDismiss={dismissSheet}
      />

      {/* the main area: flush with the sidebar; the tab strip only shows once a second tab is open */}
      <div className="shell-main flex min-w-0 flex-1 flex-col overflow-hidden bg-page" inert={drawer || sheet}>
        {ready && infos.length > 1 && (
          <div className="hidden lg:block">
            <TabBar tabs={infos} active={active} onSelect={open} onClose={close} onNew={newTab} onMove={move} />
          </div>
        )}
        <div id="session-panel" role="tabpanel" aria-labelledby={activeIndex >= 0 ? `tab-${activeIndex}` : undefined} className="flex min-h-0 flex-1 flex-col outline-none">
          {!ready ? null : active === FILES_TAB ? (
            <FilesScreen onMenu={() => setDrawer(true)} extra={tabsButton} start={filesStart.path} startKey={filesStart.n} />
          ) : active === INBOX_TAB ? (
            <InboxScreen sessions={sessions} finished={finished} onDismiss={dismiss} onOpen={openSession} onRefresh={() => void refresh()} onMenu={() => setDrawer(true)} extra={tabsButton} />
          ) : active === SETTINGS_TAB ? (
            <SettingsScreen onMenu={() => setDrawer(true)} extra={tabsButton} onAgents={() => openView(AGENTS_TAB)} />
          ) : active === AGENTS_TAB ? (
            <AgentsScreen onMenu={() => setDrawer(true)} extra={tabsButton} onOpenSession={openSession} projects={projects} />
          ) : sessionId ? (
            <SessionScreen
              key={sessionId}
              id={sessionId}
              onMenu={() => setDrawer(true)}
              onNavigate={(next) => replace(sessionId, next)}
              onNew={newTab}
              extra={tabsButton}
            />
          ) : (
            <NewSession projects={projects} sessions={sessions} onMenu={() => setDrawer(true)} onOpen={openSession} extra={tabsButton} />
          )}
        </div>
        {terminal && (
          <TerminalDrawer
            openKey={termKey}
            target={terminal}
            onClose={() => setTerminal(null)}
            docked={docked}
            hidden={termHidden}
            onDock={(next) => {
              setDock(next);
              setTermHidden(false);
            }}
          />
        )}
      </div>

      <OfflineBanner />
      <CommandPalette sessions={sessions} activeId={sessionId} onOpen={openSession} onNew={newTab} onView={openView} />
      <AskHost />
      <ShortcutsDialog />
      <Toaster />
    </main>
  );
}
