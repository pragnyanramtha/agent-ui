"use client";

import type { PointerEvent as ReactPointerEvent } from "react";
import { useSetting } from "@/lib/client/settings";
import { clampSidebarWidth, SIDEBAR_DEFAULT, SIDEBAR_MIN, sidebarKeyWidth, sidebarMax } from "@/lib/sidebar-width";

/**
 * The drag handle on the desktop sidebar's right edge. The width is a device setting (Settings > Sidebar), written once
 * the drag ends; while dragging it only moves the sidebar's own --sidebar-w. Arrow keys step it, Home and End go to
 * the ends, Enter or a double-click puts it back.
 */
export function SidebarResizer() {
  const [width, setWidth] = useSetting("sidebarWidth");

  const start = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const handle = e.currentTarget;
    const aside = handle.parentElement;
    if (!aside) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.dataset.dragging = "";
    const startX = e.clientX;
    const startW = aside.getBoundingClientRect().width;
    let last = startW;
    /* the sidebar animates its width when it folds; a drag must follow the pointer */
    aside.style.transition = "none";
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (ev: PointerEvent) => {
      last = clampSidebarWidth(startW + ev.clientX - startX, window.innerWidth);
      aside.style.setProperty("--sidebar-w", `${last}px`);
      handle.setAttribute("aria-valuenow", String(last));
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      delete handle.dataset.dragging;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      if (Math.round(last) !== Math.round(startW)) setWidth(last);
      aside.style.removeProperty("--sidebar-w");
      aside.style.transition = "";
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={sidebarMax()}
      aria-keyshortcuts="ArrowLeft ArrowRight Home End Enter"
      title="Drag to resize. Double-click to reset."
      onPointerDown={start}
      onDoubleClick={() => setWidth(SIDEBAR_DEFAULT)}
      onKeyDown={(e) => {
        const next = sidebarKeyWidth(e.key, width, e.shiftKey, window.innerWidth);
        if (next === null) return;
        e.preventDefault();
        setWidth(next);
      }}
      className="absolute inset-y-0 -right-[5px] z-30 w-2.5 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent after:transition-colors after:duration-150 hover:after:bg-line-strong focus-visible:after:w-0.5 focus-visible:after:bg-accent data-dragging:after:bg-accent"
    />
  );
}
