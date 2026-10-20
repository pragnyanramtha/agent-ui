"use client";

import { AskHost } from "./Ask";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type UIEvent } from "react";
import { useSessions } from "@/lib/client/useSessions";
import { OPEN_TERMINAL_EVENT, TOGGLE_SIDEBAR_EVENT } from "@/lib/client/events";
import type { TerminalTarget } from "./WebTerminal";
import { CommandPalette, NewSession, preloadScreens, preloadTerminalWhenIdle, SessionScreen, TerminalDrawer } from "./lazy-shell";
import { SessionList, SessionRail } from "./SessionList";
import { SidebarResizer } from "./SidebarResizer";
import { useSessionCommands } from "./useSessionCommands";
import { describeTab, TabBar, TabSheet, TabsButton } from "./TabBar";
import { AGENTS_TAB, FILES_TAB, INBOX_TAB, NEW_TAB, SETTINGS_TAB, useTabs, VIEW_TABS } from "./useTabs";
import { applyTheme, useSetting } from "@/lib/client/settings";
import { InboxScreen, inboxCount } from "./InboxScreen";
import { useFinished } from "@/lib/client/useFinished";
import { AgentsScreen, FilesScreen, preloadSessionChunks, SettingsScreen, ShortcutsDialog, WebTerminal } from "./lazy";
import { OPEN_FILES_EVENT, OPEN_SESSION_EVENT } from "@/lib/client/events";
import { OfflineBanner } from "./OfflineBanner";
import { useKeyboardInset } from "@/lib/client/useKeyboardInset";
import { setBaseTitle } from "@/lib/client/attention";
import { useLooking, useNotifications } from "@/lib/client/useNotifications";
import { Toaster } from "./Toaster";
import { registerWorker, resyncPush } from "@/lib/client/push";
import { shortPath } from "@/lib/client/api";
import { commandFor, isCommand, isMac, terminalOwns } from "@/lib/client/shortcuts";
import type { SessionSummary } from "@/lib/types";
import { useShareLanding } from "@/lib/client/share";
import { useEdgeSwipe, useTabSwipe } from "@/lib/client/gestures";

const isEditable = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === "TEXTAREA" || (t.tagName === "INPUT" && !["checkbox", "radio", "button"].includes((t as HTMLInputElement).type)));

if (typeof window !== "undefined") preloadScreens();

const preloadMarkdown = () => void import("./Markdown").then((m) => m.preloadMarkdown()).catch(() => undefined);

/* the open session stays put while the list, tabs or drawer change around it */
const OpenSession = memo(SessionScreen);

const SIDEBAR_KEY = "cui:sidebar";
const TAB_COMMANDS = ["nextTab", "prevTab", "newSession", "reopenTab", "closeTab", "tab1", "tab2", "tab3", "tab4", "tab5", "tab6", "tab7", "tab8", "lastTab"] as const;
/** null until checked (the server render and the first client render), so callers can keep both layouts until then */
function useMediaQuery(query: string) {
  const [matches, setMatches] = useState<boolean | null>(null);
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
  const { sessions, projects, error, refresh, loadMore } = useSessions();
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
  const wide = useMediaQuery("(min-width: 1024px)");
  const desktop = wide === true;
  const docked = desktop && dockPref;
  useEffect(() => {
    const open = (e: Event) => {
      setTerminal((e as CustomEvent<TerminalTarget>).detail);
      setTermKey((k) => k + 1);
      setTermHidden(false);
    };
    window.addEventListener(OPEN_TERMINAL_EVENT, open);
    const cancelPreload = preloadTerminalWhenIdle();
    return () => {
      window.removeEventListener(OPEN_TERMINAL_EVENT, open);
      cancelPreload();
    };
  }, []);

  const byId = useMemo(() => new Map((sessions ?? []).map((s) => [s.id, s])), [sessions]);
  useEffect(() => {
    if (sessions) syncTitles((id) => byId.get(id)?.title);
  }, [sessions, byId, syncTitles]);
  const infos = useMemo(() => openTabs.map((t) => describeTab(t, byId.get(t.id), sessions !== null)), [openTabs, byId, sessions]);
  const sessionId = active && active !== NEW_TAB && !VIEW_TABS[active] ? active : null;
  const looking = useLooking();
  /* behind another window the open session can finish unread too */
  const { finished, dismiss, unread } = useFinished(sessions, looking ? sessionId : null);
  const setUnread = useCallback((s: SessionSummary, on: boolean) => (on ? unread(s.id, s.mtime || Date.now()) : dismiss(s.id)), [unread, dismiss]);
  useEffect(() => {
    if (!sessionId) return;
    preloadMarkdown();
    preloadSessionChunks();
  }, [sessionId]);
  const inbox = inboxCount(sessions, finished);

  useEffect(() => {
    if (active === NEW_TAB) setBaseTitle("New session · agent-u");
    else if (active && VIEW_TABS[active]) setBaseTitle(`${VIEW_TABS[active]} · agent-u`);
  }, [active]);

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
  useEffect(() => {
    const on = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id;
      if (id) openSession(id);
    };
    window.addEventListener(OPEN_SESSION_EVENT, on);
    return () => window.removeEventListener(OPEN_SESSION_EVENT, on);
  }, [openSession]);
  useNotifications({ sessions, activeId: sessionId, looking, finished, onOpen: openSession });
  useSessionCommands({ sessions, activeId: sessionId, finished, onOpen: openSession });
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
  useShareLanding(newTab);
  const [gestures] = useSetting("touchGestures");
  const panelRef = useRef<HTMLDivElement>(null);
  const swipeState = useRef({ drawer, sheet, tabs: 0 });
  swipeState.current = { drawer, sheet, tabs: openTabs.length };
  useEdgeSwipe({ enabled: gestures, drawer: drawerRef, open: () => setDrawer(true), blocked: () => swipeState.current.drawer || swipeState.current.sheet });
  useTabSwipe(panelRef, { enabled: gestures, cycle: (d) => swipeState.current.tabs > 1 && cycle(d) });

  /* Tab shortcuts. Ctrl+Tab when the browser lets it through; Alt+arrows, Alt+1..9,
   * Alt+T (Alt+Shift+T reopens) and Alt+W otherwise, so the browser's own Ctrl+T/W keep working.
   * On a Mac, Option+arrows in a text field stay word jumps. */
  useEffect(() => {
    const mac = isMac();
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || drawer || sheet) return;
      const id = commandFor(e, TAB_COMMANDS, mac);
      if (!id) return;
      if (mac && e.altKey && (e.key === "ArrowRight" || e.key === "ArrowLeft") && isEditable(e.target)) return;
      e.preventDefault();
      if (id === "nextTab" || id === "prevTab") cycle(id === "nextTab" ? 1 : -1);
      else if (id === "newSession") newTab();
      else if (id === "reopenTab") reopen();
      else if (id === "closeTab") {
        if (active) close(active);
      } else select(id === "lastTab" ? -1 : Number(id.slice(3)) - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cycle, reopen, close, select, active, newTab, drawer, sheet]);

  /* Toggle terminal (Mod+J or Ctrl+`): open a shell in the current session's folder, or show/hide the terminal.
   * New terminal tab (Ctrl+Shift+`) adds one. Capture phase, so a focused terminal can't swallow Ctrl+`.
   * Ctrl+letter inside a terminal is a control character (Ctrl+J is a line feed), so it's left to the terminal. */
  const activeCwd = sessionId ? byId.get(sessionId)?.cwd || undefined : undefined;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || terminalOwns(e)) return;
      if (isCommand(e, "newTerminal")) {
        e.preventDefault();
        e.stopPropagation();
        setTermHidden(false);
        window.dispatchEvent(new CustomEvent(OPEN_TERMINAL_EVENT, { detail: { cwd: activeCwd, label: activeCwd ? `Shell: ${shortPath(activeCwd)}` : "Shell", newTab: true } }));
        return;
      }
      if (!isCommand(e, "terminal")) return;
      e.preventDefault();
      e.stopPropagation();
      if (!terminal) {
        window.dispatchEvent(new CustomEvent(OPEN_TERMINAL_EVENT, { detail: { cwd: activeCwd, label: activeCwd ? `Shell: ${shortPath(activeCwd)}` : "Shell" } }));
      } else setTermHidden((h) => !h);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [terminal, activeCwd]);

  /* Mod+, opens Settings */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isCommand(e, "settings")) return;
      e.preventDefault();
      openView(SETTINGS_TAB);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openView]);

  /* Mod+B (or Ctrl+Shift+S) folds the desktop sidebar, or opens the drawer on a phone */
  const toggleSidebar = sidebar.toggle;
  useEffect(() => {
    const flip = () => {
      if (window.matchMedia("(min-width: 1024px)").matches) toggleSidebar();
      else setDrawer((d) => !d);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      if (isCommand(e, "sidebar")) {
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
  const openDrawer = useCallback(() => setDrawer(true), []);
  /* a session list scrolled near its end asks for older sessions; its own Show more then has rows to reveal */
  const nearListEnd = useCallback(
    (e: UIEvent<HTMLElement>) => {
      const el = e.target as HTMLElement;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) loadMore();
    },
    [loadMore],
  );
  const navigate = useCallback(
    (next: string) => {
      if (sessionId) replace(sessionId, next);
    },
    [replace, sessionId],
  );
  const list = (onCollapse: () => void) => (
    <SessionList sessions={sessions} activeId={sessionId} onPick={openSession} onNew={newTab} onCollapse={onCollapse} error={error} onView={openView} activeView={active} inbox={inbox} finished={finished} onUnread={setUnread} onDeleted={close} />
  );
  const tabCount = infos.length;
  const tabAttention = infos.some((t) => t.needsYou && t.id !== active);
  const tabsButton = useMemo(() => <TabsButton count={tabCount} attention={tabAttention} onClick={() => setSheet(true)} />, [tabCount, tabAttention]);
  const activeIndex = openTabs.findIndex((t) => t.id === active);

  return (
    <main className="flex h-[calc(100dvh-var(--kb,0px))] bg-page text-ink lg:bg-sidebar">
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
        className="fixed top-[max(0.5rem,env(safe-area-inset-top))] left-2 z-[60] rounded-full bg-ink px-4 py-2 text-sm font-medium text-page shadow-overlay not-focus:sr-only"
      >
        Skip to message
      </a>
      <aside
        className="shell-sidebar relative z-20 hidden shrink-0 bg-sidebar lg:block"
        style={{ width: sidebar.collapsed ? 52 : "var(--sidebar-w, 260px)" }}
        data-anim={sidebar.anim || undefined}
        data-collapsed={sidebar.collapsed || undefined}
      >
        {/* phones never show the sidebar, so its list isn't mounted there (nor the drawer's on a desktop) */}
        <div className="shell-face absolute inset-0 overflow-hidden" data-hidden={sidebar.collapsed || undefined} inert={sidebar.collapsed}>
          <div className="h-full w-[var(--sidebar-w,260px)]" onScrollCapture={nearListEnd}>
            {wide !== false && list(sidebar.toggle)}
          </div>
        </div>
        <div className="shell-face absolute inset-y-0 left-0 w-[52px]" data-hidden={!sidebar.collapsed || undefined} inert={!sidebar.collapsed}>
          {wide !== false && <SessionRail sessions={sessions} activeId={sessionId} onPick={openSession} onNew={newTab} onExpand={sidebar.toggle} onView={openView} inbox={inbox} />}
        </div>
        {!sidebar.collapsed && <SidebarResizer />}
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
          data-drawer
          className="safe-top absolute inset-y-0 left-0 flex w-[86%] max-w-[320px] overscroll-contain bg-sidebar pl-[env(safe-area-inset-left)] shadow-overlay outline-none"
          style={{
            transform: drawer ? "translateX(0)" : "translateX(-104%)",
            /* visible at once on open (so focus can land), hidden only after the slide out */
            visibility: drawer ? "visible" : "hidden",
            transition: `transform 300ms cubic-bezier(0.23, 1, 0.32, 1)${drawer ? "" : ", visibility 0s linear 300ms"}`,
          }}
          inert={!drawer}
          onScrollCapture={nearListEnd}
        >
          {wide !== true && list(closeDrawer)}
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
        <div ref={panelRef} id="session-panel" role="tabpanel" aria-labelledby={activeIndex >= 0 ? `tab-${activeIndex}` : undefined} className="flex min-h-0 flex-1 flex-col outline-none">
          {!ready ? null : active === FILES_TAB ? (
            <FilesScreen onMenu={() => setDrawer(true)} extra={tabsButton} start={filesStart.path} startKey={filesStart.n} />
          ) : active === INBOX_TAB ? (
            <InboxScreen sessions={sessions} finished={finished} onDismiss={dismiss} onOpen={openSession} onRefresh={() => void refresh()} onMenu={() => setDrawer(true)} extra={tabsButton} />
          ) : active === SETTINGS_TAB ? (
            <SettingsScreen onMenu={() => setDrawer(true)} extra={tabsButton} onAgents={() => openView(AGENTS_TAB)} />
          ) : active === AGENTS_TAB ? (
            <AgentsScreen onMenu={() => setDrawer(true)} extra={tabsButton} onOpenSession={openSession} projects={projects} />
          ) : sessionId ? (
            <OpenSession key={sessionId} id={sessionId} onMenu={openDrawer} onNavigate={navigate} onNew={newTab} extra={tabsButton} />
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
