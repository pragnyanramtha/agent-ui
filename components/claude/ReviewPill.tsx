"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ChatLines, NavArrowUp, Trash } from "iconoir-react";
import { commentLabel, relToRoot } from "@/lib/client/review";
import { clearReview, removeReview, useReviewComments } from "@/lib/client/review-store";

/** The review comments waiting for the next message ("3 review comments"); opens the list, where they can be
 * dropped or sent on their own. */
export function ReviewPill({ session, root, onSend, onShow }: { session: string; root: string; onSend: () => void; onShow: () => void }) {
  const comments = useReviewComments(session);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const uid = useId();
  const n = comments.length;

  useEffect(() => {
    if (!n) setOpen(false);
  }, [n]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    /* capture: Esc closes the list before it can stop the turn */
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      if (rootRef.current?.contains(document.activeElement)) buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  if (!n) return null;
  const close = (then: () => void) => () => {
    setOpen(false);
    then();
  };
  const word = n === 1 ? "1 review comment" : `${n} review comments`;

  return (
    <div ref={rootRef} className="relative mb-2 flex min-w-0">
      {open && (
        <div
          id={`${uid}-review`}
          role="region"
          aria-label={word}
          className="absolute bottom-full left-0 z-20 mb-1.5 flex max-h-[min(24rem,50vh)] w-full max-w-[28rem] flex-col overflow-hidden rounded-card bg-surface shadow-overlay"
          style={{ animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "bottom left" }}
        >
          <p className="shrink-0 border-b border-line px-3 py-2 text-xs text-ink-3">They go out with your next message.</p>
          <ul className="thin-scroll min-h-0 flex-1 overflow-y-auto p-1">
            {comments.map((c) => {
              const label = commentLabel(relToRoot(c.file, root), c.lines);
              return (
                <li key={c.id} className="group/c flex items-start gap-2 rounded-[8px] px-2 py-1.5 hover:bg-hover">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-2xs text-ink-3" translate="no" title={label}>
                      {label}
                    </p>
                    <p className="line-clamp-2 text-sm text-ink [overflow-wrap:anywhere]">{c.body}</p>
                  </div>
                  <button type="button" onClick={() => removeReview(session, c.id)} aria-label={`Remove comment on ${label}`} data-tip="Remove" className="icon-btn shrink-0">
                    <Trash width={15} height={15} strokeWidth={1.8} />
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="flex shrink-0 items-center gap-1 border-t border-line px-2 py-1.5">
            <button type="button" onClick={close(onShow)} className="h-8 rounded-full px-2.5 text-sm font-medium text-ink-2 hover:bg-hover">
              Show in diff
            </button>
            <button type="button" onClick={close(() => clearReview(session))} className="h-8 rounded-full px-2.5 text-sm font-medium text-red-ink hover:bg-hover">
              Clear all
            </button>
            <button type="button" onClick={close(onSend)} className="tap relative ml-auto h-8 rounded-full bg-ink px-3 text-sm font-medium text-surface">
              Send now
            </button>
          </div>
        </div>
      )}
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? `${uid}-review` : undefined}
        onClick={() => setOpen((v) => !v)}
        className={`tap relative flex h-8 max-w-full min-w-0 items-center gap-2 rounded-full bg-surface pr-2.5 pl-3 text-sm shadow-btn transition-colors duration-150 hover:bg-hover pointer-coarse:h-10 ${open ? "bg-hover" : ""}`}
      >
        <ChatLines width={15} height={15} strokeWidth={1.8} className="shrink-0 text-accent-ink" aria-hidden />
        <span className="min-w-0 truncate font-medium text-ink">{word}</span>
        <NavArrowUp width={13} height={13} strokeWidth={2.2} className={`shrink-0 text-ink-3 transition-transform duration-200 ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
    </div>
  );
}
