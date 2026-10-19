"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Alarm, Archive, Calendar, ChatBubbleEmpty, Check, Clock, CloudXmark, EditPencil, Folder, HalfMoon, Hashtag, Link, LogOut, Mail, MailIn, MailOpen, MoreHoriz, NavArrowLeft, NavArrowRight, Pin, PinSlash, Search, Settings, SidebarCollapse, SidebarExpand, SunLight, Terminal, Trash, Xmark } from "iconoir-react";
import { AGENT_LABEL, TRANSCRIPT_DELETABLE, type AgentId, type SessionSummary } from "@/lib/types";
import { shortPath } from "@/lib/client/api";
import { signOut } from "@/lib/client/push";
import { deleteSession, patchSession, reloadSessions, type SessionChange } from "@/lib/client/useSessions";
import { noMatchCopy, sessionsErrorCopy, sidebarEmpty, sidebarEmptyCopy } from "@/lib/empty-states";
import { EmptyState } from "@/components/primitives/EmptyState";
import type { Finished } from "@/lib/client/useFinished";
import { terminalBusy } from "@/lib/status";
import { sessionStatus, STATUS_LABEL, type SessionStatus } from "@/lib/client/session-status";
import { snoozePresets, wakeLabel } from "@/lib/client/snooze";
import { toast, type ToastInput } from "@/lib/client/toast";
import { OPEN_PALETTE_EVENT } from "./CommandPalette";
import { Pulse } from "./Pulse";
import { ThemeToggle } from "./ThemeToggle";
import { NotifyButton } from "./NotifyButton";
import { copyText } from "./CodeCard";
import { primaryBtn, secondaryBtn, Sheet } from "./Sheet";
import { Kbd } from "@/components/atoms/Kbd";
import { OPEN_SETTINGS_SECTION_EVENT, useSetting } from "@/lib/client/settings";
import { comboFor, useBindings } from "@/lib/client/shortcuts";
import { keysFor } from "@/lib/keybindings";
import type { Settings as SettingValues } from "@/lib/settings-schema";
import { absoluteTime, capCount, capRows, groupByProject, groupRows, relativeTime, sortSessions, tabStop, rovingTarget, type RecentsGroup, type SidebarSort } from "@/lib/client/sidebar";
import { createFlip } from "@/lib/client/flip";
import { AgentIcon } from "./AgentIcon";
import { ProjectIcon, useProjectIcons } from "./ProjectIcon";
import { SessionHoverCard } from "./SessionHoverCard";

/* ─────────────────────────────────────────────────────────
 * SIDEBAR
 * A thread list: New session and Search up top, Inbox, Agents
 * and Files in one row, then Pinned and either the project
 * groups or one flat Recent list (Settings > Sidebar). Each
 * session shows once, as one line: status dot, title, time.
 * Actions live in the row menu (right-click, "..." or the
 * context-menu key); F2 renames, Delete archives. The list is
 * one tab stop that arrow keys move through.
 * Collapsed on desktop, SessionRail stands in for it.
 * ───────────────────────────────────────────────────────── */

export const isBusy = (s: Pick<SessionSummary, "terminal" | "web">) =>
  s.web ? s.web.status === "running" || s.web.status === "starting" : terminalBusy(s.terminal?.status);

export const isLive = (s: SessionSummary) => Boolean(s.terminal) || (s.web !== null && s.web.status !== "closed");

/** One color per agent, used for the tiny marks in tabs and the rail. Claude stays neutral. */
export const AGENT_TONE: Record<AgentId, string> = {
  claude: "bg-ink",
  codex: "bg-agent-codex",
  opencode: "bg-agent-opencode",
  cursor: "bg-agent-cursor",
  devin: "bg-agent-devin",
  kimi: "bg-agent-kimi",
  gemini: "bg-agent-gemini",
  antigravity: "bg-agent-antigravity",
};

/** A tiny colored dot that names the agent for screen readers and on hover. */
export function AgentMark({ agent, className = "" }: { agent: AgentId; className?: string }) {
  return <span role="img" aria-label={AGENT_LABEL[agent]} title={AGENT_LABEL[agent]} className={`inline-block size-1.5 shrink-0 rounded-full ${AGENT_TONE[agent]} ${className}`} />;
}

export function AgentBadge({ agent }: { agent: AgentId }) {
  return <span className="shrink-0 text-xs text-ink-3">{AGENT_LABEL[agent]}</span>;
}

/** Snoozed and quiet: out of the main lists. A session that's working or waiting on you always shows. */
export const isAsleep = (s: SessionSummary, now: number) => (s.snoozedUntil ?? 0) > now && !s.archived && !isBusy(s) && !s.web?.pending.length;

/** The id the agent itself knows the session by ("codex:abc" is abc), for its own resume command. */
export const nativeId = (id: string) => id.slice(id.indexOf(":") + 1);

/** The address that opens a session, the same one notifications use. */
export const sessionLink = (id: string) => `${window.location.origin}/?s=${encodeURIComponent(id)}`;

/** Ctrl or ⌘, read after mount so the server render matches. */
/** A tooltip with the command's current keys after it, when it has any. */
const withKeys = (label: string, keys: string) => (keys ? `${label}  ${keys}` : label);

export function useModKey() {
  const [mod, setMod] = useState("Ctrl");
  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.platform)) setMod("⌘");
  }, []);
  return mod;
}

function useStored<T extends string>(key: string, fallback: T, allowed?: readonly T[]) {
  const [value, setValue] = useState<T>(fallback);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(key) as T | null;
      if (saved && (!allowed || allowed.includes(saved))) setValue(saved);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const set = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem(key, v);
    } catch {}
  };
  return [value, set] as const;
}

/** Quiet square icon button with a hover tooltip. */
export function IconButton({
  label,
  tip,
  tipPos,
  onClick,
  children,
  className = "",
  pressed,
}: {
  label: string;
  tip?: string;
  tipPos?: "right" | "bottom" | "bottom-end";
  onClick: () => void;
  children: ReactNode;
  className?: string;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      data-tip={tip ?? label}
      data-tip-pos={tipPos ?? "bottom"}
      onClick={onClick}
      className={`icon-btn ${className}`}
    >
      {children}
    </button>
  );
}

function Brand() {
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-[7px] bg-ink">
      <Pulse busy={false} size={3} cellClass="bg-page" />
    </span>
  );
}

/* ── rows ───────────────────────────────────────────────── */

type MenuAt = { x: number; y: number } | HTMLElement;

/** Which list a row sits in. A session shows once: in Pinned, its project or Recent, Snoozed or Archived. */
type RowWhere = "match" | "pinned" | "project" | "recent" | "snoozed" | "archived";

const STATUS_DOT: Record<SessionStatus, string> = {
  approval: "bg-orange",
  input: "bg-orange",
  working: "bg-accent motion-safe:animate-pulse",
  failed: "bg-red",
  unread: "bg-green",
};

/** Focus a session's row after a re-render, in this list. */
const focusRow = (list: HTMLElement | null, id: string) =>
  requestAnimationFrame(() => list?.querySelector<HTMLElement>(`[data-session-row="${CSS.escape(id)}"]`)?.focus({ preventScroll: false }));

type RowProps = {
  id: string;
  title: string;
  status: SessionStatus | null;
  /** last activity (or start, or when a snoozed session wakes), already formatted */
  time: string;
  /** set when rows show their agent */
  agent: AgentId | null;
  active: boolean;
  where: RowWhere;
  menuOpen: boolean;
  renaming: boolean;
  /** the text typed so far, so a field that re-mounts carries on */
  draft: { current: string | null };
  onPick: (id: string) => void;
  onMenu: (id: string, at: MenuAt) => void;
  onRenamed: (id: string, title: string | null, viaKey: boolean) => void;
};

/** One session: status dot, title, time. The "..." button covers the time on hover or focus, so nothing reflows.
 * Props are plain values and stable callbacks: a poll that changes one session re-renders only its row. */
const Row = memo(function Row({ id, title, status, time, agent, active, where, menuOpen, renaming, draft, onPick, onMenu, onRenamed }: RowProps) {
  if (renaming) return <RenameRow title={title} draft={draft} onDone={(t, viaKey) => onRenamed(id, t, viaKey)} />;
  const tail = menuOpen ? "invisible" : "pointer-fine:group-hover/item:invisible pointer-fine:group-focus-within/item:invisible";
  return (
    <div
      className="group/item relative"
      onContextMenu={(e) => {
        e.preventDefault();
        /* the context-menu key reports no position: anchor to the row */
        onMenu(id, e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : e.currentTarget);
      }}
    >
      <button
        type="button"
        data-session-row={id}
        data-nav={`row:${id}`}
        data-row-where={where}
        onClick={() => onPick(id)}
        aria-current={active ? "page" : undefined}
        aria-keyshortcuts="F2 Delete"
        className={`side-row gap-2.5 text-sm pointer-coarse:pr-12 ${active || status === "unread" ? "text-ink" : "text-ink-2"}`}
      >
        <span className="flex w-1.5 shrink-0 justify-center" aria-hidden>
          {status && <span className={`size-1.5 rounded-full ${STATUS_DOT[status]}`} />}
        </span>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {status && <span className="sr-only">, {STATUS_LABEL[status]}</span>}
        {agent && <AgentIcon agent={agent} size={13} label className="opacity-90" />}
        <span className={`min-w-7 shrink-0 text-right text-xs text-ink-3 tabular-nums ${tail}`}>{time}</span>
      </button>
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Options for ${title}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={(e) => onMenu(id, e.currentTarget)}
        className={`absolute top-1/2 right-1.5 flex size-7 -translate-y-1/2 items-center justify-center rounded-control text-ink-3 transition-[background-color,color,opacity] duration-150 hover:bg-sidebar-active hover:text-ink group-hover/item:opacity-100 group-focus-within/item:opacity-100 pointer-coarse:right-0 pointer-coarse:size-11 pointer-coarse:opacity-100 ${menuOpen ? "bg-sidebar-active text-ink opacity-100" : "opacity-0"}`}
      >
        <MoreHoriz width={16} height={16} strokeWidth={2} aria-hidden />
      </button>
    </div>
  );
});

/** The row as a text field: Enter saves, Escape cancels, leaving the field saves. Empty brings the original name back. */
function RenameRow({ title, draft, onDone }: { title: string; draft: { current: string | null }; onDone: (title: string | null, viaKey: boolean) => void }) {
  const [resumed] = useState(() => draft.current !== null);
  const [value, setValue] = useState(() => draft.current ?? title);
  const done = useRef(false);
  /* a field that unmounts because its row moved must not save what it had (a blur on removal would) */
  useLayoutEffect(() => {
    done.current = false;
    return () => {
      done.current = true;
    };
  }, []);
  const finish = (next: string | null, viaKey: boolean) => {
    if (done.current) return;
    done.current = true;
    onDone(next, viaKey);
  };
  return (
    <div className="side-row gap-2.5 bg-sidebar-hover shadow-[inset_0_0_0_1.5px_var(--accent)]">
      <span className="w-1.5 shrink-0" aria-hidden />
      <input
        autoFocus
        value={value}
        maxLength={200}
        onChange={(e) => {
          setValue(e.target.value);
          draft.current = e.target.value;
        }}
        onFocus={(e) => {
          const el = e.currentTarget;
          if (resumed) el.setSelectionRange(el.value.length, el.value.length);
          else el.select();
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter") {
            e.preventDefault();
            finish(value, true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            finish(null, true);
          }
        }}
        onBlur={() => finish(value, false)}
        name="session-name"
        autoComplete="off"
        spellCheck={false}
        aria-label="Session name"
        className="min-w-0 flex-1 bg-transparent text-[16px] text-ink outline-none sm:text-sm sm:pointer-coarse:text-[16px]"
      />
    </div>
  );
}

type RowAction = "pin" | "rename" | "read" | "archive" | "path" | "id" | "link" | "delete" | "wake" | { snooze: number };

/** Pin, rename, mark read, snooze, archive, the copy actions and delete for one row, floating at the pointer or under the "..." button.
 * Snooze opens its presets in place, so it works the same on a phone. */
function RowMenu({
  s,
  at,
  unread,
  onClose,
  onAction,
}: {
  s: SessionSummary;
  at: MenuAt;
  unread: boolean;
  onClose: (restoreFocus: boolean) => void;
  onAction: (action: RowAction) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CSSProperties>({});
  const [page, setPage] = useState<"main" | "snooze">("main");
  const [now] = useState(() => Date.now());
  const presets = useMemo(() => snoozePresets(new Date(now)), [now]);
  const snoozed = (s.snoozedUntil ?? 0) > now;
  useLayoutEffect(() => {
    const w = ref.current?.offsetWidth ?? 192;
    const h = ref.current?.offsetHeight ?? 180;
    let x: number;
    let y: number;
    if (at instanceof HTMLElement) {
      const r = at.getBoundingClientRect();
      x = r.right - w;
      y = r.bottom + 4 + h <= window.innerHeight - 8 ? r.bottom + 4 : r.top - 4 - h;
    } else {
      x = at.x;
      y = at.y + h <= window.innerHeight - 8 ? at.y : at.y - h;
    }
    setPlace({
      position: "fixed",
      left: Math.max(8, Math.min(x, window.innerWidth - w - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - h - 8)),
    });
  }, [at, page]);
  const placed = Boolean(place.position);
  useEffect(() => {
    if (!placed) return;
    const items = ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    /* on the presets page, past "Back" */
    items?.[page === "snooze" ? 1 : 0]?.focus({ preventScroll: true });
  }, [placed, page]);
  useEffect(() => {
    const inside = (t: EventTarget | null) => t instanceof Node && Boolean(ref.current?.contains(t) || (at instanceof HTMLElement && at.contains(t)));
    const onDown = (e: PointerEvent) => !inside(e.target) && onClose(false);
    const onFocus = (e: FocusEvent) => !inside(e.target) && onClose(false);
    const onScroll = (e: Event) => !inside(e.target) && onClose(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" && e.key !== "Tab") return;
      if (e.key === "Escape") e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" && page === "snooze") setPage("main");
      else onClose(e.key === "Escape");
    };
    const onResize = () => onClose(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("focusin", onFocus);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("focusin", onFocus);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [at, onClose, page]);
  const item = (action: RowAction | (() => void), label: string, icon: ReactNode, trail?: ReactNode) => (
    <button
      key={typeof action === "object" ? action.snooze : label}
      type="button"
      role="menuitem"
      onClick={() => (typeof action === "function" ? action() : onAction(action))}
      className="menu-item"
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-ink-3">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trail}
    </button>
  );
  const icon = { width: 15, height: 15, strokeWidth: 1.9, "aria-hidden": true } as const;
  const when = (text: string) => <span className="shrink-0 text-xs text-ink-3 tabular-nums">{text}</span>;
  const PRESET_ICON = { hour: <Clock {...icon} />, tonight: <HalfMoon {...icon} />, tomorrow: <SunLight {...icon} />, "next-week": <Calendar {...icon} /> };
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={page === "snooze" ? `Snooze ${s.title}` : s.title}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (page === "snooze" && e.key === "ArrowLeft") {
          e.preventDefault();
          setPage("main");
          return;
        }
        if (page === "main" && e.key === "ArrowRight" && (document.activeElement as HTMLElement | null)?.dataset.submenu) {
          e.preventDefault();
          setPage("snooze");
          return;
        }
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
        e.preventDefault();
        const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
        const i = items.indexOf(document.activeElement as HTMLElement);
        const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }}
      className={`z-50 rounded-[12px] bg-surface p-1 shadow-overlay ${page === "snooze" ? "w-56" : "w-48"}`}
      style={{ animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both", ...place, visibility: place.position ? "visible" : "hidden" }}
    >
      {page === "snooze" ? (
        <>
          {item(() => setPage("main"), "Snooze", <NavArrowLeft {...icon} />)}
          <div className="mx-2 my-1 h-px bg-line" />
          {presets.map((p) => item({ snooze: p.at }, p.label, PRESET_ICON[p.id], when(p.when)))}
        </>
      ) : (
        <>
          {item("pin", s.pinned ? "Unpin" : "Pin", s.pinned ? <PinSlash {...icon} /> : <Pin {...icon} />)}
          {item("rename", "Rename", <EditPencil {...icon} />)}
          {item("read", unread ? "Mark as read" : "Mark as unread", unread ? <MailOpen {...icon} /> : <Mail {...icon} />)}
          {snoozed ? (
            item("wake", "Wake", <Alarm {...icon} />, when(wakeLabel(s.snoozedUntil!, now)))
          ) : (
            !s.archived && (
              <button type="button" role="menuitem" aria-haspopup="menu" data-submenu="snooze" onClick={() => setPage("snooze")} className="menu-item">
                <span className="flex size-4 shrink-0 items-center justify-center text-ink-3">
                  <Clock {...icon} />
                </span>
                <span className="min-w-0 flex-1 truncate">Snooze</span>
                <NavArrowRight width={13} height={13} strokeWidth={2} className="shrink-0 text-ink-3" aria-hidden />
              </button>
            )
          )}
          {item("archive", s.archived ? "Unarchive" : "Archive", <Archive {...icon} />)}
          <div className="mx-2 my-1 h-px bg-line" />
          {s.cwd && item("path", "Copy folder path", <Folder {...icon} />)}
          {item("id", "Copy session ID", <Hashtag {...icon} />)}
          {item("link", "Copy link", <Link {...icon} />)}
          <div className="mx-2 my-1 h-px bg-line" />
          <button type="button" role="menuitem" onClick={() => onAction("delete")} className="menu-item text-red-ink">
            <span className="flex size-4 shrink-0 items-center justify-center">
              <Trash {...icon} />
            </span>
            <span className="min-w-0 flex-1 truncate">Delete…</span>
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}

/** Confirms a delete. The transcript file goes only when ticked, and only for agents that keep one file per session. */
function DeleteDialog({ s, onClose, onDeleted }: { s: SessionSummary; onClose: () => void; onDeleted: (transcript: boolean) => void }) {
  const [transcript, setTranscript] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = isBusy(s) || (s.web?.pending.length ?? 0) > 0;
  const fileOk = TRANSCRIPT_DELETABLE.includes(s.agent);
  const inTerminal = Boolean(s.terminal);
  const agent = AGENT_LABEL[s.agent];
  const close = useCallback(() => !busy && onClose(), [busy, onClose]);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteSession(s.id, fileOk && transcript && !inTerminal);
      onDeleted(fileOk && transcript && !inTerminal);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <Sheet
      title="Delete session?"
      onClose={close}
      footer={
        <>
          <button type="button" onClick={close} disabled={busy} className={secondaryBtn}>
            Cancel
          </button>
          <button type="button" data-autofocus={running ? undefined : true} onClick={() => void go()} disabled={running || busy} className={`${primaryBtn} bg-red text-white`}>
            {busy ? "Deleting…" : "Delete"}
          </button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-ink-2">
        <span className="font-medium text-ink [overflow-wrap:anywhere]">{s.title}</span> leaves the list on every device. This can&apos;t be undone.
      </p>
      {fileOk ? (
        <label className={`mt-3 flex items-start gap-2.5 text-sm leading-snug ${inTerminal ? "text-ink-3" : "text-ink"}`}>
          <input
            type="checkbox"
            checked={transcript && !inTerminal}
            disabled={inTerminal || busy}
            onChange={(e) => setTranscript(e.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-[var(--color-red)]"
          />
          <span>
            Also delete the transcript file
            <span className="mt-0.5 block text-sm text-ink-3">
              {inTerminal ? "It's open in a terminal, so the file stays." : transcript ? `Removes the history from ${agent}'s own storage too.` : `Otherwise the history stays in ${agent}'s own storage.`}
            </span>
          </span>
        </label>
      ) : (
        <p className="mt-2 text-sm leading-relaxed text-ink-3">The history stays in {agent}&apos;s own storage.</p>
      )}
      {running && (
        <p className="mt-3 rounded-control bg-orange-tint px-2.5 py-2 text-sm text-orange-ink">
          {(s.web?.pending.length ?? 0) > 0 ? "It's waiting on you. Answer or stop it first." : "It's running. Stop it first."}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 rounded-control bg-red-tint px-2.5 py-2 text-sm text-red-ink">
          {error}
        </p>
      )}
    </Sheet>
  );
}

/** Asks before archiving, when Settings > Sidebar says so. */
function ArchiveDialog({ s, onClose, onArchive }: { s: SessionSummary; onClose: () => void; onArchive: () => void }) {
  return (
    <Sheet
      title="Archive session?"
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className={secondaryBtn}>
            Cancel
          </button>
          <button type="button" data-autofocus onClick={onArchive} className={primaryBtn}>
            Archive
          </button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-ink-2">
        <span className="font-medium text-ink [overflow-wrap:anywhere]">{s.title}</span> moves to Archived on every device. You can restore it from there.
      </p>
    </Sheet>
  );
}

/* ── sections ───────────────────────────────────────────── */

function Section({ label, open, onToggle, action, children }: { label: string; open: boolean; onToggle: () => void; action?: ReactNode; children: ReactNode }) {
  return (
    <section data-nav-group className="group/section mt-4 first:mt-1">
      <div className="mb-px flex h-7 items-center gap-1 pr-1 pointer-coarse:h-10">
        <h2 className="min-w-0 flex-1">
          <button
            type="button"
            data-nav={`section:${label}`}
            onClick={onToggle}
            aria-expanded={open}
            className="group/label flex h-7 w-full items-center gap-1 rounded-control px-2.5 text-left text-xs font-medium text-ink-3 transition-colors duration-150 hover:text-ink-2 focus-visible:outline-offset-[-2px] pointer-coarse:h-10"
          >
            <span className="truncate">{label}</span>
            <NavArrowRight
              width={11}
              height={11}
              strokeWidth={2.2}
              aria-hidden
              className={`shrink-0 transition-[opacity,transform] duration-150 group-hover/section:opacity-100 group-focus-visible/label:opacity-100 pointer-coarse:opacity-100 ${open ? "rotate-90 opacity-0" : "opacity-100"}`}
            />
          </button>
        </h2>
        {action}
      </div>
      {open && <div className="flex flex-col gap-px">{children}</div>}
    </section>
  );
}

/** A folder's label: its favicon or monogram, then quiet 28px text; the mark turns into the chevron under a mouse or
 * keyboard focus, and the session count shows on hover. Without a folder it keeps the plain chevron. */
const ProjectHeader = memo(function ProjectHeader({ id, name, path, count, open, icon, onToggle }: { id: string; name: string; path: string; count: number; open: boolean; icon: string | null | undefined; onToggle: (id: string) => void }) {
  const chevron = <NavArrowRight width={12} height={12} strokeWidth={2.2} aria-hidden className={`shrink-0 transition-transform duration-150 ${open ? "rotate-90" : ""}`} />;
  return (
    <button
      type="button"
      data-nav={`project:${id}`}
      onClick={() => onToggle(id)}
      aria-expanded={open}
      title={path}
      className="group/ph flex h-7 w-full shrink-0 items-center gap-1.5 rounded-control px-2.5 text-left text-xs font-medium text-ink-3 transition-colors duration-150 hover:text-ink-2 focus-visible:outline-offset-[-2px] pointer-coarse:h-10"
    >
      {id ? (
        <span className="relative flex size-3.5 shrink-0 items-center justify-center" aria-hidden>
          <span className={`flex transition-opacity duration-150 pointer-fine:group-hover/ph:opacity-0 group-focus-visible/ph:opacity-0 ${open ? "" : "opacity-60"}`}>
            <ProjectIcon name={name} icon={icon} size={14} />
          </span>
          <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-150 pointer-fine:group-hover/ph:opacity-100 group-focus-visible/ph:opacity-100">{chevron}</span>
        </span>
      ) : (
        chevron
      )}
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <span className="shrink-0 tabular-nums opacity-0 transition-opacity duration-150 group-hover/ph:opacity-100 group-focus-visible/ph:opacity-100" aria-label={`${count} ${count === 1 ? "session" : "sessions"}`}>
        {count}
      </span>
    </button>
  );
});

const GROUPS: readonly RecentsGroup[] = ["none", "time", "agent"];
const GROUP_LABEL: Record<RecentsGroup, string> = { none: "None", time: "Date", agent: "Agent" };
const VIEW_LABEL: Record<SettingValues["sidebarGroup"], string> = { project: "By project", flat: "Flat list" };
const SORT_LABEL: Record<SidebarSort, string> = { activity: "Last activity", created: "Created", title: "Title" };

/** The list's overflow: filter, view, sort, the flat list's grouping, the agent filter, and a way to all of it in Settings. */
function ViewMenu({
  view,
  onView,
  sort,
  onSort,
  groupBy,
  onGroupBy,
  agents,
  agent,
  onAgent,
  onFilter,
  onSettings,
}: {
  view: SettingValues["sidebarGroup"];
  onView: (v: SettingValues["sidebarGroup"]) => void;
  sort: SidebarSort;
  onSort: (s: SidebarSort) => void;
  groupBy: RecentsGroup;
  onGroupBy: (g: RecentsGroup) => void;
  agents: AgentId[];
  agent: AgentId | "all";
  onAgent: (a: AgentId | "all") => void;
  onFilter: () => void;
  onSettings?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties>({});
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  /* the list scrolls, so the menu floats in a portal, under the button or above it when space runs out */
  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const r = buttonRef.current.getBoundingClientRect();
    const h = ref.current?.offsetHeight ?? 300;
    const below = r.bottom + 4 + h <= window.innerHeight - 8;
    setPlace({
      position: "fixed",
      left: Math.max(8, r.right - 208),
      ...(below ? { top: r.bottom + 4 } : { top: Math.max(8, r.top - 4 - h) }),
      transformOrigin: below ? "top right" : "bottom right",
    });
  }, [open, view]);
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus({ preventScroll: true });
    const inside = (t: EventTarget | null) => t instanceof Node && Boolean(ref.current?.contains(t) || buttonRef.current?.contains(t));
    const close = (e: PointerEvent) => !inside(e.target) && setOpen(false);
    const onFocus = (e: FocusEvent) => !inside(e.target) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("focusin", onFocus);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("focusin", onFocus);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const pick = (fn: () => void) => () => {
    fn();
    setOpen(false);
    buttonRef.current?.focus();
  };
  const item = (checked: boolean, label: string, onClick: () => void) => (
    <button key={label} type="button" role="menuitemradio" aria-checked={checked} onClick={pick(onClick)} className="menu-item">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {checked && <Check width={15} height={15} strokeWidth={2} className="shrink-0 text-ink-2" aria-hidden />}
    </button>
  );
  const heading = (text: string) => <div className="px-2 pt-1 pb-0.5 text-xs text-ink-3">{text}</div>;
  const rule = <div className="mx-2 my-1 h-px bg-line" />;
  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-label="View options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`flex size-7 items-center justify-center rounded-control text-ink-3 transition-[background-color,color,opacity] duration-150 hover:bg-sidebar-hover hover:text-ink group-hover/section:opacity-100 focus-visible:opacity-100 pointer-coarse:size-11 pointer-coarse:opacity-100 ${open ? "bg-sidebar-hover text-ink opacity-100" : "opacity-0"}`}
      >
        <MoreHoriz width={16} height={16} strokeWidth={2} aria-hidden />
      </button>
      {open &&
        createPortal(
          <div
            ref={ref}
            role="menu"
            aria-label="View options"
            onKeyDown={(e) => {
              if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
              e.preventDefault();
              const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
              const i = items.indexOf(document.activeElement as HTMLElement);
              const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
              items[next]?.focus();
            }}
            className="scroll-quiet z-50 max-h-[min(80vh,640px)] w-52 overflow-y-auto rounded-[12px] bg-surface p-1 shadow-overlay"
            style={{ animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both", ...place, visibility: place.position ? "visible" : "hidden" }}
          >
            <button type="button" role="menuitem" onClick={pick(onFilter)} className="menu-item">
              <Search width={14} height={14} strokeWidth={1.9} className="shrink-0 text-ink-3" aria-hidden />
              <span className="min-w-0 flex-1 truncate">Filter list…</span>
            </button>
            {rule}
            {heading("View")}
            {(["project", "flat"] as const).map((v) => item(view === v, VIEW_LABEL[v], () => onView(v)))}
            {rule}
            {heading("Sort by")}
            {(["activity", "created", "title"] as const).map((s) => item(sort === s, SORT_LABEL[s], () => onSort(s)))}
            {view === "flat" && (
              <>
                {rule}
                {heading("Group by")}
                {GROUPS.map((g) => item(groupBy === g, GROUP_LABEL[g], () => onGroupBy(g)))}
              </>
            )}
            {agents.length > 1 && (
              <>
                {rule}
                {heading("Show")}
                {item(agent === "all", "All agents", () => onAgent("all"))}
                {agents.map((a) => item(agent === a, AGENT_LABEL[a], () => onAgent(a)))}
              </>
            )}
            {onSettings && (
              <>
                {rule}
                <button type="button" role="menuitem" onClick={pick(onSettings)} className="menu-item">
                  <Settings width={14} height={14} strokeWidth={1.9} className="shrink-0 text-ink-3" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">Sidebar settings…</span>
                </button>
              </>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}

/** A minute clock for row times: one re-render a minute, at the turn of the minute. */
function useMinute(): [number, () => void] {
  const [now, setNow] = useState(() => Date.now());
  const bump = useCallback(() => setNow(Date.now()), []);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      t = setTimeout(
        () => {
          bump();
          tick();
        },
        60_000 - (Date.now() % 60_000) + 50,
      );
    };
    tick();
    const onShow = () => document.visibilityState === "visible" && bump();
    document.addEventListener("visibilitychange", onShow);
    return () => {
      clearTimeout(t);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [bump]);
  return [now, bump];
}

const PROJECT_CAP = 6;
const RECENT_STEP = 40;

type SectionKey = "pinned" | "projects" | "recents";
const NONE_FINISHED: Finished = {};
const SETTINGS_SECTION_KEY = "cui:settings-section";

export const SessionList = memo(function SessionList({
  sessions,
  activeId,
  onPick,
  onNew,
  onCollapse,
  collapseLabel = "Close sidebar",
  error,
  onView,
  activeView,
  inbox = 0,
  finished = NONE_FINISHED,
  onUnread,
  onDeleted,
}: {
  sessions: SessionSummary[] | null;
  activeId: string | null;
  /** sessions that finished a turn this device hasn't opened since */
  finished?: Finished;
  onUnread?: (s: SessionSummary, unread: boolean) => void;
  /** a session was deleted: close its tab */
  onDeleted?: (id: string) => void;
  /** kept for callers; open tabs no longer change how a row reads */
  openIds?: { id: string }[];
  onPick: (id: string) => void;
  onNew: () => void;
  /** desktop: fold the sidebar into the rail; phone: close the drawer */
  onCollapse?: () => void;
  collapseLabel?: string;
  error: string | null;
  /** opens the Agents or Files tab */
  onView?: (tab: "@agents" | "@files" | "@inbox" | "@settings") => void;
  activeView?: string | null;
  /** approvals, failures and finished turns waiting in the inbox */
  inbox?: number;
}) {
  const mod = useModKey();
  const [view, setView] = useSetting("sidebarGroup");
  const [sort, setSort] = useSetting("sidebarSort");
  const [projectCap] = useSetting("sidebarProjectCap");
  const [archivedOn] = useSetting("sidebarShowArchived");
  const [agentIcon] = useSetting("sidebarAgentIcon");
  const [timeStyle] = useSetting("sidebarTime");
  const [timeFmt] = useSetting("timeFormat");
  const [confirmFirst] = useSetting("sidebarConfirm");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [groupBy, setGroupBy] = useStored<RecentsGroup>("cui:recentsGroup", "none", GROUPS);
  const [agentFilter, setAgentFilter] = useStored<AgentId | "all">("cui:agent", "all");
  const [shut, setShut] = useState<Set<SectionKey>>(new Set());
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [fullProjects, setFullProjects] = useState<Set<string>>(new Set());
  const [allProjects, setAllProjects] = useState(false);
  const [recentCap, setRecentCap] = useState(RECENT_STEP);
  const [now, tickNow] = useMinute();

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("cui:sidebarShut") ?? "[]") as SectionKey[];
      if (Array.isArray(saved)) setShut(new Set(saved));
      const f = JSON.parse(localStorage.getItem("cui:sidebarFolded") ?? "[]") as string[];
      if (Array.isArray(f)) setFolded(new Set(f.filter((k) => typeof k === "string")));
    } catch {}
  }, []);
  const toggleSection = (k: SectionKey) =>
    setShut((cur) => {
      const next = new Set(cur);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      try {
        localStorage.setItem("cui:sidebarShut", JSON.stringify([...next]));
      } catch {}
      return next;
    });
  const toggleProject = useCallback(
    (key: string) =>
      setFolded((cur) => {
        const next = new Set(cur);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        try {
          localStorage.setItem("cui:sidebarFolded", JSON.stringify([...next].slice(-200)));
        } catch {}
        return next;
      }),
    [],
  );
  const flipFull = (key: string) =>
    setFullProjects((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const byId = useMemo(() => new Map((sessions ?? []).map((s) => [s.id, s])), [sessions]);
  const agentsPresent = useMemo(() => [...new Set((sessions ?? []).map((s) => s.agent))], [sessions]);
  const filter = agentsPresent.includes(agentFilter as AgentId) ? agentFilter : "all";
  const rows = useMemo(() => (sessions ?? []).filter((s) => filter === "all" || s.agent === filter), [sessions, filter]);
  const lists = useMemo(() => {
    const shown = rows.filter((s) => !s.archived);
    const awake = shown.filter((s) => !isAsleep(s, now));
    const rest = awake.filter((s) => !s.pinned);
    return {
      shown,
      awake,
      archived: sortSessions(
        rows.filter((s) => s.archived),
        sort,
      ),
      snoozed: shown.filter((s) => isAsleep(s, now)).sort((a, b) => a.snoozedUntil! - b.snoozedUntil!),
      pinned: sortSessions(
        awake.filter((s) => s.pinned),
        sort,
      ),
      recent: sortSessions(rest, sort),
      projects: groupByProject(rest, sort),
    };
  }, [rows, now, sort]);
  const { shown, awake, archived, snoozed, pinned, recent, projects } = lists;
  const nextWake = snoozed[0]?.snoozedUntil;
  useEffect(() => {
    if (!nextWake) return;
    /* setTimeout tops out near 24.8 days; a far wake just checks again then */
    const t = setTimeout(tickNow, Math.min(Math.max(0, nextWake - Date.now()) + 50, 2 ** 31 - 1));
    return () => clearTimeout(t);
  }, [nextWake, tickNow]);

  const [menu, setMenu] = useState<{ id: string; s: SessionSummary; at: MenuAt } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const renameDraft = useRef<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const retry = () => {
    setRetrying(true);
    void reloadSessions().finally(() => setRetrying(false));
  };
  const [deleting, setDeleting] = useState<SessionSummary | null>(null);
  const [archiving, setArchiving] = useState<SessionSummary | null>(null);
  /** One sidebar toast at a time; a new one replaces the last. Undo puts focus back on the row if it was in the toast. */
  const say = (title: string, opts: Omit<ToastInput, "title" | "key" | "action"> & { undo?: { id: string; run: () => void } } = {}) => {
    const { undo, ...rest } = opts;
    toast({
      key: "sidebar",
      title,
      ...rest,
      action: undo && {
        label: "Undo",
        run: () => {
          const fromToast = !document.activeElement || document.activeElement === document.body || Boolean(document.activeElement.closest("[data-toaster]"));
          undo.run();
          if (fromToast) refocus(undo.id);
        },
      },
    });
  };
  const fail = (what: string, err: unknown) => say(what, { tone: "error", body: err instanceof Error ? err.message : String(err) });
  /** Focuses a row once it's back in the list (it comes back on the next render or two). */
  const refocus = (id: string, tries = 10) =>
    requestAnimationFrame(() => {
      const el = listRef.current?.querySelector<HTMLElement>(`[data-session-row="${CSS.escape(id)}"]`);
      if (el) focusNav(el);
      else if (tries > 0) refocus(id, tries - 1);
    });

  /* ── roving focus: the list is one tab stop; arrows, Home and End move between rows and labels ── */
  const lastNav = useRef<string | null>(null);
  const lastNavIndex = useRef(0);
  const navItems = useCallback(() => [...(listRef.current?.querySelectorAll<HTMLElement>("[data-nav]") ?? [])], []);
  const syncStops = useCallback(() => {
    const items = navItems();
    const current = items.find((el) => el.getAttribute("aria-current") === "page")?.dataset.nav ?? null;
    const stop = tabStop(
      items.map((el) => el.dataset.nav!),
      lastNav.current,
      current,
      lastNavIndex.current,
    );
    items.forEach((el, i) => {
      el.tabIndex = i === stop ? 0 : -1;
    });
  }, [navItems]);
  useLayoutEffect(syncStops);
  const focusNav = (el: HTMLElement | undefined) => {
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: "nearest" });
  };
  /** Before a row leaves the list: its neighbor takes the tab stop, and focus if the row had it. */
  const handOff = (id: string) => {
    const items = navItems();
    const i = items.findIndex((el) => el.dataset.sessionRow === id);
    if (i < 0) return;
    const next = items[i + 1]?.dataset.sessionRow ? items[i + 1] : (items[i - 1] ?? items[i + 1]);
    const key = next?.dataset.nav ?? null;
    const had = listRef.current?.contains(document.activeElement) || Boolean(menu);
    lastNav.current = key;
    lastNavIndex.current = i;
    if (had && key) requestAnimationFrame(() => focusNav(listRef.current?.querySelector<HTMLElement>(`[data-nav="${CSS.escape(key)}"]`) ?? undefined));
  };

  const change = (s: SessionSummary, c: SessionChange) =>
    patchSession(s.id, c).catch((err: unknown) => fail("Couldn't save the change", err));
  const archiveNow = (s: SessionSummary) => {
    handOff(s.id);
    const wasPinned = Boolean(s.pinned);
    void change(s, { archived: true });
    say("Session archived", { undo: { id: s.id, run: () => void change(s, wasPinned ? { archived: false, pinned: true } : { archived: false }) } });
  };
  const afterDelete = (s: SessionSummary, transcript: boolean) => {
    if (finished[s.id]) onUnread?.(s, false);
    onDeleted?.(s.id);
    say(transcript ? "Session and transcript deleted" : "Session deleted");
  };
  const requestArchive = (s: SessionSummary) => (confirmFirst === "both" ? setArchiving(s) : archiveNow(s));
  const requestDelete = (s: SessionSummary) => {
    /* a running session can't go; the dialog says why */
    if (confirmFirst !== "never" || isBusy(s) || s.web?.pending.length) return setDeleting(s);
    handOff(s.id);
    deleteSession(s.id, false).then(
      () => afterDelete(s, false),
      (err: unknown) => fail("Couldn't delete the session", err),
    );
  };
  const startRename = (id: string) => {
    renameDraft.current = null;
    setRenaming(id);
  };

  const menuRef = useRef(menu);
  menuRef.current = menu;
  const closeMenu = useCallback((restoreFocus: boolean) => {
    if (restoreFocus && menuRef.current) focusRow(listRef.current, menuRef.current.id);
    setMenu(null);
  }, []);
  const onAction = (action: RowAction) => {
    if (!menu) return;
    const s = byId.get(menu.id) ?? menu.s;
    if (action === "delete") {
      setMenu(null);
      requestDelete(s);
      return;
    }
    if (action === "rename") {
      setMenu(null);
      startRename(s.id);
      return;
    }
    if (action === "archive" && !s.archived) {
      setMenu(null);
      requestArchive(s);
      return;
    }
    closeMenu(true);
    if (typeof action === "object") {
      const was = s.snoozedUntil && s.snoozedUntil > Date.now() ? s.snoozedUntil : null;
      void change(s, { snoozedUntil: action.snooze });
      say(`Snoozed until ${wakeLabel(action.snooze, Date.now())}`, { undo: { id: s.id, run: () => void change(s, { snoozedUntil: was }) } });
    } else if (action === "wake") void change(s, { snoozedUntil: null });
    else if (action === "pin") void change(s, { pinned: !s.pinned });
    else if (action === "read") onUnread?.(s, !finished[s.id]);
    else if (action === "archive") void change(s, { archived: false });
    else if (action === "link") {
      void copyText(sessionLink(s.id)).then((ok) => say(ok ? "Link copied" : "Couldn't copy the link", { tone: ok ? "success" : "error" }));
    } else if (action === "path") {
      void copyText(s.cwd).then((ok) => say(ok ? "Folder path copied" : "Couldn't copy the folder path", { tone: ok ? "success" : "error" }));
    } else if (action === "id") {
      void copyText(nativeId(s.id)).then((ok) => say(ok ? "Session ID copied" : "Couldn't copy the session ID", { tone: ok ? "success" : "error" }));
    }
  };

  /* Rows get the same callbacks every render; they read the latest state through this ref. */
  const latest = useRef({ byId, change });
  latest.current = { byId, change };
  const onMenu = useCallback(
    (id: string, at: MenuAt) =>
      setMenu((cur) => {
        if (cur?.id === id && at instanceof HTMLElement) return null;
        const s = latest.current.byId.get(id);
        return s ? { id, s, at } : null;
      }),
    [],
  );
  const onRenamed = useCallback((id: string, title: string | null, viaKey: boolean) => {
    setRenaming(null);
    renameDraft.current = null;
    if (viaKey) focusRow(listRef.current, id);
    const s = latest.current.byId.get(id);
    if (title === null || !s) return;
    const t = title.replace(/\s+/g, " ").trim();
    if (t !== s.title) void latest.current.change(s, { title: t || null });
  }, []);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return sortSessions(
      rows.filter((s) => `${s.title} ${s.cwd} ${AGENT_LABEL[s.agent]}`.toLowerCase().includes(q)),
      sort,
    );
  }, [rows, query, sort]);

  /* the open session's folder unfolds when you open it */
  const activeProject = useMemo(() => (sessions ?? []).find((s) => s.id === activeId)?.cwd, [sessions, activeId]);
  useEffect(() => {
    if (activeProject === undefined) return;
    setFolded((cur) => {
      if (!cur.has(activeProject)) return cur;
      const next = new Set(cur);
      next.delete(activeProject);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  useEffect(() => {
    if (searching) searchRef.current?.focus();
  }, [searching]);
  const closeSearch = () => {
    setSearching(false);
    setQuery("");
  };

  const showAgents = agentIcon && agentsPresent.length > 1;
  const timeOf = (ms: number) => (timeStyle === "absolute" ? absoluteTime(ms, now, undefined, timeFmt) : relativeTime(ms, now));
  const row = (s: SessionSummary, where: RowWhere, time?: string) => (
    <Row
      key={s.id}
      id={s.id}
      title={s.title}
      status={sessionStatus(s, Boolean(finished[s.id]))}
      time={time ?? timeOf(sort === "created" ? s.created || s.mtime : s.mtime)}
      agent={showAgents && s.agent !== "claude" ? s.agent : null}
      active={s.id === activeId}
      where={where}
      menuOpen={menu?.id === s.id}
      renaming={renaming === s.id}
      draft={renameDraft}
      onPick={onPick}
      onMenu={onMenu}
      onRenamed={onRenamed}
    />
  );

  const onListKey = (e: ReactKeyEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.altKey || e.nativeEvent.isComposing) return;
    const t = e.target as HTMLElement;
    if (t.closest("input, textarea")) return;
    const item = t.closest<HTMLElement>("[data-nav]");
    if (!item) return;
    const plain = !e.ctrlKey && !e.metaKey && !e.shiftKey;
    const items = navItems();
    const i = items.indexOf(item);
    const to = plain ? rovingTarget(e.key, i, items.length) : null;
    if (to !== null) {
      e.preventDefault();
      focusNav(items[to]);
      return;
    }
    if (plain && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      const expanded = item.getAttribute("aria-expanded");
      if (expanded !== null) {
        e.preventDefault();
        if ((expanded === "true") !== (e.key === "ArrowRight")) item.click();
        else if (e.key === "ArrowRight") focusNav(items[i + 1]);
      } else if (e.key === "ArrowLeft") {
        const owner = item.closest("[data-nav-group]")?.querySelector<HTMLElement>("[data-nav][aria-expanded]");
        if (owner) {
          e.preventDefault();
          focusNav(owner);
        }
      }
      return;
    }
    const s = item.dataset.sessionRow ? byId.get(item.dataset.sessionRow) : undefined;
    if (!s) return;
    if (e.key === "F2" && plain) {
      e.preventDefault();
      startRename(s.id);
    } else if (e.key === "Delete" || (e.key === "Backspace" && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      if (e.shiftKey || s.archived) requestDelete(s);
      else requestArchive(s);
    }
  };

  const shownProjects = allProjects ? projects : projects.filter((p, i) => i < PROJECT_CAP || p.key === activeProject);
  const projectIcons = useProjectIcons(view === "project" ? shownProjects.map((p) => p.key).filter(Boolean) : []);
  const recentGroups = groupRows(recent.slice(0, recentCap), groupBy, now);

  /* rows slide to where they move (a poll reorders them, a pin, a rename under Title sort) */
  const flip = useRef<ReturnType<typeof createFlip> | null>(null);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    flip.current = createFlip(el, { selector: "[data-session-row]", key: (row) => row.dataset.sessionRow, target: (row) => row.parentElement });
    flip.current.update();
    return () => {
      flip.current?.dispose();
      flip.current = null;
    };
  }, []);
  useLayoutEffect(() => flip.current?.update());
  const palette = () => window.dispatchEvent(new Event(OPEN_PALETTE_EVENT));
  const bindings = useBindings();
  const newKey = keysFor("newSession", bindings)[0];
  const searchKey = keysFor("palette", bindings)[0];
  const cap = capCount(projectCap);
  const viewMenu = (
    <ViewMenu
      view={view}
      onView={setView}
      sort={sort}
      onSort={setSort}
      groupBy={groupBy}
      onGroupBy={setGroupBy}
      agents={agentsPresent}
      agent={filter}
      onAgent={setAgentFilter}
      onFilter={() => setSearching(true)}
      onSettings={
        onView &&
        (() => {
          try {
            sessionStorage.setItem(SETTINGS_SECTION_KEY, "sidebar");
          } catch {}
          window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_SECTION_EVENT, { detail: "sidebar" }));
          onView("@settings");
        })
      }
    />
  );
  const navBtn = "relative flex h-8 min-w-0 flex-auto items-center justify-center gap-1.5 rounded-lg px-1.5 text-sm text-ink-2 transition-colors duration-150 hover:bg-sidebar-hover hover:text-ink aria-[current=page]:bg-sidebar-active aria-[current=page]:text-ink pointer-coarse:h-11";
  const emptyKind = sessions === null ? null : sidebarEmpty({ shown: shown.length, awake: awake.length, filtered: filter !== "all" });
  const empty = emptyKind && (
    <EmptyState
      size="inline"
      icon={emptyKind === "snoozed" ? <Alarm width={15} height={15} strokeWidth={1.8} /> : <ChatBubbleEmpty width={15} height={15} strokeWidth={1.8} />}
      {...sidebarEmptyCopy(emptyKind, filter !== "all" ? AGENT_LABEL[filter] : "")}
      actions={[
        emptyKind === "agent"
          ? { label: "Show all", onClick: () => setAgentFilter("all") }
          : emptyKind === "snoozed"
            ? { label: "Show snoozed", onClick: () => setShowSnoozed(true) }
            : { label: "New session", onClick: onNew },
      ]}
    />
  );
  const loadError = error ? sessionsErrorCopy(error, typeof navigator === "undefined" || navigator.onLine) : null;

  return (
    <nav aria-label="Sessions" className="relative flex h-full min-h-0 w-full flex-col">
      <div className="flex h-[52px] shrink-0 items-center gap-0.5 pr-2 pl-4">
        <span className="min-w-0 flex-1 truncate text-base font-semibold tracking-[-0.01em] text-ink">agent-u</span>
        {onCollapse && (
          <IconButton label={collapseLabel} tip={withKeys(collapseLabel, comboFor("sidebar", mod === "⌘", { bindings }))} tipPos="bottom-end" onClick={onCollapse}>
            <SidebarCollapse width={18} height={18} strokeWidth={1.8} aria-hidden />
          </IconButton>
        )}
      </div>

      <div className="flex shrink-0 flex-col gap-1 px-2 pb-1">
        <button
          type="button"
          onClick={onNew}
          className="flex h-8 items-center gap-2 rounded-lg px-2.5 text-sm font-medium text-ink shadow-hairline transition-colors duration-150 hover:bg-sidebar-hover pointer-coarse:h-11"
        >
          <EditPencil width={15} height={15} strokeWidth={1.9} className="shrink-0 text-ink-2" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-left">New session</span>
          {newKey && <Kbd chord={newKey} />}
        </button>
        <button
          type="button"
          onClick={palette}
          className="flex h-8 items-center gap-2 rounded-lg bg-field px-2.5 text-sm text-ink-3 transition-colors duration-150 hover:text-ink-2 pointer-coarse:h-11"
        >
          <Search width={15} height={15} strokeWidth={1.9} className="shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-left">Search</span>
          {searchKey && <Kbd chord={searchKey} />}
        </button>
        {onView && (
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => onView("@inbox")}
              aria-current={activeView === "@inbox" ? "page" : undefined}
              aria-label={inbox ? `Inbox, ${inbox} waiting` : "Inbox"}
              className={navBtn}
            >
              <MailIn width={15} height={15} strokeWidth={1.8} className="shrink-0" aria-hidden />
              <span className="truncate">Inbox</span>
              {inbox > 0 && <span className="shrink-0 rounded-full bg-orange-tint px-1.5 text-2xs leading-[16px] font-medium text-orange-ink tabular-nums">{inbox}</span>}
            </button>
            <button type="button" onClick={() => onView("@agents")} aria-current={activeView === "@agents" ? "page" : undefined} aria-label="Agents and terminals" data-tip="Agents and terminals" className={navBtn}>
              <Terminal width={15} height={15} strokeWidth={1.8} className="shrink-0" aria-hidden />
              <span className="truncate">Agents</span>
            </button>
            <button type="button" onClick={() => onView("@files")} aria-current={activeView === "@files" ? "page" : undefined} className={navBtn}>
              <Folder width={15} height={15} strokeWidth={1.8} className="shrink-0" aria-hidden />
              <span className="truncate">Files</span>
            </button>
          </div>
        )}
      </div>

      {searching && (
        <div className="shrink-0 px-2 pt-1 pb-1">
          <label className="flex h-8 items-center rounded-lg bg-sidebar-hover text-ink-3 focus-within:text-ink-2 pointer-coarse:h-11">
            <Search width={15} height={15} strokeWidth={1.9} className="ml-2.5 shrink-0" aria-hidden />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                /* Enter opens the top match; Escape clears, then folds the field away; Down moves into the list */
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Enter" && matches?.[0]) onPick(matches[0].id);
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  focusNav(navItems()[0]);
                }
                if (e.key === "Escape") {
                  e.stopPropagation();
                  if (query) setQuery("");
                  else setSearching(false);
                }
              }}
              onBlur={() => !query && setSearching(false)}
              type="search"
              enterKeyHint="go"
              placeholder="Filter sessions…"
              name="session-search"
              autoComplete="off"
              aria-label="Filter sessions"
              className="ml-2 min-w-0 flex-1 bg-transparent text-[16px] text-ink outline-none placeholder:text-ink-3 sm:text-sm sm:pointer-coarse:text-[16px] [&::-webkit-search-cancel-button]:hidden"
            />
            <button
              type="button"
              aria-label="Close filter"
              onMouseDown={(e) => e.preventDefault()}
              onClick={closeSearch}
              className="flex size-8 shrink-0 items-center justify-center rounded-control text-ink-3 hover:text-ink pointer-coarse:size-11"
            >
              <Xmark width={14} height={14} strokeWidth={2} aria-hidden />
            </button>
          </label>
        </div>
      )}

      <div
        ref={listRef}
        onKeyDown={onListKey}
        onFocus={(e) => {
          const item = (e.target as HTMLElement).closest<HTMLElement>("[data-nav]");
          if (!item) return;
          lastNav.current = item.dataset.nav ?? null;
          lastNavIndex.current = Math.max(0, navItems().indexOf(item));
          syncStops();
        }}
        className="scroll-quiet scroll-fade min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-2 pb-8"
      >
        {loadError && (
          <EmptyState
            size="inline"
            tone="error"
            className="mb-2"
            icon={<CloudXmark width={15} height={15} strokeWidth={1.8} />}
            {...loadError}
            actions={[{ label: retrying ? "Trying again…" : "Try again", onClick: retry, disabled: retrying }]}
          />
        )}
        {filter !== "all" && !matches && (
          <div className="mb-1 flex h-8 items-center gap-1.5 px-2.5 text-sm text-ink-3">
            <span className="min-w-0 truncate">{AGENT_LABEL[filter]} sessions only</span>
            <button type="button" onClick={() => setAgentFilter("all")} className="tap relative shrink-0 rounded-chip font-medium text-accent-ink hover:underline">
              Show all
            </button>
          </div>
        )}
        {sessions === null && !error && (
          <div className="flex flex-col gap-px pt-8" role="status" aria-label="Loading sessions…">
            {[72, 58, 80, 64, 50, 68, 76].map((w, i) => (
              <div key={i} className="flex h-[34px] items-center px-2.5" style={{ animation: `fade-in 400ms ease ${i * 60}ms both` }}>
                <div className="h-2.5 rounded-full bg-sidebar-hover" style={{ width: `${w}%` }} />
              </div>
            ))}
          </div>
        )}

        {matches ? (
          <section className="mt-1">
            {matches.length ? (
              <>
                <h2 className="flex h-7 items-center px-2.5 text-xs font-medium text-ink-3">{`${matches.length} ${matches.length === 1 ? "match" : "matches"}`}</h2>
                <div className="flex flex-col gap-px">{matches.map((s) => row(s, "match"))}</div>
              </>
            ) : (
              <EmptyState
                size="inline"
                announce
                icon={<Search width={15} height={15} strokeWidth={1.8} />}
                {...noMatchCopy(query, "The filter checks titles, folders and agents. Search also looks inside messages.")}
                actions={[
                  { label: "Search messages", onClick: () => window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT, { detail: { query: query.trim() } })) },
                  { label: "Clear filter", onClick: () => setQuery("") },
                ]}
              />
            )}
          </section>
        ) : (
          sessions !== null && (
            <>
              {pinned.length > 0 && (
                <Section label="Pinned" open={!shut.has("pinned")} onToggle={() => toggleSection("pinned")}>
                  {pinned.map((s) => row(s, "pinned"))}
                </Section>
              )}

              {view === "project" ? (
                <Section label="Projects" open={!shut.has("projects")} onToggle={() => toggleSection("projects")} action={viewMenu}>
                  {shownProjects.map((p) => {
                    const open = !folded.has(p.key);
                    const { shown: list, hidden } = fullProjects.has(p.key) ? { shown: p.rows, hidden: 0 } : capRows(p.rows, cap, activeId);
                    return (
                      <div key={p.key} data-nav-group className="flex flex-col gap-px [&:not(:first-child)]:mt-1.5">
                        <ProjectHeader id={p.key} name={p.name} path={p.key ? shortPath(p.key) : "No folder"} count={p.rows.length} open={open} icon={projectIcons.get(p.key)} onToggle={toggleProject} />
                        {open && (
                          <>
                            {list.map((s) => row(s, "project"))}
                            {(hidden > 0 || fullProjects.has(p.key)) && cap !== null && p.rows.length > cap && (
                              <button type="button" data-nav={`more:${p.key}`} onClick={() => flipFull(p.key)} className="side-row h-7 gap-2.5 text-sm text-ink-3 hover:text-ink-2 pointer-coarse:h-10">
                                <span className="w-1.5 shrink-0" aria-hidden />
                                {hidden > 0 ? `Show ${hidden} more` : "Show less"}
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })}
                  {(projects.length > shownProjects.length || allProjects) && projects.length > PROJECT_CAP && (
                    <button type="button" data-nav="more:projects" onClick={() => setAllProjects((v) => !v)} className="side-row mt-1.5 h-7 gap-1.5 text-xs font-medium text-ink-3 hover:text-ink-2 pointer-coarse:h-10">
                      <MoreHoriz width={12} height={12} strokeWidth={2.2} aria-hidden />
                      {allProjects ? "Fewer projects" : `${projects.length - shownProjects.length} more ${projects.length - shownProjects.length === 1 ? "project" : "projects"}`}
                    </button>
                  )}
                  {empty}
                </Section>
              ) : (
                <Section label="Recent" open={!shut.has("recents")} onToggle={() => toggleSection("recents")} action={viewMenu}>
                  {recentGroups.map(([name, list]) => (
                    <div key={name || "all"} className="flex flex-col gap-px">
                      {name && <h3 className="flex h-7 items-end px-2.5 pb-1 text-xs text-ink-3 [&:not(:first-child)]:mt-2">{name}</h3>}
                      {list.map((s) => row(s, "recent"))}
                    </div>
                  ))}
                  {recent.length > recentCap && (
                    <button type="button" data-nav="more:recent" onClick={() => setRecentCap((c) => c + RECENT_STEP)} className="side-row h-7 gap-2.5 text-sm text-ink-3 hover:text-ink-2 pointer-coarse:h-10">
                      <span className="w-1.5 shrink-0" aria-hidden />
                      Show more
                    </button>
                  )}
                  {empty}
                </Section>
              )}

              {snoozed.length > 0 && (
                <Section label={`Snoozed (${snoozed.length})`} open={showSnoozed} onToggle={() => setShowSnoozed((v) => !v)}>
                  {snoozed.map((s) => row(s, "snoozed", wakeLabel(s.snoozedUntil!, now)))}
                </Section>
              )}

              {archivedOn && archived.length > 0 && (
                <Section label={`Archived (${archived.length})`} open={showArchived} onToggle={() => setShowArchived((v) => !v)}>
                  {archived.map((s) => row(s, "archived"))}
                </Section>
              )}
            </>
          )
        )}
      </div>

      {deleting && (
        <DeleteDialog
          key={deleting.id}
          s={sessions?.find((x) => x.id === deleting.id) ?? deleting}
          onClose={() => {
            setDeleting(null);
            focusRow(listRef.current, deleting.id);
          }}
          onDeleted={(transcript) => {
            setDeleting(null);
            handOff(deleting.id);
            afterDelete(deleting, transcript);
          }}
        />
      )}
      {archiving && (
        <ArchiveDialog
          key={archiving.id}
          s={archiving}
          onClose={() => {
            setArchiving(null);
            focusRow(listRef.current, archiving.id);
          }}
          onArchive={() => {
            setArchiving(null);
            archiveNow(byId.get(archiving.id) ?? archiving);
          }}
        />
      )}
      {menu && <RowMenu key={menu.id} s={byId.get(menu.id) ?? menu.s} at={menu.at} unread={Boolean(finished[menu.id])} onClose={closeMenu} onAction={onAction} />}
      <SessionHoverCard list={listRef} byId={byId} finished={finished} />

      <div className="flex shrink-0 items-center justify-between gap-2 px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <ThemeToggle />
        <span className="flex items-center gap-1">
          <NotifyButton />
          {onView && (
            <IconButton label="Settings" tipPos="bottom-end" onClick={() => onView("@settings")} pressed={activeView === "@settings"}>
              <Settings width={17} height={17} strokeWidth={1.8} aria-hidden />
            </IconButton>
          )}
          <IconButton
            label="Sign out"
            tipPos="bottom-end"
            onClick={() => void signOut()}
          >
            <LogOut width={17} height={17} strokeWidth={1.8} aria-hidden />
          </IconButton>
        </span>
      </div>
    </nav>
  );
});

/* ── collapsed rail ─────────────────────────────────────── */

const RAIL_LIVE_CAP = 8;

/** The collapsed desktop sidebar: expand, new, search, and one mark per open session. */
export function SessionRail({
  sessions,
  activeId,
  onPick,
  onNew,
  onExpand,
  onView,
  inbox = 0,
}: {
  sessions: SessionSummary[] | null;
  activeId: string | null;
  onPick: (id: string) => void;
  onNew: () => void;
  onExpand: () => void;
  onView?: (tab: "@agents" | "@files" | "@inbox" | "@settings") => void;
  inbox?: number;
}) {
  const mod = useModKey();
  const bindings = useBindings();
  const keys = (id: "sidebar" | "newSession" | "palette") => comboFor(id, mod === "⌘", { bindings });
  const now = Date.now();
  const live = (sessions ?? []).filter((s) => isLive(s) && !s.archived && !isAsleep(s, now));
  const shown = live.slice(0, RAIL_LIVE_CAP);
  return (
    <nav aria-label="Sessions" className="flex h-full w-full flex-col items-center">
      <div className="flex h-[52px] shrink-0 items-center">
        <button type="button" aria-label="Open sidebar" data-tip={withKeys("Open sidebar", keys("sidebar"))} data-tip-pos="right" onClick={onExpand} className="icon-btn group/brand">
          <span className="transition-opacity duration-150 group-hover/brand:opacity-0 group-focus-visible/brand:opacity-0">
            <Brand />
          </span>
          <SidebarExpand width={18} height={18} strokeWidth={1.8} aria-hidden className="absolute opacity-0 transition-opacity duration-150 group-hover/brand:opacity-100 group-focus-visible/brand:opacity-100" />
        </button>
      </div>
      <div className="flex flex-col items-center gap-1">
        <IconButton label="New session" tip={withKeys("New session", keys("newSession"))} tipPos="right" onClick={onNew}>
          <EditPencil width={18} height={18} strokeWidth={1.8} aria-hidden />
        </IconButton>
        <IconButton label="Search" tip={withKeys("Search", keys("palette"))} tipPos="right" onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE_EVENT))}>
          <Search width={18} height={18} strokeWidth={1.8} aria-hidden />
        </IconButton>
        {onView && (
          <>
            <IconButton label={inbox ? `Inbox, ${inbox} waiting` : "Inbox"} tip="Inbox" tipPos="right" onClick={() => onView("@inbox")} className="relative">
              <MailIn width={18} height={18} strokeWidth={1.8} aria-hidden />
              {inbox > 0 && <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-orange ring-2 ring-sidebar" aria-hidden />}
            </IconButton>
            <IconButton label="Agents and terminals" tip="Agents and terminals" tipPos="right" onClick={() => onView("@agents")}>
              <Terminal width={18} height={18} strokeWidth={1.8} aria-hidden />
            </IconButton>
            <IconButton label="Files" tip="Files" tipPos="right" onClick={() => onView("@files")}>
              <Folder width={18} height={18} strokeWidth={1.8} aria-hidden />
            </IconButton>
          </>
        )}
      </div>
      {shown.length > 0 && (
        <div className="mt-5 flex flex-col items-center gap-1" role="list" aria-label="Active">
          {shown.map((s) => {
            const waiting = (s.web?.pending.length ?? 0) > 0;
            const on = s.id === activeId;
            const state = waiting ? "needs you" : isBusy(s) ? "working" : "open";
            return (
              <div role="listitem" key={s.id}>
                <button
                  type="button"
                  aria-label={`${s.title}, ${state}`}
                  aria-current={on ? "page" : undefined}
                  data-tip={s.title}
                  data-tip-pos="right"
                  onClick={() => onPick(s.id)}
                  className="icon-btn"
                >
                  <Pulse busy={isBusy(s)} size={3} cellClass={AGENT_TONE[s.agent]} />
                  {waiting && <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-orange ring-2 ring-sidebar" aria-hidden />}
                </button>
              </div>
            );
          })}
          {live.length > shown.length && (
            <button type="button" onClick={onExpand} aria-label={`${live.length - shown.length} more`} data-tip="Show all" data-tip-pos="right" className="icon-btn text-xs font-medium tabular-nums">
              +{live.length - shown.length}
            </button>
          )}
        </div>
      )}
    </nav>
  );
}
