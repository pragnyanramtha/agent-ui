"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Clock, Folder, GitBranch } from "iconoir-react";
import { AGENT_LABEL, type SessionSummary } from "@/lib/types";
import { shortPath } from "@/lib/client/api";
import { sessionStatus, STATUS_LABEL } from "@/lib/client/session-status";
import { relativeTime } from "@/lib/client/sidebar";
import { useSetting } from "@/lib/client/settings";
import { dayStamp, fullDateTime } from "@/lib/time-format";
import type { Finished } from "@/lib/client/useFinished";
import { AgentIcon } from "./AgentIcon";
import { modelLabel } from "@/lib/composer-options";
import { useBranch } from "./ProjectIcon";

/* A card beside a sidebar row with what the one line can't hold: the full title, folder, branch, agent and model, last
 * activity and status. A mouse resting on a row shows it after HOVER_MS (and moving to the next row while it's up swaps
 * it at once); keyboard focus shows it after FOCUS_MS. Escape, a click, a key or scrolling hide it. Touch never shows it. */

const HOVER_MS = 400;
const FOCUS_MS = 700;
const GAP = 8;

type Shown = { id: string; anchor: HTMLElement };

/** Where the card goes: right of the list, level with the row, kept inside the window. */
export function cardPlace(row: { top: number }, listRight: number, card: { width: number; height: number }, win: { width: number; height: number }) {
  const left = Math.max(GAP, Math.min(listRight + GAP, win.width - card.width - GAP));
  const top = Math.max(GAP, Math.min(row.top - 4, win.height - card.height - GAP));
  return { left, top };
}

export function SessionHoverCard({ list, byId, finished }: { list: RefObject<HTMLElement | null>; byId: ReadonlyMap<string, SessionSummary>; finished: Finished }) {
  const [shown, setShown] = useState<Shown | null>(null);
  const shownRef = useRef<Shown | null>(null);
  shownRef.current = shown;
  const cardId = useId();

  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const fine = window.matchMedia("(hover: hover) and (pointer: fine)");
    let timer: ReturnType<typeof setTimeout> | undefined;
    /* a row just clicked stays quiet until the pointer leaves it */
    let quiet: Element | null = null;
    const rowOf = (t: EventTarget | null) => (t instanceof Element ? t.closest<HTMLElement>("[data-session-row]") : null);
    const hide = () => {
      clearTimeout(timer);
      timer = undefined;
      if (shownRef.current) setShown(null);
    };
    const show = (row: HTMLElement, delay: number) => {
      clearTimeout(timer);
      const id = row.dataset.sessionRow;
      if (!id) return;
      if (shownRef.current?.anchor === row) return;
      if (delay === 0) setShown({ id, anchor: row });
      else timer = setTimeout(() => row.isConnected && setShown({ id, anchor: row }), delay);
    };
    const onOver = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || !fine.matches) return;
      const row = rowOf(e.target);
      if (row !== quiet) quiet = null;
      if (!row || quiet) return hide();
      show(row, shownRef.current ? 0 : HOVER_MS);
    };
    const onLeave = () => {
      quiet = null;
      hide();
    };
    const onDown = (e: PointerEvent) => {
      quiet = rowOf(e.target);
      hide();
    };
    const onFocusIn = (e: FocusEvent) => {
      const row = rowOf(e.target);
      if (!row || !row.matches(":focus-visible") || !fine.matches) return hide();
      show(row, FOCUS_MS);
    };
    const onFocusOut = (e: FocusEvent) => {
      if (!rowOf(e.relatedTarget)) hide();
    };
    const onKey = (e: KeyboardEvent) => {
      if (!shownRef.current && !timer) return;
      if (e.key === "Escape" && shownRef.current) {
        e.preventDefault();
        e.stopPropagation();
      }
      hide();
    };
    el.addEventListener("pointerover", onOver);
    el.addEventListener("pointerleave", onLeave);
    el.addEventListener("pointerdown", onDown, true);
    el.addEventListener("focusin", onFocusIn);
    el.addEventListener("focusout", onFocusOut);
    el.addEventListener("scroll", hide, { passive: true });
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", hide);
    window.addEventListener("resize", hide);
    return () => {
      clearTimeout(timer);
      el.removeEventListener("pointerover", onOver);
      el.removeEventListener("pointerleave", onLeave);
      el.removeEventListener("pointerdown", onDown, true);
      el.removeEventListener("focusin", onFocusIn);
      el.removeEventListener("focusout", onFocusOut);
      el.removeEventListener("scroll", hide);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", hide);
      window.removeEventListener("resize", hide);
    };
  }, [list]);

  const s = shown ? byId.get(shown.id) : undefined;
  const anchor = shown?.anchor;
  /* the row names the card for screen readers while it's up */
  useEffect(() => {
    if (!anchor || !s) return;
    anchor.setAttribute("aria-describedby", cardId);
    return () => anchor.removeAttribute("aria-describedby");
  }, [anchor, s, cardId]);

  if (!shown || !s || !shown.anchor.isConnected) return null;
  return createPortal(<Card key={s.id} id={cardId} s={s} anchor={shown.anchor} list={list.current} unread={Boolean(finished[s.id])} />, document.body);
}

function Card({ id, s, anchor, list, unread }: { id: string; s: SessionSummary; anchor: HTMLElement; list: HTMLElement | null; unread: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const [fmt] = useSetting("timeFormat");
  const branch = useBranch(s.cwd || null);
  useLayoutEffect(() => {
    const card = ref.current;
    if (!card) return;
    const r = anchor.getBoundingClientRect();
    const right = (list ?? anchor).getBoundingClientRect().right;
    setPlace(cardPlace(r, right, { width: card.offsetWidth, height: card.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }));
  }, [anchor, list, branch]);

  const now = Date.now();
  const status = sessionStatus(s, unread);
  const live = Boolean(s.terminal) || (s.web !== null && s.web.status !== "closed");
  const snoozed = (s.snoozedUntil ?? 0) > now;
  const state = status ? STATUS_LABEL[status] : s.archived ? "Archived" : snoozed ? `Snoozed until ${fullDateTime(s.snoozedUntil!, fmt)}` : live ? "Open" : "Idle";
  const model = s.web?.model ? modelLabel(s.web.model) : null;
  /* within the day the stamp's clock time is easier with how long ago it was */
  const rel = relativeTime(s.mtime, now);
  const ago = rel === "now" ? "just now" : /^\d+[mh]$/.test(rel) ? `${rel} ago` : null;
  const icon = { width: 13, height: 13, strokeWidth: 1.8, "aria-hidden": true, className: "mt-px shrink-0 text-ink-3" } as const;
  const line = "flex min-w-0 items-start gap-2";
  return (
    <div
      ref={ref}
      id={id}
      role="tooltip"
      className="pointer-events-none fixed z-50 flex w-72 flex-col gap-2 rounded-[12px] bg-surface px-3 py-2.5 text-xs text-ink-2 shadow-overlay"
      style={{ left: place?.left ?? -9999, top: place?.top ?? 0, visibility: place ? "visible" : "hidden", animation: place ? "fade-in 120ms ease-out both" : undefined }}
    >
      <p className="line-clamp-3 text-sm leading-snug font-medium text-ink [overflow-wrap:anywhere]">{s.title}</p>
      <div className="flex flex-col gap-1.5">
        <div className={line}>
          <Folder {...icon} />
          <span className="min-w-0 flex-1 truncate font-mono" translate="no">
            <span className="sr-only">Folder: </span>
            {s.cwd ? shortPath(s.cwd) : "No folder"}
          </span>
        </div>
        {branch && (
          <div className={line}>
            <GitBranch {...icon} />
            <span className="min-w-0 flex-1 truncate font-mono" translate="no">
              <span className="sr-only">Branch: </span>
              {branch}
            </span>
          </div>
        )}
        <div className={line}>
          <AgentIcon agent={s.agent} size={13} className="mt-px" />
          <span className="min-w-0 flex-1 truncate">
            {AGENT_LABEL[s.agent]}
            {model && <span className="text-ink-3"> · {model}</span>}
          </span>
        </div>
        <div className={line}>
          <Clock {...icon} />
          <span className="min-w-0 flex-1 truncate">
            <span className="sr-only">Last activity: </span>
            {dayStamp(s.mtime, fmt)}
            {ago && <span className="text-ink-3"> · {ago}</span>}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1.5 border-t border-line pt-2 text-ink-3">
        <span className={`size-1.5 shrink-0 rounded-full ${STATE_DOT[status ?? (live ? "live" : "idle")]}`} aria-hidden />
        <span className="min-w-0 flex-1 truncate">{state}</span>
      </div>
    </div>
  );
}

const STATE_DOT: Record<string, string> = {
  approval: "bg-orange",
  input: "bg-orange",
  working: "bg-accent",
  failed: "bg-red",
  unread: "bg-green",
  live: "bg-ink-3",
  idle: "bg-line-strong",
};
