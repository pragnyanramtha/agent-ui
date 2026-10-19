"use client";

import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { NavArrowRight } from "iconoir-react";
import type { Entry, ToolResult } from "@/lib/types";
import { foldLabel } from "@/lib/client/turns";
import { collectChanges } from "./ChangesPanel";
import "./diff.css";

/** Dispatched on a fold's root (`[data-fold]`) to open it, so find can show a match inside. */
export const EXPAND_FOLD_EVENT = "cui:expand-fold";

const FOCUS_INSET = "focus-visible:[outline-offset:-2px]! focus-visible:rounded-control!";

/**
 * A finished turn's work behind one quiet row: "Worked for 2m 14s · 9 tool calls".
 * Collapsed, the body stays in the DOM but hidden, so find in session still reaches its text.
 * `defaultOpen` (Settings > Conversation > Finished turns) opens or closes every fold when it changes.
 */
export function TurnFold({ ms, tools, failed, defaultOpen = false, children }: { ms: number | null; tools: number; failed: number; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  const [shown, setShown] = useState(defaultOpen);
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const { title, detail } = foldLabel(ms, tools);

  const toggle = (next: boolean) => {
    clearTimeout(timer.current);
    setOpen(next);
    if (next) {
      setShown(true);
      return;
    }
    /* hide the body once the close animation is done, so collapsed folds cost no layout */
    timer.current = setTimeout(() => setShown(false), 220);
  };

  const firstDefault = useRef(true);
  useEffect(() => {
    if (firstDefault.current) {
      firstDefault.current = false;
      return;
    }
    toggle(defaultOpen);
  }, [defaultOpen]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const expand = () => toggle(true);
    el.addEventListener(EXPAND_FOLD_EVENT, expand);
    return () => {
      el.removeEventListener(EXPAND_FOLD_EVENT, expand);
      clearTimeout(timer.current);
    };
  }, []);

  return (
    <div ref={ref} data-fold data-open={open || undefined} className="border-b border-line/60 pt-1 pb-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => toggle(!open)}
        className={`-mx-1.5 inline-flex h-10 max-w-[calc(100%+12px)] min-w-0 items-center gap-1.5 rounded-control px-1.5 text-[13px] text-ink-3 transition-colors duration-100 hover:text-ink-2 pointer-fine:h-7 ${FOCUS_INSET}`}
      >
        <span className="truncate">
          {title}
          {detail && <span className="text-ink-3/70"> · {detail}</span>}
          {failed > 0 && <span className="text-red"> · {failed} failed</span>}
        </span>
        <NavArrowRight width={14} height={14} strokeWidth={1.6} className="shrink-0 transition-transform duration-200" style={{ transform: open ? "rotate(90deg)" : undefined }} aria-hidden />
      </button>
      <div
        className="grid grid-cols-[minmax(0,1fr)] transition-[grid-template-rows] duration-200 motion-reduce:transition-none"
        style={{ gridTemplateRows: open ? "1fr" : "0fr", transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)" }}
      >
        <div className="min-h-0 min-w-0 overflow-hidden" hidden={!open && !shown}>
          <div className="ms-1 flex min-w-0 flex-col gap-4 pt-2 pb-1">{children}</div>
        </div>
      </div>
    </div>
  );
}

const GHOST = "tap relative inline-flex h-8 shrink-0 items-center rounded-control px-2 text-[12.5px] font-medium text-ink-2 transition-colors duration-100 hover:bg-hover hover:text-ink disabled:opacity-50 pointer-coarse:h-10";

/** After a finished turn's answer: "3 files changed +42 −7", with View diff and Undo. */
export const TurnChanges = memo(function TurnChanges({
  tools,
  results,
  onView,
  onUndo,
}: {
  tools: Entry[];
  results: Record<string, ToolResult>;
  onView?: () => void;
  /** rewinds the files to before this turn; resolves to a note to show, or throws */
  onUndo?: () => Promise<string | null>;
}) {
  const files = useMemo(() => collectChanges(tools, results), [tools, results]);
  const [state, setState] = useState<{ busy?: boolean; note?: string; error?: boolean }>({});
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  if (!files.length) return null;
  const undo = async () => {
    if (!onUndo) return;
    setState({ busy: true });
    try {
      const note = await onUndo();
      setState(note ? { note } : {});
    } catch (err) {
      setState({ note: err instanceof Error ? err.message : "Couldn't undo.", error: true });
    }
  };
  return (
    <div className="flex min-h-10 min-w-0 items-center gap-3 rounded-card bg-surface py-1 pr-1 pl-3 text-[13px] shadow-hairline">
      <span className="min-w-0 truncate text-ink-2">
        {files.length} {files.length === 1 ? "file" : "files"} changed
      </span>
      <span className="diff-tone shrink-0 tabular-nums">
        <span className="text-green">+{added}</span> <span className="text-red">−{removed}</span>
      </span>
      <span className="ml-auto flex min-w-0 items-center gap-0.5">
        {state.note && (
          <span role="status" className={`min-w-0 truncate px-1 text-[12.5px] ${state.error ? "text-red-ink" : "text-ink-3"}`}>
            {state.note}
          </span>
        )}
        {onView && (
          <button type="button" onClick={onView} className={GHOST}>
            View diff
          </button>
        )}
        {onUndo && !state.note && (
          <button type="button" onClick={() => void undo()} disabled={state.busy} className={GHOST}>
            {state.busy ? "Undoing…" : "Undo"}
          </button>
        )}
      </span>
    </div>
  );
});
