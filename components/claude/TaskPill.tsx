"use client";

import { useEffect, useId, useRef, useState } from "react";
import { NavArrowUp } from "iconoir-react";
import { tasksLabel, type TaskProgress } from "@/lib/client/tasks";
import { TodoList } from "./TodoList";

/** The plan's progress above the composer ("Tasks 3/7 · Running the tests"); opens the full list over the thread. */
export function TaskPill({ progress, live }: { progress: TaskProgress; live: boolean }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const uid = useId();
  const { done, total, current } = progress;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    /* capture: Esc closes the list before it can stop the turn or answer an approval */
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

  return (
    <div ref={rootRef} className="relative mb-2 flex min-w-0">
      {open && (
        <div
          id={`${uid}-tasks`}
          role="region"
          aria-label={`Task list. ${done} of ${total} complete.`}
          data-task-popover
          className="thin-scroll absolute bottom-full left-0 z-20 mb-1.5 max-h-[min(24rem,50vh)] w-full max-w-[28rem] overflow-y-auto rounded-card shadow-overlay"
          style={{ animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "bottom left" }}
        >
          <TodoList todos={progress.tasks} live={live} />
        </div>
      )}
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? `${uid}-tasks` : undefined}
        aria-label={`Tasks: ${done} of ${total} complete. Current task: ${current}`}
        onClick={() => setOpen((v) => !v)}
        className={`tap relative flex h-8 max-w-full min-w-0 items-center gap-2 rounded-full bg-surface pr-2.5 pl-3 text-sm shadow-btn transition-colors duration-150 hover:bg-hover pointer-coarse:h-10 ${open ? "bg-hover" : ""}`}
        title={tasksLabel(progress)}
      >
        <span className="shrink-0 text-ink-3">Tasks</span>
        <span className={`shrink-0 font-medium tabular-nums ${done >= total ? "text-green" : "text-ink-2"}`}>
          {done}/{total}
        </span>
        <span className="shrink-0 text-ink-3" aria-hidden>
          ·
        </span>
        <span className="min-w-0 truncate font-medium text-ink">{current}</span>
        <NavArrowUp width={13} height={13} strokeWidth={2.2} className={`shrink-0 text-ink-3 transition-transform duration-200 ${open ? "" : "rotate-180"}`} aria-hidden />
      </button>
    </div>
  );
}
