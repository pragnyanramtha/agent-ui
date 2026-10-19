"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Alarm, Archive, Calendar, Check, Clock, EditPencil, Folder, HalfMoon, Hashtag, Link, LogOut, Mail, MailIn, MailOpen, MoreHoriz, NavArrowLeft, NavArrowRight, Pin, PinSlash, Search, Settings, SidebarCollapse, SidebarExpand, SunLight, Terminal, Trash, Xmark } from "iconoir-react";
import { AGENT_LABEL, TRANSCRIPT_DELETABLE, type AgentId, type SessionSummary } from "@/lib/types";
import { api, shortPath, timeAgo } from "@/lib/client/api";
import { deleteSession, patchSession, type SessionChange } from "@/lib/client/useSessions";
import type { Finished } from "@/lib/client/useFinished";
import { terminalBusy } from "@/lib/status";
import { sessionStatus, STATUS_LABEL, type SessionStatus } from "@/lib/client/session-status";
import { snoozePresets, wakeFull, wakeLabel } from "@/lib/client/snooze";
import { OPEN_PALETTE_EVENT } from "./CommandPalette";
import { Pulse } from "./Pulse";
import { ThemeToggle } from "./ThemeToggle";
import { NotifyButton } from "./NotifyButton";
import { copyText } from "./CodeCard";
import { primaryBtn, secondaryBtn, Sheet } from "./Sheet";

/* ─────────────────────────────────────────────────────────
 * SIDEBAR
 * A quiet, ChatGPT-like list: brand row with search and the
 * collapse toggle, "New session", then Pinned, Active, Projects,
 * Recent and Archived. Rows are one line; detail lives in the
 * hover title, actions in the row menu (right-click or "...").
 * Grouping and the agent filter sit in the Recent overflow.
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
  return <span className="shrink-0 text-[12px] text-ink-3">{AGENT_LABEL[agent]}</span>;
}

const ago = (ms: number, now: number) => {
  const t = timeAgo(ms, now);
  return t === "now" ? "just now" : /\d$/.test(t) ? `on ${t}` : `${t} ago`;
};

/** The hover title: the full name, the folder, and when (or that it's open). */
const rowTitle = (s: SessionSummary, now: number) =>
  `${s.title}\n${s.project || "No folder"} · ${isLive(s) ? "open" : ago(s.mtime, now)}${s.agent !== "claude" ? ` · ${AGENT_LABEL[s.agent]}` : ""}${
    (s.snoozedUntil ?? 0) > now ? `\nSnoozed until ${wakeFull(s.snoozedUntil!)}` : ""
  }`;

/** Snoozed and quiet: out of the main lists. A session that's working or waiting on you always shows. */
export const isAsleep = (s: SessionSummary, now: number) => (s.snoozedUntil ?? 0) > now && !s.archived && !isBusy(s) && !s.web?.pending.length;

/** The id the agent itself knows the session by ("codex:abc" is abc), for its own resume command. */
export const nativeId = (id: string) => id.slice(id.indexOf(":") + 1);

/** The address that opens a session, the same one notifications use. */
export const sessionLink = (id: string) => `${window.location.origin}/?s=${encodeURIComponent(id)}`;

/** Ctrl or ⌘, read after mount so the server render matches. */
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

/** Which list a row sits in: a session shows in Projects and in Pinned, Active or Recent at once. */
type RowWhere = "match" | "pinned" | "live" | "project" | "recent" | "snoozed" | "archived";

/* Pinned, Active and Recent never list a session twice: a rename follows its row between them when the poll moves it */
const MAIN_LISTS: RowWhere[] = ["pinned", "live", "recent"];

/** What a row needs to open its menu (keyed by `${where}:${id}`) and to rename in place. */
type RowControl = {
  menuFor: string | null;
  renaming: { id: string; where: RowWhere } | null;
  /** the text typed so far, so a field that moved with its row carries on */
  draft: { current: string | null };
  openMenu: (s: SessionSummary, at: MenuAt, where: RowWhere) => void;
  rename: (s: SessionSummary, where: RowWhere, title: string | null, viaKey: boolean) => void;
  /** finished a turn this device hasn't opened since */
  unread: (id: string) => boolean;
};

/** Focus a row after a re-render: the same list if it's still there, else wherever it moved. */
const focusRow = (id: string, where?: RowWhere) =>
  requestAnimationFrame(() => {
    const all = [...document.querySelectorAll<HTMLElement>(`[data-session-row="${CSS.escape(id)}"]`)].filter((el) => el.offsetParent !== null);
    (all.find((el) => el.dataset.rowWhere === where) ?? all[0])?.focus({ preventScroll: true });
  });

function Row({
  s,
  active,
  onPick,
  now,
  lead,
  indent,
  showAgent = true,
  ctl,
  where,
  trail,
}: {
  s: SessionSummary;
  active: boolean;
  onPick: (id: string) => void;
  now: number;
  lead?: ReactNode;
  indent?: boolean;
  showAgent?: boolean;
  ctl: RowControl;
  where: RowWhere;
  /** stands in for the agent's name at the end of a quiet row */
  trail?: string;
}) {
  const status = sessionStatus(s, ctl.unread(s.id));
  const key = `${where}:${s.id}`;
  const r = ctl.renaming;
  if (r?.id === s.id && (r.where === where || (MAIN_LISTS.includes(r.where) && MAIN_LISTS.includes(where))))
    return <RenameRow s={s} lead={lead} indent={indent} draft={ctl.draft} onDone={(t, viaKey) => ctl.rename(s, where, t, viaKey)} />;
  const menuOpen = ctl.menuFor === key;
  /* the "..." button takes the trailing label's place on hover */
  const tail = menuOpen ? "hidden" : "pointer-fine:group-hover/item:hidden pointer-fine:group-focus-within/item:hidden";
  const agentLabel = trail ? (
    <span className={`shrink-0 text-[12px] text-ink-3 tabular-nums ${tail}`}>{trail}</span>
  ) : (
    showAgent && s.agent !== "claude" && <span className={`shrink-0 text-[12px] text-ink-3 ${tail}`}>{AGENT_LABEL[s.agent]}</span>
  );
  return (
    <div
      className="group/item relative"
      onContextMenu={(e) => {
        e.preventDefault();
        /* the context-menu key reports no position: anchor to the row */
        ctl.openMenu(s, e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : e.currentTarget, where);
      }}
    >
      <button
        type="button"
        data-session-row={s.id}
        data-row-where={where}
        onClick={() => onPick(s.id)}
        aria-current={active ? "page" : undefined}
        title={rowTitle(s, now)}
        className={`side-row pointer-coarse:pr-12 pointer-fine:group-focus-within/item:pr-9 pointer-fine:group-hover/item:pr-9 ${menuOpen ? "pr-9" : ""} ${indent ? "pl-[34px]" : ""}`}
      >
        {lead}
        <span className="min-w-0 flex-1 truncate">{s.title}</span>
        {status === "unread" ? (
          <>
            {agentLabel}
            <span className={`flex size-4 shrink-0 items-center justify-center ${tail}`}>
              <span className="size-1.5 rounded-full bg-green" aria-hidden />
              <span className="sr-only">, {STATUS_LABEL.unread.toLowerCase()}</span>
            </span>
          </>
        ) : status ? (
          <StatusPill status={status} className={tail} />
        ) : (
          agentLabel
        )}
      </button>
      <button
        type="button"
        aria-label={`Options for ${s.title}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={(e) => ctl.openMenu(s, e.currentTarget, where)}
        className={`absolute top-1/2 right-1 flex size-7 -translate-y-1/2 items-center justify-center rounded-control text-ink-3 transition-[background-color,color,opacity] duration-150 hover:bg-sidebar-active hover:text-ink focus-visible:opacity-100 group-hover/item:opacity-100 group-focus-within/item:opacity-100 pointer-coarse:size-9 pointer-coarse:opacity-100 ${menuOpen ? "bg-sidebar-active text-ink opacity-100" : "opacity-0"}`}
      >
        <MoreHoriz width={16} height={16} strokeWidth={2} aria-hidden />
      </button>
    </div>
  );
}

const PILL_TONE: Record<Exclude<SessionStatus, "unread">, { text: string; dot: string }> = {
  approval: { text: "font-medium text-orange-ink", dot: "bg-orange" },
  input: { text: "font-medium text-accent-ink", dot: "bg-accent" },
  working: { text: "text-ink-3", dot: "bg-accent motion-safe:animate-pulse" },
  failed: { text: "font-medium text-red-ink", dot: "bg-red" },
};

function StatusPill({ status, className = "" }: { status: Exclude<SessionStatus, "unread">; className?: string }) {
  const tone = PILL_TONE[status];
  return (
    <span className={`flex shrink-0 items-center gap-1.5 text-[12px] ${tone.text} ${className}`}>
      <span className={`size-1.5 rounded-full ${tone.dot}`} aria-hidden />
      {STATUS_LABEL[status]}
    </span>
  );
}

/** The row as a text field: Enter saves, Escape cancels, leaving the field saves. Empty brings the original name back. */
function RenameRow({
  s,
  lead,
  indent,
  draft,
  onDone,
}: {
  s: SessionSummary;
  lead?: ReactNode;
  indent?: boolean;
  draft: { current: string | null };
  onDone: (title: string | null, viaKey: boolean) => void;
}) {
  const [resumed] = useState(() => draft.current !== null);
  const [value, setValue] = useState(() => draft.current ?? s.title);
  const done = useRef(false);
  /* a field that unmounts because its row moved must not save what it had (a blur on removal would) */
  useLayoutEffect(() => {
    done.current = false;
    return () => {
      done.current = true;
    };
  }, []);
  const finish = (title: string | null, viaKey: boolean) => {
    if (done.current) return;
    done.current = true;
    onDone(title, viaKey);
  };
  return (
    <div className={`side-row bg-sidebar-hover shadow-[inset_0_0_0_1.5px_var(--accent)] ${indent ? "pl-[34px]" : ""}`}>
      {lead}
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
        className="min-w-0 flex-1 bg-transparent text-[16px] text-ink outline-none sm:text-[14px] sm:pointer-coarse:text-[16px]"
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
  const when = (text: string) => <span className="shrink-0 text-[12px] text-ink-3 tabular-nums">{text}</span>;
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
      <p className="text-[13.5px] leading-relaxed text-ink-2">
        <span className="font-medium text-ink [overflow-wrap:anywhere]">{s.title}</span> leaves the list on every device. This can&apos;t be undone.
      </p>
      {fileOk ? (
        <label className={`mt-3 flex items-start gap-2.5 text-[13.5px] leading-snug ${inTerminal ? "text-ink-3" : "text-ink"}`}>
          <input
            type="checkbox"
            checked={transcript && !inTerminal}
            disabled={inTerminal || busy}
            onChange={(e) => setTranscript(e.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-[var(--color-red)]"
          />
          <span>
            Also delete the transcript file
            <span className="mt-0.5 block text-[12.5px] text-ink-3">
              {inTerminal ? "It's open in a terminal, so the file stays." : transcript ? `Removes the history from ${agent}'s own storage too.` : `Otherwise the history stays in ${agent}'s own storage.`}
            </span>
          </span>
        </label>
      ) : (
        <p className="mt-2 text-[13px] leading-relaxed text-ink-3">The history stays in {agent}&apos;s own storage.</p>
      )}
      {running && (
        <p className="mt-3 rounded-control bg-orange-tint px-2.5 py-2 text-[13px] text-orange-ink">
          {(s.web?.pending.length ?? 0) > 0 ? "It's waiting on you. Answer or stop it first." : "It's running. Stop it first."}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 rounded-control bg-red-tint px-2.5 py-2 text-[13px] text-red-ink">
          {error}
        </p>
      )}
    </Sheet>
  );
}

const PulseSlot = ({ s }: { s: SessionSummary }) => (
  <span className="flex size-4 shrink-0 items-center justify-center">
    <Pulse busy={isBusy(s)} size={2.5} cellClass={AGENT_TONE[s.agent]} />
  </span>
);

const PinSlot = () => (
  <span className="flex size-4 shrink-0 items-center justify-center text-ink-3">
    <Pin width={13} height={13} strokeWidth={1.9} aria-hidden />
  </span>
);

/* ── sections ───────────────────────────────────────────── */

function Section({
  label,
  open,
  onToggle,
  action,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="group/section mt-5 first:mt-1">
      <div className="flex h-8 items-center gap-1 pr-1">
        <h2 className="min-w-0 flex-1">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="group/label flex h-8 w-full items-center gap-1 rounded-control px-2.5 text-left text-[13px] text-ink-3 transition-colors duration-150 hover:text-ink-2 focus-visible:outline-offset-[-2px]"
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

type RecentsGroup = "none" | "time" | "agent";
const GROUPS: readonly RecentsGroup[] = ["none", "time", "agent"];
const GROUP_LABEL: Record<RecentsGroup, string> = { none: "None", time: "Date", agent: "Agent" };

function timeBucket(ms: number, now: number) {
  const day = (t: number) => new Date(new Date(t).toDateString()).getTime();
  const d = Math.round((day(now) - day(ms)) / 86_400_000);
  return d <= 0 ? "Today" : d === 1 ? "Yesterday" : d < 7 ? "This week" : d < 31 ? "This month" : "Older";
}

function groupRows(rows: SessionSummary[], by: RecentsGroup, now: number): [string, SessionSummary[]][] {
  if (by === "none") return [["", rows]];
  const groups = new Map<string, SessionSummary[]>();
  for (const s of rows) {
    const key = by === "time" ? timeBucket(s.mtime, now) : AGENT_LABEL[s.agent];
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  return [...groups.entries()];
}

type Project = { key: string; name: string; path: string; rows: SessionSummary[]; newest: number };

/** Sessions by folder, newest folder first. */
function groupProjects(rows: SessionSummary[]): Project[] {
  const m = new Map<string, Project>();
  for (const s of rows) {
    const key = s.cwd || "";
    const p = m.get(key) ?? { key, name: s.project || "No folder", path: s.cwd ? shortPath(s.cwd) : "No folder", rows: [], newest: 0 };
    p.rows.push(s);
    p.newest = Math.max(p.newest, s.mtime);
    m.set(key, p);
  }
  return [...m.values()].sort((a, b) => b.newest - a.newest);
}

/** The Recent overflow: grouping, the agent filter, and the inline filter. */
function ViewMenu({
  groupBy,
  onGroupBy,
  agents,
  agent,
  onAgent,
  onFilter,
}: {
  groupBy: RecentsGroup;
  onGroupBy: (g: RecentsGroup) => void;
  agents: AgentId[];
  agent: AgentId | "all";
  onAgent: (a: AgentId | "all") => void;
  onFilter: () => void;
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
  }, [open]);
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus({ preventScroll: true });
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
  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-label="View options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`flex size-7 items-center justify-center rounded-control text-ink-3 transition-[background-color,color,opacity] duration-150 hover:bg-sidebar-hover hover:text-ink group-hover/section:opacity-100 focus-visible:opacity-100 pointer-coarse:size-9 pointer-coarse:opacity-100 ${open ? "bg-sidebar-hover text-ink opacity-100" : "opacity-0"}`}
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
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            e.preventDefault();
            const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
            const i = items.indexOf(document.activeElement as HTMLElement);
            items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
          }}
          className="z-50 w-52 rounded-[12px] bg-surface p-1 shadow-overlay"
          style={{ animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both", ...place, visibility: place.position ? "visible" : "hidden" }}
        >
          <button type="button" role="menuitem" onClick={pick(onFilter)} className="menu-item">
            <Search width={14} height={14} strokeWidth={1.9} className="shrink-0 text-ink-3" aria-hidden />
            <span className="min-w-0 flex-1 truncate">Filter list…</span>
          </button>
          <div className="mx-2 my-1 h-px bg-line" />
          <div className="px-2 pt-1 pb-0.5 text-[12px] text-ink-3">Group by</div>
          {GROUPS.map((g) => item(groupBy === g, GROUP_LABEL[g], () => onGroupBy(g)))}
          {agents.length > 1 && (
            <>
              <div className="mx-2 my-1 h-px bg-line" />
              <div className="px-2 pt-1 pb-0.5 text-[12px] text-ink-3">Show</div>
              {item(agent === "all", "All agents", () => onAgent("all"))}
              {agents.map((a) => item(agent === a, AGENT_LABEL[a], () => onAgent(a)))}
            </>
          )}
        </div>,
          document.body,
        )}
    </div>
  );
}

const PROJECT_CAP = 6;
const PROJECT_ROWS_CAP = 8;
const RECENT_STEP = 40;

type SectionKey = "pinned" | "live" | "projects" | "recents";
const UNDO_MS = 5000;
const NONE_FINISHED: Finished = {};

export function SessionList({
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
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const [groupBy, setGroupBy] = useStored<RecentsGroup>("cui:recentsGroup", "none", GROUPS);
  const [agentFilter, setAgentFilter] = useStored<AgentId | "all">("cui:agent", "all");
  const [shut, setShut] = useState<Set<SectionKey>>(new Set());
  const [openProjects, setOpenProjects] = useState<Set<string>>(new Set());
  const [fullProjects, setFullProjects] = useState<Set<string>>(new Set());
  const [allProjects, setAllProjects] = useState(false);
  const [recentCap, setRecentCap] = useState(RECENT_STEP);
  /* bumped when the next snooze runs out, so the session comes back on time */
  const [, setWoke] = useState(0);
  const now = Date.now();

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("cui:sidebarShut") ?? "[]") as SectionKey[];
      if (Array.isArray(saved)) setShut(new Set(saved));
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
  const flip = (set: (fn: (s: Set<string>) => Set<string>) => void, key: string) =>
    set((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const agentsPresent = useMemo(() => [...new Set((sessions ?? []).map((s) => s.agent))], [sessions]);
  const filter = agentsPresent.includes(agentFilter as AgentId) ? agentFilter : "all";
  const rows = useMemo(() => (sessions ?? []).filter((s) => filter === "all" || s.agent === filter), [sessions, filter]);
  /* archived rows only show under Archived; pinned ones sit in Pinned instead of Active and Recent */
  const shown = useMemo(() => rows.filter((s) => !s.archived), [rows]);
  const archived = useMemo(() => rows.filter((s) => s.archived), [rows]);
  const awake = shown.filter((s) => !isAsleep(s, now));
  const snoozed = shown.filter((s) => isAsleep(s, now)).sort((a, b) => a.snoozedUntil! - b.snoozedUntil!);
  const pinned = awake.filter((s) => s.pinned);
  const live = awake.filter((s) => isLive(s) && !s.pinned);
  const recent = awake.filter((s) => !isLive(s) && !s.pinned);
  const nextWake = snoozed[0]?.snoozedUntil;
  useEffect(() => {
    if (!nextWake) return;
    /* setTimeout tops out near 24.8 days; a far wake just checks again then */
    const t = setTimeout(() => setWoke((n) => n + 1), Math.min(Math.max(0, nextWake - Date.now()) + 50, 2 ** 31 - 1));
    return () => clearTimeout(t);
  }, [nextWake]);
  const projects = useMemo(() => groupProjects(shown), [shown]);

  const [menu, setMenu] = useState<{ s: SessionSummary; at: MenuAt; where: RowWhere } | null>(null);
  const [renaming, setRenaming] = useState<RowControl["renaming"]>(null);
  const renameDraft = useRef<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [deleting, setDeleting] = useState<SessionSummary | null>(null);
  const closeDelete = useCallback(() => setDeleting(null), []);
  const [toast, setToast] = useState<{ text: string; undo?: () => void; n: number } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast((cur) => (cur === toast ? null : cur)), UNDO_MS);
    return () => clearTimeout(t);
  }, [toast]);
  const say = (text: string, undo?: () => void) => setToast((cur) => ({ text, undo, n: (cur?.n ?? 0) + 1 }));

  const change = (s: SessionSummary, c: SessionChange) =>
    patchSession(s.id, c).catch((err: unknown) => say(`Couldn't save: ${err instanceof Error ? err.message : String(err)}`));
  const menuRef = useRef(menu);
  menuRef.current = menu;
  const closeMenu = useCallback((restoreFocus: boolean) => {
    const cur = menuRef.current;
    if (cur && restoreFocus) {
      if (cur.at instanceof HTMLElement && cur.at.isConnected && cur.at.tagName === "BUTTON") cur.at.focus({ preventScroll: true });
      else focusRow(cur.s.id, cur.where);
    }
    setMenu(null);
  }, []);
  const onAction = (action: RowAction) => {
    if (!menu) return;
    const { s, where } = menu;
    if (action === "delete") {
      setMenu(null);
      setDeleting(s);
      return;
    }
    if (action === "rename") {
      setMenu(null);
      renameDraft.current = null;
      setRenaming({ id: s.id, where });
      return;
    }
    closeMenu(true);
    if (typeof action === "object") {
      const was = s.snoozedUntil && s.snoozedUntil > Date.now() ? s.snoozedUntil : null;
      void change(s, { snoozedUntil: action.snooze });
      say(`Snoozed until ${wakeLabel(action.snooze, Date.now())}.`, () => void change(s, { snoozedUntil: was }));
    } else if (action === "wake") void change(s, { snoozedUntil: null });
    else if (action === "pin") void change(s, { pinned: !s.pinned });
    else if (action === "read") onUnread?.(s, !finished[s.id]);
    else if (action === "archive" && s.archived) void change(s, { archived: false });
    else if (action === "archive") {
      const wasPinned = Boolean(s.pinned);
      void change(s, { archived: true });
      say("Archived.", () => void change(s, wasPinned ? { archived: false, pinned: true } : { archived: false }));
    } else if (action === "link") {
      void copyText(sessionLink(s.id)).then((ok) => say(ok ? "Link copied." : "Couldn't copy the link."));
    } else if (action === "path") {
      void copyText(s.cwd).then((ok) => say(ok ? "Folder path copied." : "Couldn't copy the folder path."));
    } else if (action === "id") {
      void copyText(nativeId(s.id)).then((ok) => say(ok ? "Session ID copied." : "Couldn't copy the session ID."));
    }
  };
  const ctl: RowControl = {
    menuFor: menu ? `${menu.where}:${menu.s.id}` : null,
    renaming,
    draft: renameDraft,
    openMenu: (s, at, where) => setMenu((cur) => (cur?.s.id === s.id && cur.where === where && at instanceof HTMLElement ? null : { s, at, where })),
    rename: (s, where, title, viaKey) => {
      setRenaming(null);
      renameDraft.current = null;
      if (viaKey) focusRow(s.id, where);
      if (title === null) return;
      const t = title.replace(/\s+/g, " ").trim();
      if (t !== s.title) void change(s, { title: t || null });
    },
    unread: (id) => Boolean(finished[id]),
  };
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return rows.filter((s) => `${s.title} ${s.cwd} ${AGENT_LABEL[s.agent]}`.toLowerCase().includes(q));
  }, [rows, query]);

  /* the active session's folder opens by itself */
  const activeProject = useMemo(() => (sessions ?? []).find((s) => s.id === activeId)?.cwd, [sessions, activeId]);
  useEffect(() => {
    if (activeProject === undefined) return;
    setOpenProjects((cur) => (cur.has(activeProject) ? cur : new Set(cur).add(activeProject)));
  }, [activeProject]);

  useEffect(() => {
    if (searching) searchRef.current?.focus();
  }, [searching]);
  const closeSearch = () => {
    setSearching(false);
    setQuery("");
  };

  const shownProjects = allProjects ? projects : projects.filter((p, i) => i < PROJECT_CAP || p.key === activeProject);
  const recentGroups = groupRows(recent.slice(0, recentCap), groupBy, now);
  const palette = () => window.dispatchEvent(new Event(OPEN_PALETTE_EVENT));

  return (
    <nav aria-label="Sessions" className="relative flex h-full min-h-0 w-full flex-col">
      <div className="flex h-[52px] shrink-0 items-center gap-0.5 pr-2 pl-3.5">
        <Brand />
        <span className="ml-2 min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.015em] text-ink">agent-u</span>
        <IconButton label="Search" tip={`Search  ${mod} K`} onClick={palette}>
          <Search width={18} height={18} strokeWidth={1.8} aria-hidden />
        </IconButton>
        {onCollapse && (
          <IconButton label={collapseLabel} tip={`${collapseLabel}  ${mod} B`} tipPos="bottom-end" onClick={onCollapse}>
            <SidebarCollapse width={18} height={18} strokeWidth={1.8} aria-hidden />
          </IconButton>
        )}
      </div>

      <div className="shrink-0 px-2 pb-1">
        <button type="button" onClick={onNew} className="side-row group/new">
          <EditPencil width={17} height={17} strokeWidth={1.8} className="shrink-0 text-ink-2" aria-hidden />
          <span className="min-w-0 flex-1 truncate">New session</span>
          <kbd className="hidden shrink-0 font-sans text-[12px] text-ink-3 opacity-0 transition-opacity duration-150 group-hover/new:opacity-100 group-focus-visible/new:opacity-100 pointer-fine:inline" aria-hidden>
            Alt T
          </kbd>
        </button>
        {onView && (
          <>
            <button type="button" onClick={() => onView("@inbox")} aria-current={activeView === "@inbox" ? "page" : undefined} className="side-row">
              <MailIn width={17} height={17} strokeWidth={1.8} className="shrink-0 text-ink-2" aria-hidden />
              <span className="min-w-0 flex-1 truncate">Inbox</span>
              {inbox > 0 && <span className="shrink-0 rounded-full bg-orange-tint px-1.5 text-[11.5px] font-medium text-orange-ink tabular-nums">{inbox}</span>}
            </button>
            <button type="button" onClick={() => onView("@agents")} aria-current={activeView === "@agents" ? "page" : undefined} className="side-row">
              <Terminal width={17} height={17} strokeWidth={1.8} className="shrink-0 text-ink-2" aria-hidden />
              <span className="min-w-0 flex-1 truncate">Agents and terminals</span>
            </button>
            <button type="button" onClick={() => onView("@files")} aria-current={activeView === "@files" ? "page" : undefined} className="side-row">
              <Folder width={17} height={17} strokeWidth={1.8} className="shrink-0 text-ink-2" aria-hidden />
              <span className="min-w-0 flex-1 truncate">Files</span>
            </button>
          </>
        )}
      </div>

      {searching && (
        <div className="shrink-0 px-2 pb-1">
          <label className="flex h-[34px] items-center rounded-control bg-sidebar-hover text-ink-3 focus-within:text-ink-2 pointer-coarse:h-10">
            <Search width={15} height={15} strokeWidth={1.9} className="ml-2.5 shrink-0" aria-hidden />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                /* Enter opens the top match; Escape clears, then folds the field away */
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Enter" && matches?.[0]) onPick(matches[0].id);
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
              className="ml-2 min-w-0 flex-1 bg-transparent text-[16px] text-ink outline-none placeholder:text-ink-3 sm:text-[14px] sm:pointer-coarse:text-[16px] [&::-webkit-search-cancel-button]:hidden"
            />
            <button
              type="button"
              aria-label="Close filter"
              onMouseDown={(e) => e.preventDefault()}
              onClick={closeSearch}
              className="flex size-8 shrink-0 items-center justify-center rounded-control text-ink-3 hover:text-ink"
            >
              <Xmark width={14} height={14} strokeWidth={2} aria-hidden />
            </button>
          </label>
        </div>
      )}

      <div className="scroll-quiet scroll-fade min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-2 pb-5">
        {error && (
          <p role="alert" className="mx-0.5 mb-2 rounded-control bg-red-tint px-2.5 py-2 text-[13px] text-red-ink">
            Couldn&apos;t load sessions: {error}
          </p>
        )}
        {filter !== "all" && !matches && (
          <div className="mb-1 flex h-8 items-center gap-1.5 px-2.5 text-[13px] text-ink-3">
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
            <h2 className="flex h-8 items-center px-2.5 text-[13px] text-ink-3">
              {matches.length ? `${matches.length} ${matches.length === 1 ? "match" : "matches"}` : "No matches"}
            </h2>
            {matches.length ? (
              <div className="flex flex-col gap-px">
                {matches.map((s) => (
                  <Row key={s.id} s={s} active={s.id === activeId} onPick={onPick} now={now} ctl={ctl} where="match" lead={isLive(s) ? <PulseSlot s={s} /> : undefined} />
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-start gap-1 px-2.5 py-1">
                <p className="text-[13px] text-ink-3">
                  Nothing matches <span className="text-ink-2">“{query.trim()}”</span>.
                </p>
                <button type="button" onClick={() => setQuery("")} className="tap relative rounded-chip text-[13px] font-medium text-accent-ink hover:underline">
                  Clear filter
                </button>
              </div>
            )}
          </section>
        ) : (
          sessions !== null && (
            <>
              {pinned.length > 0 && (
                <Section label="Pinned" open={!shut.has("pinned")} onToggle={() => toggleSection("pinned")}>
                  {pinned.map((s) => (
                    <Row key={s.id} s={s} active={s.id === activeId} onPick={onPick} now={now} ctl={ctl} where="pinned" lead={isLive(s) ? <PulseSlot s={s} /> : <PinSlot />} />
                  ))}
                </Section>
              )}

              {live.length > 0 && (
                <Section label="Active" open={!shut.has("live")} onToggle={() => toggleSection("live")}>
                  {live.map((s) => (
                    <Row key={s.id} s={s} active={s.id === activeId} onPick={onPick} now={now} ctl={ctl} where="live" lead={<PulseSlot s={s} />} />
                  ))}
                </Section>
              )}

              {projects.length > 0 && (
                <Section label="Projects" open={!shut.has("projects")} onToggle={() => toggleSection("projects")}>
                  {shownProjects.map((p) => {
                    const open = openProjects.has(p.key);
                    const full = fullProjects.has(p.key);
                    const list = full ? p.rows : p.rows.slice(0, PROJECT_ROWS_CAP);
                    return (
                      <div key={p.key} className="flex flex-col gap-px">
                        <button type="button" onClick={() => flip(setOpenProjects, p.key)} aria-expanded={open} title={p.path} className="side-row group/row">
                          <span className="relative flex size-[18px] shrink-0 items-center justify-center text-ink-2">
                            <Folder width={17} height={17} strokeWidth={1.7} aria-hidden className="transition-opacity duration-150 group-hover/row:opacity-0 group-focus-visible/row:opacity-0" />
                            <NavArrowRight
                              width={14}
                              height={14}
                              strokeWidth={2}
                              aria-hidden
                              className={`absolute opacity-0 transition-[opacity,transform] duration-150 group-hover/row:opacity-100 group-focus-visible/row:opacity-100 ${open ? "rotate-90" : ""}`}
                            />
                          </span>
                          <span className="min-w-0 flex-1 truncate">{p.name}</span>
                          <span className="shrink-0 text-[12px] tabular-nums text-ink-3">{p.rows.length}</span>
                        </button>
                        {open &&
                          (p.rows.length ? (
                            <>
                              {list.map((s) => (
                                <Row key={s.id} s={s} indent active={s.id === activeId} onPick={onPick} now={now} ctl={ctl} where="project" />
                              ))}
                              {p.rows.length > list.length && (
                                <button type="button" onClick={() => flip(setFullProjects, p.key)} className="side-row pl-[34px] text-[13px] text-ink-3">
                                  Show {p.rows.length - list.length} more
                                </button>
                              )}
                            </>
                          ) : (
                            <p className="flex h-8 items-center pl-[34px] text-[13px] text-ink-3">No sessions</p>
                          ))}
                      </div>
                    );
                  })}
                  {projects.length > shownProjects.length || allProjects ? (
                    projects.length > PROJECT_CAP && (
                      <button type="button" onClick={() => setAllProjects((v) => !v)} className="side-row text-[13px] text-ink-3">
                        <span className="flex size-[18px] shrink-0 items-center justify-center">
                          <MoreHoriz width={16} height={16} strokeWidth={2} aria-hidden />
                        </span>
                        {allProjects ? "Show fewer" : `${projects.length - shownProjects.length} more`}
                      </button>
                    )
                  ) : null}
                </Section>
              )}

              <Section
                label="Recent"
                open={!shut.has("recents")}
                onToggle={() => toggleSection("recents")}
                action={
                  <ViewMenu
                    groupBy={groupBy}
                    onGroupBy={setGroupBy}
                    agents={agentsPresent}
                    agent={filter}
                    onAgent={setAgentFilter}
                    onFilter={() => setSearching(true)}
                  />
                }
              >
                {recentGroups.map(([name, list]) => (
                  <div key={name || "all"} className="flex flex-col gap-px">
                    {name && <h3 className="flex h-7 items-end px-2.5 pb-1 text-[12px] text-ink-3 [&:not(:first-child)]:mt-2">{name}</h3>}
                    {list.map((s) => (
                      <Row key={s.id} s={s} active={s.id === activeId} onPick={onPick} now={now} ctl={ctl} where="recent" showAgent={groupBy !== "agent"} />
                    ))}
                  </div>
                ))}
                {recent.length > recentCap && (
                  <button type="button" onClick={() => setRecentCap((c) => c + RECENT_STEP)} className="side-row text-[13px] text-ink-3">
                    Show more
                  </button>
                )}
                {!recent.length && (!shown.length || live.length > 0 || snoozed.length > 0) && (
                  <p className="px-2.5 py-1.5 text-[13px] text-ink-3">
                    {!shown.length ? (filter !== "all" ? `No ${AGENT_LABEL[filter]} sessions yet.` : "No sessions yet.") : snoozed.length ? "The rest are snoozed." : "All sessions are active."}
                  </p>
                )}
              </Section>

              {snoozed.length > 0 && (
                <Section label={`Snoozed (${snoozed.length})`} open={showSnoozed} onToggle={() => setShowSnoozed((v) => !v)}>
                  {snoozed.map((s) => (
                    <Row key={s.id} s={s} active={s.id === activeId} onPick={onPick} now={now} ctl={ctl} where="snoozed" trail={wakeLabel(s.snoozedUntil!, now)} />
                  ))}
                </Section>
              )}

              {archived.length > 0 && (
                <Section label={`Archived (${archived.length})`} open={showArchived} onToggle={() => setShowArchived((v) => !v)}>
                  {archived.map((s) => (
                    <Row key={s.id} s={s} active={s.id === activeId} onPick={onPick} now={now} ctl={ctl} where="archived" />
                  ))}
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
          onClose={closeDelete}
          onDeleted={(transcript) => {
            setDeleting(null);
            if (finished[deleting.id]) onUnread?.(deleting, false);
            onDeleted?.(deleting.id);
            say(transcript ? "Session and transcript deleted." : "Session deleted.");
          }}
        />
      )}
      {menu && <RowMenu key={`${menu.where}:${menu.s.id}`} s={menu.s} at={menu.at} unread={Boolean(finished[menu.s.id])} onClose={closeMenu} onAction={onAction} />}

      <div role="status" aria-live="polite" className="pointer-events-none absolute inset-x-2 bottom-[60px] z-20 flex justify-center pb-[env(safe-area-inset-bottom)]">
        {toast && (
          <div
            key={toast.n}
            className="pointer-events-auto flex max-w-full items-center gap-3 rounded-[10px] bg-ink py-1.5 pr-1.5 pl-3 text-[13px] text-page shadow-overlay"
            style={{ animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both" }}
          >
            <span className="min-w-0 truncate">{toast.text}</span>
            {toast.undo ? (
              <button
                type="button"
                onClick={() => {
                  toast.undo?.();
                  setToast(null);
                }}
                className="shrink-0 rounded-control px-2 py-1 font-medium hover:bg-white/15 focus-visible:outline-offset-0"
              >
                Undo
              </button>
            ) : (
              <span className="w-1.5" aria-hidden />
            )}
          </div>
        )}
      </div>

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
            onClick={async () => {
              await api("/api/auth/logout", {}).catch(() => undefined);
              window.location.href = "/login";
            }}
          >
            <LogOut width={17} height={17} strokeWidth={1.8} aria-hidden />
          </IconButton>
        </span>
      </div>
    </nav>
  );
}

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
  const now = Date.now();
  const live = (sessions ?? []).filter((s) => isLive(s) && !s.archived && !isAsleep(s, now));
  const shown = live.slice(0, RAIL_LIVE_CAP);
  return (
    <nav aria-label="Sessions" className="flex h-full w-full flex-col items-center">
      <div className="flex h-[52px] shrink-0 items-center">
        <button type="button" aria-label="Open sidebar" data-tip={`Open sidebar  ${mod} B`} data-tip-pos="right" onClick={onExpand} className="icon-btn group/brand">
          <span className="transition-opacity duration-150 group-hover/brand:opacity-0 group-focus-visible/brand:opacity-0">
            <Brand />
          </span>
          <SidebarExpand width={18} height={18} strokeWidth={1.8} aria-hidden className="absolute opacity-0 transition-opacity duration-150 group-hover/brand:opacity-100 group-focus-visible/brand:opacity-100" />
        </button>
      </div>
      <div className="flex flex-col items-center gap-1">
        <IconButton label="New session" tip="New session  Alt T" tipPos="right" onClick={onNew}>
          <EditPencil width={18} height={18} strokeWidth={1.8} aria-hidden />
        </IconButton>
        <IconButton label="Search" tip={`Search  ${mod} K`} tipPos="right" onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE_EVENT))}>
          <Search width={18} height={18} strokeWidth={1.8} aria-hidden />
        </IconButton>
        {onView && (
          <>
            <IconButton label={inbox ? `Inbox, ${inbox} need you` : "Inbox"} tip="Inbox" tipPos="right" onClick={() => onView("@inbox")} className="relative">
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
            <button type="button" onClick={onExpand} aria-label={`${live.length - shown.length} more`} data-tip="Show all" data-tip-pos="right" className="icon-btn text-[12px] font-medium tabular-nums">
              +{live.length - shown.length}
            </button>
          )}
        </div>
      )}
    </nav>
  );
}
