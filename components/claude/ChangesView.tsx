"use client";

import { isPlainText } from "@/lib/client/highlight";
import { useEffect, useMemo, useRef, useState } from "react";
import { NavArrowDown, Xmark } from "iconoir-react";
import { DiffBlock } from "./DiffBlock";
import { PathLabel } from "./PathLabel";
import { OPEN_FILES_EVENT } from "@/lib/client/events";
import { modalOpen } from "@/lib/client/shortcuts";
import { scrollBehavior } from "@/lib/client/motion";
import { useReturnFocus } from "@/lib/client/a11y";
import type { FileChange } from "./ChangesPanel";

/** OpenCode-style review pane: files changed in this session, each expandable to its edits. */
export function ChangesView({
  changes,
  cwd,
  partial,
  onClose,
  focus,
  focusKey,
}: {
  changes: FileChange[];
  cwd: string;
  partial: boolean;
  onClose: () => void;
  focus?: string | null;
  focusKey?: number;
}) {
  const [open, setOpen] = useState<string | null>(() => (focus && changes.some((f) => f.path === focus) ? focus : (changes[0]?.path ?? null)));
  const ref = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const totals = useMemo(() => changes.reduce((t, f) => ({ added: t.added + f.added, removed: t.removed + f.removed }), { added: 0, removed: 0 }), [changes]);
  const rel = (p: string) => (cwd && p.startsWith(`${cwd.replace(/\/+$/, "")}/`) ? p.slice(cwd.replace(/\/+$/, "").length + 1) : p);

  useReturnFocus(ref);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && !modalOpen() && closeRef.current();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!focus) return;
    setOpen(focus);
    const frame = requestAnimationFrame(() => {
      const list = listRef.current;
      const row = [...(list?.querySelectorAll<HTMLElement>("[data-path]") ?? [])].find((n) => n.dataset.path === focus);
      if (!list || !row) return;
      /* not scrollIntoView: on a phone the panel sits over the thread, and that would scroll the screen under it too */
      const top = row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop - 8;
      list.scrollTo({ top: Math.max(0, top), behavior: scrollBehavior() });
      row.querySelector("button")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focus, focusKey]);

  return (
    <aside
      ref={ref}
      tabIndex={-1}
      aria-label="Changes"
      className="absolute inset-0 z-20 flex flex-col bg-page outline-none [--add-ink:oklch(0.52_0.13_150.883)] dark:[--add-ink:var(--green)] lg:static lg:inset-auto lg:w-[440px] lg:shrink-0 lg:border-l lg:border-line xl:w-[520px]"
      style={{ animation: "fade-up 220ms cubic-bezier(0.23,1,0.32,1) both" }}
    >
      <div className="safe-top flex shrink-0 items-center gap-2 border-b border-line px-3 sm:px-4">
        <div className="flex h-14 min-w-0 flex-1 items-center gap-2">
          <span className="text-base font-semibold text-ink">Changes</span>
          <span className="text-xs text-ink-3 tabular-nums">
            {changes.length} {changes.length === 1 ? "file" : "files"}
          </span>
          <span className="diff-tone font-mono text-xs tabular-nums">
            <span className="text-(color:--add-ink)">+{totals.added}</span> <span className="text-red-ink">-{totals.removed}</span>
          </span>
          <button type="button" onClick={onClose} aria-label="Close changes" className="tap relative ml-auto flex size-9 items-center justify-center rounded-[9px] text-ink-3 hover:bg-hover hover:text-ink">
            <Xmark width={16} height={16} strokeWidth={2} />
          </button>
        </div>
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2 sm:px-3">
        {partial && <p className="px-2 pb-2 text-[11.5px] text-ink-3">From the loaded part of the conversation. Load earlier messages to include older edits.</p>}
        {changes.length === 0 ? (
          <p className="px-2 py-8 text-center text-sm text-ink-3">No file edits in this conversation yet.</p>
        ) : (
          changes.map((f) => {
            const expanded = open === f.path;
            return (
              <div key={f.path} data-path={f.path} className="mb-1 scroll-mt-2">
                <button
                  type="button"
                  onClick={() => setOpen(expanded ? null : f.path)}
                  aria-expanded={expanded}
                  title={f.path}
                  className={`flex w-full min-w-0 items-center gap-2 rounded-control px-2 py-2 text-left font-mono text-[12.5px] transition-colors duration-100 hover:bg-hover ${expanded ? "bg-hover" : ""}`}
                >
                  <NavArrowDown width={12} height={12} strokeWidth={2.4} className={`shrink-0 text-ink-3 transition-transform duration-200 ${expanded ? "" : "-rotate-90"}`} />
                  <PathLabel path={rel(f.path)} className="min-w-0 flex-1" />
                  <span className="shrink-0 text-[11.5px] text-ink-3">{f.edits.length > 1 ? `${f.edits.length} edits` : f.edits[0]?.kind === "write" ? "written" : "1 edit"}</span>
                  <span className="diff-tone shrink-0 tabular-nums">
                    <span className="text-(color:--add-ink)">+{f.added}</span> <span className="text-red-ink">-{f.removed}</span>
                  </span>
                </button>
                {expanded && (
                  <div className="flex flex-col gap-2 px-1 pt-1 pb-3">
                    {f.path.startsWith("/") && (
                      <button
                        type="button"
                        onClick={() => window.dispatchEvent(new CustomEvent(OPEN_FILES_EVENT, { detail: { path: f.path } }))}
                        className="self-start rounded-full px-2.5 py-1 text-xs font-medium text-ink-2 shadow-btn hover:bg-hover"
                      >
                        Open the file as it is now
                      </button>
                    )}
                    {f.edits.map((ed, i) => (
                      <div key={i} className={ed.failed ? "opacity-50" : ""}>
                        {ed.failed && <p className="mb-1 text-[11.5px] text-red-ink">This edit failed and wasn&apos;t applied.</p>}
                        <DiffBlock before={ed.before} after={ed.after} plain={isPlainText(f.path)} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
