"use client";

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { EditPencil, Folder, List, MailIn, Plus, Settings, StatsReport, Terminal, Xmark } from "iconoir-react";
import { AGENT_LABEL, type AgentId, type SessionSummary } from "@/lib/types";
import { timeAgo } from "@/lib/client/api";
import { Pulse } from "./Pulse";
import { AGENT_TONE, AgentBadge, isBusy, useModKey } from "./SessionList";
import { comboFor, useBindings } from "@/lib/client/shortcuts";
import { AGENTS_TAB, FILES_TAB, INBOX_TAB, NEW_TAB, SETTINGS_TAB, USAGE_TAB, VIEW_TABS, type Tab } from "./useTabs";
import { scrollBehavior } from "@/lib/client/motion";

const VIEW_META: Record<string, string> = { [AGENTS_TAB]: "Agents and terminals", [INBOX_TAB]: "Needs you", [FILES_TAB]: "Files", [SETTINGS_TAB]: "Preferences", [USAGE_TAB]: "Tokens and cost" };

/* ─────────────────────────────────────────────────────────
 * TABS
 * Quiet browser-style tabs: fixed widths so every close button
 * lands in the same spot, the current tab a lighter pill, close
 * buttons on hover (always on the current tab and on touch), and
 * the agent as a tiny colored mark. The strip shows on desktop once
 * a second tab is open; below lg it collapses to a count button that
 * opens a sheet of open tabs.
 * ───────────────────────────────────────────────────────── */

export type TabInfo = {
  id: string;
  title: string;
  agent: AgentId;
  /** open in a terminal or a live web run */
  live: boolean;
  busy: boolean;
  needsYou: boolean;
  /** project · where/when, for the phone sheet */
  meta: string | null;
};

export function describeTab(tab: Tab, session: SessionSummary | undefined, listLoaded: boolean, now = Date.now()): TabInfo {
  if (tab.id === NEW_TAB) return { id: tab.id, title: "New session", agent: "claude", live: false, busy: false, needsYou: false, meta: null };
  if (VIEW_TABS[tab.id]) return { id: tab.id, title: VIEW_TABS[tab.id], agent: "claude", live: false, busy: false, needsYou: false, meta: VIEW_META[tab.id] ?? null };
  const agent = (tab.id.includes(":") ? tab.id.slice(0, tab.id.indexOf(":")) : "claude") as AgentId;
  if (!session) {
    return { id: tab.id, title: tab.title ?? (listLoaded ? "Session" : "Loading…"), agent: AGENT_LABEL[agent] ? agent : "claude", live: false, busy: false, needsYou: false, meta: null };
  }
  const live = Boolean(session.terminal) || (session.web !== null && session.web.status !== "closed");
  const where = session.web ? "web" : session.terminal ? "terminal" : null;
  return {
    id: tab.id,
    title: session.title || tab.title || "Session",
    agent: session.agent,
    live,
    busy: live && isBusy(session),
    needsYou: (session.web?.pending.length ?? 0) > 0,
    meta: `${session.project || "No folder"} · ${live && where ? where : timeAgo(session.mtime, now)}`,
  };
}

/** The tab's favicon: needs you, the new-session pencil, a live pulse, or a resting dot, all in the agent's color. */
function Indicator({ t, size = 2.5 }: { t: TabInfo; size?: number }) {
  if (t.needsYou) return <span className="size-1.5 shrink-0 rounded-full bg-orange" aria-label="Needs you" role="img" />;
  if (t.id === NEW_TAB) return <EditPencil width={12} height={12} strokeWidth={2} className="shrink-0 text-ink-3" aria-hidden />;
  if (t.id === AGENTS_TAB) return <Terminal width={12} height={12} strokeWidth={2} className="shrink-0 text-ink-3" aria-hidden />;
  if (t.id === INBOX_TAB) return <MailIn width={12} height={12} strokeWidth={2} className="shrink-0 text-ink-3" aria-hidden />;
  if (t.id === USAGE_TAB) return <StatsReport width={12} height={12} strokeWidth={2} className="shrink-0 text-ink-3" aria-hidden />;
  if (t.id === SETTINGS_TAB) return <Settings width={12} height={12} strokeWidth={2} className="shrink-0 text-ink-3" aria-hidden />;
  if (VIEW_TABS[t.id]) return <Folder width={12} height={12} strokeWidth={2} className="shrink-0 text-ink-3" aria-hidden />;
  if (t.live) return <Pulse busy={t.busy} size={size} cellClass={AGENT_TONE[t.agent]} />;
  return <span className={`size-1.5 shrink-0 rounded-full ${AGENT_TONE[t.agent]} ${t.agent === "claude" ? "opacity-25" : ""}`} aria-hidden />;
}

const stateLabel = (t: TabInfo) => (t.needsYou ? ", needs you" : t.busy ? ", working" : t.live ? ", open" : "");

/* ── desktop strip ──────────────────────────────────────── */

export function TabBar({
  tabs,
  active,
  onSelect,
  onClose,
  onNew,
  onMove,
}: {
  tabs: TabInfo[];
  active: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onMove: (id: string, to: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ left: false, right: false });
  const [dragging, setDragging] = useState<string | null>(null);
  const mod = useModKey();
  const bindings = useBindings();
  const closeKey = comboFor("closeTab", mod === "⌘", { bindings });

  /* fade edges only where there's more to scroll */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      const left = el.scrollLeft > 1;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setFade((f) => (f.left === left && f.right === right ? f : { left, right }));
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, []);

  /* keep the active tab in view */
  useEffect(() => {
    const el = scrollRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    el?.parentElement?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: scrollBehavior() });
  }, [active, tabs.length]);

  /* arrows move focus (manual activation: Enter/Space opens, so the composer doesn't steal focus mid-browse) */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = [...(scrollRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const go = (n: number) => {
      e.preventDefault();
      list[(n + list.length) % list.length]?.focus();
    };
    if (e.key === "ArrowRight") go(i + 1);
    else if (e.key === "ArrowLeft") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(list.length - 1);
    else if (e.key === "Delete") {
      e.preventDefault();
      onClose(tabs[i].id);
      requestAnimationFrame(() => scrollRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[Math.min(i, list.length - 2)]?.focus());
    }
  };

  return (
    <div
      className="flex h-11 shrink-0 items-center pt-1 pr-2 pl-2"
      onDoubleClick={(e) => e.target === e.currentTarget && onNew()}
    >
      <div
        ref={scrollRef}
        className="tab-scroll no-scrollbar min-w-0 overflow-x-auto"
        data-fade-left={fade.left || undefined}
        data-fade-right={fade.right || undefined}
        onWheel={(e) => {
          const el = scrollRef.current;
          if (el && Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += e.deltaY;
        }}
      >
        <div role="tablist" aria-label="Open sessions" aria-orientation="horizontal" className="flex w-max items-center gap-0.5 px-0.5 py-1" onKeyDown={onKeyDown}>
          {tabs.map((t, i) => {
            const on = t.id === active;
            return (
              <div
                key={t.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", t.id);
                  setDragging(t.id);
                }}
                onDragOver={(e) => {
                  if (!dragging) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (dragging !== t.id) onMove(dragging, i);
                }}
                onDrop={(e) => e.preventDefault()}
                onDragEnd={() => setDragging(null)}
                onMouseDown={(e) => e.button === 1 && e.preventDefault()}
                onAuxClick={(e) => {
                  if (e.button !== 1) return;
                  e.preventDefault();
                  onClose(t.id);
                }}
                data-on={on || undefined}
                role="presentation"
                className={`tab-item group/tab relative flex h-8 w-[184px] shrink-0 items-center rounded-control pr-1 text-sm transition-[background-color,color,opacity,box-shadow] duration-150 ${dragging === t.id ? "opacity-50" : ""}`}
                style={{ animation: "tab-in 220ms cubic-bezier(0.23,1,0.32,1) both" }}
              >
                <button
                  type="button"
                  role="tab"
                  id={`tab-${i}`}
                  aria-selected={on}
                  aria-controls="session-panel"
                  aria-label={`${t.title}${t.agent !== "claude" ? `, ${AGENT_LABEL[t.agent]}` : ""}${stateLabel(t)}`}
                  tabIndex={on ? 0 : -1}
                  aria-keyshortcuts="Delete"
                  title={t.agent !== "claude" ? `${t.title}\n${AGENT_LABEL[t.agent]}` : t.title}
                  onClick={() => onSelect(t.id)}
                  className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-control pl-2.5 text-left focus-visible:outline-offset-[-2px]"
                >
                  <span className="flex size-3 shrink-0 items-center justify-center">
                    <Indicator t={t} />
                  </span>
                  <span className="min-w-0 truncate">{t.title}</span>
                </button>
                {/* pointer-only: inside a tablist only tabs may be exposed; keyboards close with Delete or Alt+W */}
                <button
                  type="button"
                  aria-hidden
                  title={closeKey ? `Close (${closeKey})` : "Close"}
                  tabIndex={-1}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onClose(t.id)}
                  className={`ml-0.5 flex size-5 shrink-0 items-center justify-center rounded-chip text-ink-3 transition-[background-color,color,opacity] duration-100 hover:bg-hover-2 hover:text-ink pointer-coarse:opacity-100 ${
                    on ? "" : "opacity-0 group-hover/tab:opacity-100 group-focus-within/tab:opacity-100"
                  }`}
                >
                  <Xmark width={11} height={11} strokeWidth={2.2} aria-hidden />
                </button>
              </div>
            );
          })}
        </div>
      </div>
      <button
        type="button"
        aria-label="New session"
        data-tip="New session  Alt T"
        data-tip-pos="bottom"
        onClick={onNew}
        className="relative ml-1 flex size-8 shrink-0 items-center justify-center rounded-control text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink"
      >
        <Plus width={17} height={17} strokeWidth={1.8} aria-hidden />
      </button>
    </div>
  );
}

/* ── phone switcher ─────────────────────────────────────── */

/** The browser-style tab counter for compact headers. */
export function TabsButton({ count, attention, onClick }: { count: number; attention: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Open tabs: ${count}${attention ? ", one needs you" : ""}`}
      aria-haspopup="dialog"
      data-tabs-opener
      className="relative flex size-10 shrink-0 items-center justify-center rounded-[10px] text-ink-2 hover:bg-hover hover:text-ink lg:hidden"
    >
      <span className="flex h-[19px] min-w-[19px] items-center justify-center rounded-[6px] border-[1.6px] border-current px-[3px] text-2xs font-semibold tabular-nums leading-none">
        {count > 99 ? "∞" : count}
      </span>
      {attention && <span className="absolute top-2 right-2 size-2 rounded-full bg-orange ring-2 ring-page" aria-hidden />}
    </button>
  );
}

export function TabSheet({
  open,
  tabs,
  active,
  onSelect,
  onClose,
  onNew,
  onAllSessions,
  onDismiss,
}: {
  open: boolean;
  tabs: TabInfo[];
  active: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onAllSessions: () => void;
  onDismiss: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    (panel?.querySelector<HTMLElement>('[aria-current="page"]') ?? panel)?.focus({ preventScroll: true });
    panel?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest" });
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && onDismiss();
    const desktop = window.matchMedia("(min-width: 1024px)");
    const onWide = () => desktop.matches && onDismiss();
    window.addEventListener("keydown", onKey);
    desktop.addEventListener("change", onWide);
    return () => {
      window.removeEventListener("keydown", onKey);
      desktop.removeEventListener("change", onWide);
      const back = opener?.isConnected ? opener : document.querySelector<HTMLElement>("[data-tabs-opener]");
      requestAnimationFrame(() => back?.focus({ preventScroll: true }));
    };
  }, [open, onDismiss]);

  return (
    <div className={`fixed inset-0 z-40 lg:hidden ${open ? "" : "pointer-events-none"}`} aria-hidden={!open} role="dialog" aria-modal="true" aria-label="Open tabs">
      <div
        className="absolute inset-0 touch-none bg-black/50 transition-opacity duration-300"
        style={{ opacity: open ? 1 : 0, transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)" }}
        onClick={onDismiss}
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        inert={!open}
        className="safe-x absolute inset-x-0 bottom-0 flex max-h-[min(78dvh,640px)] flex-col rounded-t-[14px] bg-canvas shadow-overlay outline-none"
        style={{
          transform: open ? "translateY(0)" : "translateY(104%)",
          visibility: open ? "visible" : "hidden",
          transition: `transform 300ms cubic-bezier(0.23, 1, 0.32, 1)${open ? "" : ", visibility 0s linear 300ms"}`,
        }}
      >
        <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-line-strong" aria-hidden />
        <div className="flex h-12 shrink-0 items-center gap-2 pr-2 pl-4">
          <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">Open tabs</h2>
          <span className="text-sm tabular-nums text-ink-3">{tabs.length}</span>
          <button
            type="button"
            onClick={onNew}
            className="tap relative ml-auto flex h-9 items-center gap-1.5 rounded-full px-3 text-sm font-medium text-ink shadow-btn transition-[background-color,transform] duration-150 hover:bg-hover active:scale-[0.97]"
          >
            <Plus width={15} height={15} strokeWidth={2} aria-hidden />
            New
          </button>
          <button type="button" onClick={onDismiss} aria-label="Close" className="flex size-10 items-center justify-center rounded-[10px] text-ink-3 hover:bg-hover hover:text-ink">
            <Xmark width={17} height={17} strokeWidth={2} aria-hidden />
          </button>
        </div>
        <ul className="no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
          {tabs.map((t) => {
            const on = t.id === active;
            return (
              <li key={t.id} className={`flex items-center rounded-card ${on ? "bg-hover-2" : ""}`}>
                <button
                  type="button"
                  onClick={() => onSelect(t.id)}
                  aria-current={on ? "page" : undefined}
                  className="flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-card py-2 pl-3 text-left focus-visible:outline-offset-[-2px]"
                >
                  <span className="flex w-3 shrink-0 justify-center">
                    <Indicator t={t} size={3} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className={`min-w-0 truncate text-md font-medium ${on ? "text-ink" : "text-ink-2"}`}>{t.title}</span>
                      {t.agent !== "claude" && <AgentBadge agent={t.agent} />}
                    </span>
                    {(t.meta || t.needsYou) && (
                      <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-sm text-ink-3">
                        {t.needsYou && <span className="shrink-0 font-medium text-orange-ink">Needs you</span>}
                        {t.needsYou && t.meta && <span aria-hidden>·</span>}
                        {t.meta && <span className="truncate">{t.meta}</span>}
                      </span>
                    )}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onClose(t.id)}
                  aria-label={`Close ${t.title}`}
                  className="mr-1 flex size-11 shrink-0 items-center justify-center rounded-control text-ink-3 hover:bg-hover hover:text-ink"
                >
                  <Xmark width={15} height={15} strokeWidth={2} aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
        <div className="shrink-0 border-t border-line px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={onAllSessions}
            className="flex h-11 w-full items-center gap-3 rounded-card px-3 text-left text-base font-medium text-ink-2 hover:bg-hover hover:text-ink"
          >
            <List width={17} height={17} strokeWidth={1.8} aria-hidden />
            All sessions
          </button>
        </div>
      </div>
    </div>
  );
}
