"use client";

import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Boundary } from "./Boundary";

const WIDTH_KEY = "cui:panel-width";
const MIN = 340;
const DEFAULT = 460;
/* the conversation keeps at least this much room next to the panel; keep in step with the max-w class below */
const MAIN_MIN = 420;

/**
 * The right-hand panel column on desktop (Changes, Git, Usage): a drag handle on its left edge,
 * width remembered. Below lg the panel inside covers the session as a sheet, so this adds nothing.
 */
export function PanelSlot({ children, resetKey, onClose }: { children: ReactNode; resetKey?: unknown; onClose?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    ref.current?.style.setProperty("--panel-w", `${stored >= MIN ? stored : DEFAULT}px`);
  }, []);

  const start = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.dataset.dragging = "";
    const startX = e.clientX;
    const startW = el.getBoundingClientRect().width;
    const room = (el.parentElement?.getBoundingClientRect().width ?? window.innerWidth) - MAIN_MIN;
    let last = startW;
    const move = (ev: PointerEvent) => {
      last = Math.round(Math.max(MIN, Math.min(room, startW + startX - ev.clientX)));
      el.style.setProperty("--panel-w", `${last}px`);
    };
    const up = () => {
      delete handle.dataset.dragging;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      localStorage.setItem(WIDTH_KEY, String(last));
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div ref={ref} className="panel-slot contents lg:relative lg:flex lg:w-[var(--panel-w,460px)] lg:max-w-[calc(100%-420px)] lg:shrink-0">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        onPointerDown={start}
        onDoubleClick={() => {
          ref.current?.style.setProperty("--panel-w", `${DEFAULT}px`);
          localStorage.setItem(WIDTH_KEY, String(DEFAULT));
        }}
        className="absolute inset-y-0 -left-[5px] z-30 hidden w-2.5 cursor-col-resize after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent after:transition-colors after:duration-150 hover:after:bg-line-strong data-dragging:after:bg-accent lg:block"
      />
      <Boundary resetKey={resetKey} label="panel" fallback={(retry) => <PanelFallback retry={retry} onClose={onClose} />}>
        {children}
      </Boundary>
    </div>
  );
}

const BTN = "tap relative h-9 rounded-full px-3.5 text-sm font-medium text-ink shadow-btn hover:bg-hover";

function PanelFallback({ retry, onClose }: { retry: () => void; onClose?: () => void }) {
  return (
    <aside
      role="alert"
      className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-page px-6 text-center lg:static lg:inset-auto lg:border-l lg:border-line"
    >
      <p className="text-sm text-ink-3">This panel failed to load.</p>
      <div className="flex items-center gap-2">
        <button type="button" onClick={retry} className={BTN}>
          Retry
        </button>
        {onClose && (
          <button type="button" onClick={onClose} className={BTN}>
            Close
          </button>
        )}
      </div>
    </aside>
  );
}
