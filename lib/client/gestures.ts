"use client";

import { useEffect, useRef, type RefObject } from "react";
import { reducedMotion } from "./motion";

/* Touch gestures: swipe in from the left edge for the sessions drawer, swipe a session row to archive or pin it, and
 * swipe the session header to switch tabs. The math is pure (and tested); the bindings below only feed it. Vertical
 * scrolling always wins: a drag only becomes a swipe once it is clearly sideways. */

/** how close to the left edge a drawer swipe starts */
export const EDGE_PX = 20;
/** movement before a drag picks a direction */
export const SLOP_PX = 10;
/** a short drag still counts when it's this fast (px per ms) */
export const FLICK_SPEED = 0.5;
export const FLICK_MIN_PX = 30;

export type Axis = "x" | "y";

/** The direction a drag has taken once it moved past the slop, or null while it's undecided. Diagonals scroll. */
export function lockAxis(dx: number, dy: number, slop = SLOP_PX): Axis | null {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (Math.max(ax, ay) < slop) return null;
  return ax > ay * 1.5 ? "x" : "y";
}

/** Whether a sideways drag that ended commits, and which way: far enough, or a quick flick. */
export function swipeCommit(dx: number, ms: number, distance: number): -1 | 0 | 1 {
  const ax = Math.abs(dx);
  const fast = ax >= FLICK_MIN_PX && ax / Math.max(ms, 1) >= FLICK_SPEED;
  if (ax < distance && !fast) return 0;
  return dx < 0 ? -1 : 1;
}

export const isEdgeStart = (x: number, edge = EDGE_PX) => x >= 0 && x <= edge;

/** Past `limit` the dragged thing moves at a third of the finger's speed, so it feels held back. */
export function rubberBand(dx: number, limit: number): number {
  const ax = Math.abs(dx);
  if (ax <= limit) return dx;
  return Math.sign(dx) * (limit + (ax - limit) / 3);
}

/** How open the drawer is (0 to 1) after dragging `dx` from the edge. */
export const drawerProgress = (dx: number, width: number) => (width > 0 ? Math.min(1, Math.max(0, dx / width)) : 0);

/* ── bindings ───────────────────────────────────────────── */

/** Where a swipe must not start: text fields, terminals, anything that scrolls sideways, or while text is selected. */
export function swipeBlocked(target: EventTarget | null, root?: Element | null): boolean {
  if (!(target instanceof Element)) return true;
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  if (sel && !sel.isCollapsed && sel.toString().trim()) return true;
  if (target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], .xterm, [data-terminal], [data-no-swipe]")) return true;
  for (let el: Element | null = target; el && el !== root && el !== document.body; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth + 1) {
      const ox = getComputedStyle(el).overflowX;
      if (ox === "auto" || ox === "scroll") return true;
    }
  }
  return false;
}

type SwipeOptions = {
  /** where it may start; return the element the swipe is about, or null */
  accept: (target: Element, x: number, y: number) => Element | null;
  /** how far to drag to commit */
  distance: (subject: Element) => number;
  onMove: (dx: number, subject: Element) => void;
  /** dir 0 is a drag that didn't commit (or was taken over by a scroll) */
  onEnd: (dir: -1 | 0 | 1, dx: number, subject: Element) => void;
};

type Drag = { id: number; x: number; y: number; t: number; axis: Axis | null; dx: number; subject: Element };

/* the tap that ends a swipe isn't a click on what's under it */
function swallowClick() {
  const stop = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener("click", stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 400);
}

function tracker(opts: SwipeOptions) {
  let drag: Drag | null = null;
  return {
    start(id: number, target: EventTarget | null, x: number, y: number) {
      if (drag || !(target instanceof Element)) return;
      const subject = opts.accept(target, x, y);
      if (subject) drag = { id, x, y, t: performance.now(), axis: null, dx: 0, subject };
    },
    move(id: number, x: number, y: number): boolean {
      if (!drag || drag.id !== id) return false;
      const dx = x - drag.x;
      drag.axis ??= lockAxis(dx, y - drag.y);
      if (drag.axis === "y") {
        drag = null;
        return false;
      }
      if (drag.axis !== "x") return false;
      drag.dx = dx;
      opts.onMove(dx, drag.subject);
      return true;
    },
    end(id: number, cancelled: boolean) {
      if (!drag || drag.id !== id) return;
      const d = drag;
      drag = null;
      if (d.axis !== "x") return;
      swallowClick();
      opts.onEnd(cancelled ? 0 : swipeCommit(d.dx, performance.now() - d.t, opts.distance(d.subject)), d.dx, d.subject);
    },
  };
}

/** Pointer events, for elements that set `touch-action: pan-y` (the browser keeps vertical scrolling and hands the
 * sideways part to us). Touch and pen only: a mouse drag selects text. */
export function bindPointerSwipe(el: HTMLElement, opts: SwipeOptions): () => void {
  const t = tracker(opts);
  const down = (e: PointerEvent) => e.pointerType !== "mouse" && e.isPrimary && t.start(e.pointerId, e.target, e.clientX, e.clientY);
  const move = (e: PointerEvent) => {
    if (t.move(e.pointerId, e.clientX, e.clientY) && !el.hasPointerCapture(e.pointerId)) el.setPointerCapture?.(e.pointerId);
  };
  const up = (e: PointerEvent) => t.end(e.pointerId, false);
  const cancel = (e: PointerEvent) => t.end(e.pointerId, true);
  el.addEventListener("pointerdown", down, { passive: true });
  el.addEventListener("pointermove", move, { passive: true });
  el.addEventListener("pointerup", up, { passive: true });
  el.addEventListener("pointercancel", cancel, { passive: true });
  return () => {
    el.removeEventListener("pointerdown", down);
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointercancel", cancel);
  };
}

/** Touch events, for swipes that start over a scroller we don't own (the thread): a browser that starts a scroll ends
 * pointer events with pointercancel, but touch events keep coming. All passive, so scrolling never waits on them. */
export function bindTouchSwipe(el: HTMLElement | Document, opts: SwipeOptions): () => void {
  const t = tracker(opts);
  const start = (e: Event) => {
    const te = e as TouchEvent;
    if (te.touches.length !== 1) return;
    const p = te.touches[0];
    t.start(p.identifier, te.target, p.clientX, p.clientY);
  };
  const move = (e: Event) => {
    const p = (e as TouchEvent).changedTouches[0];
    if (p) t.move(p.identifier, p.clientX, p.clientY);
  };
  const end = (cancelled: boolean) => (e: Event) => {
    for (const p of Array.from((e as TouchEvent).changedTouches)) t.end(p.identifier, cancelled);
  };
  const up = end(false);
  const cancel = end(true);
  el.addEventListener("touchstart", start, { passive: true });
  el.addEventListener("touchmove", move, { passive: true });
  el.addEventListener("touchend", up, { passive: true });
  el.addEventListener("touchcancel", cancel, { passive: true });
  return () => {
    el.removeEventListener("touchstart", start);
    el.removeEventListener("touchmove", move);
    el.removeEventListener("touchend", up);
    el.removeEventListener("touchcancel", cancel);
  };
}

const EASE = "cubic-bezier(0.23, 1, 0.32, 1)";
const phone = () => !window.matchMedia("(min-width: 1024px)").matches;

/* ── edge swipe: the sessions drawer ────────────────────── */

/** Drags the drawer in from the left edge; past a third of its width (or a flick) it opens. */
export function useEdgeSwipe(opts: { enabled: boolean; drawer: RefObject<HTMLElement | null>; open: () => void; blocked: () => boolean }) {
  const latest = useRef(opts);
  latest.current = opts;
  useEffect(() => {
    if (!opts.enabled) return;
    let saved: { panel: string; shade: string } | null = null;
    const parts = () => {
      const panel = latest.current.drawer.current;
      return { panel, shade: panel?.previousElementSibling as HTMLElement | null };
    };
    const restore = (animate: boolean) => {
      const { panel, shade } = parts();
      if (!panel || !saved) return;
      const was = saved;
      saved = null;
      if (animate && !reducedMotion()) {
        panel.style.transition = `transform 300ms ${EASE}, visibility 0s linear 300ms`;
        if (shade) shade.style.transition = `opacity 300ms ${EASE}`;
      }
      panel.style.transform = "translateX(-104%)";
      panel.style.visibility = "hidden";
      if (shade) shade.style.opacity = "0";
      setTimeout(() => {
        panel.style.cssText = was.panel;
        if (shade) shade.style.cssText = was.shade;
      }, animate ? 320 : 0);
    };
    return bindTouchSwipe(document, {
      accept: (target, x) => {
        const o = latest.current;
        if (!isEdgeStart(x) || !phone() || o.blocked() || swipeBlocked(target)) return null;
        return o.drawer.current;
      },
      distance: (panel) => (panel as HTMLElement).offsetWidth / 3,
      onMove: (dx) => {
        const { panel, shade } = parts();
        if (!panel) return;
        saved ??= { panel: panel.style.cssText, shade: shade?.style.cssText ?? "" };
        const w = panel.offsetWidth;
        const p = drawerProgress(dx, w);
        panel.style.transition = "none";
        panel.style.visibility = "visible";
        panel.style.transform = `translateX(${(p - 1) * w}px)`;
        if (shade) {
          shade.style.transition = "none";
          shade.style.opacity = String(p);
        }
      },
      onEnd: (dir) => {
        const { panel, shade } = parts();
        if (!panel || !saved) return;
        if (dir !== 1) return restore(true);
        /* back to the closed state's styles, except where the finger left it: opening then slides on from there */
        const at = panel.style.transform;
        const shown = shade?.style.opacity ?? "0";
        const was = saved;
        saved = null;
        panel.style.cssText = was.panel;
        panel.style.visibility = "visible";
        panel.style.transform = at;
        panel.style.transition = reducedMotion() ? "none" : `transform 300ms ${EASE}`;
        if (shade) {
          shade.style.cssText = was.shade;
          shade.style.opacity = shown;
        }
        latest.current.open();
      },
    });
  }, [opts.enabled]);
}

/* ── row swipe: archive or pin a session ────────────────── */

export type RowSwipe = {
  enabled: boolean;
  /** what each side does for this row ("Archive" or "Unarchive", "Pin" or "Unpin") */
  labels: (id: string) => { left: string; right: string };
  onLeft: (id: string) => void;
  onRight: (id: string) => void;
};

const ROW_LIMIT = 96;

/** Swiping a row (`[data-session-row]`) left or right slides it over the action's color; letting go past the line
 * runs the action (the list's own archive and pin, with their Undo). */
export function useRowSwipe(list: RefObject<HTMLElement | null>, opts: RowSwipe) {
  const latest = useRef(opts);
  latest.current = opts;
  useEffect(() => {
    const el = list.current;
    if (!opts.enabled || !el) return;
    let under: HTMLElement | null = null;
    let side = 0;
    const paint = (row: HTMLElement, dx: number) => {
      const wrap = row.parentElement;
      if (!wrap) return;
      if (!under) {
        under = document.createElement("div");
        under.setAttribute("aria-hidden", "true");
        under.dataset.swipeUnder = "";
        under.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;padding:0 14px;font-size:12.5px;font-weight:600;color:white;pointer-events:none";
        under.style.borderRadius = getComputedStyle(row).borderRadius;
        wrap.style.overflow = "hidden";
        wrap.prepend(under);
        const bg = getComputedStyle(row).backgroundColor;
        row.style.background = `linear-gradient(${bg}, ${bg}), var(--sidebar)`;
        row.style.zIndex = "1";
      }
      const s = Math.sign(dx);
      if (s !== side && s !== 0) {
        side = s;
        const { left, right } = latest.current.labels(row.dataset.sessionRow ?? "");
        under.textContent = s < 0 ? left : right;
        under.style.justifyContent = s < 0 ? "flex-end" : "flex-start";
        under.style.background = s < 0 ? "var(--orange)" : "var(--accent)";
      }
      row.style.transition = "none";
      row.style.transform = `translateX(${rubberBand(dx, ROW_LIMIT)}px)`;
    };
    const settle = (row: HTMLElement, to: number, then: () => void) => {
      const quick = reducedMotion();
      const layer = under;
      under = null;
      side = 0;
      row.style.transition = quick ? "none" : `transform 200ms ${EASE}`;
      row.style.transform = `translateX(${to}px)`;
      const clean = () => {
        layer?.remove();
        row.style.transition = row.style.transform = row.style.background = row.style.zIndex = "";
        if (row.parentElement) row.parentElement.style.overflow = "";
      };
      setTimeout(
        () => {
          then();
          /* a row swiped away stays out until the list drops it (archive shows at once), not back for a frame */
          setTimeout(clean, to ? 150 : 0);
        },
        quick ? 0 : 210,
      );
    };
    return bindPointerSwipe(el, {
      accept: (target) => {
        const row = target.closest<HTMLElement>("[data-session-row]");
        return row && el.contains(row) && !swipeBlocked(target, row) ? row : null;
      },
      distance: () => ROW_LIMIT * 0.8,
      onMove: (dx, row) => paint(row as HTMLElement, dx),
      onEnd: (dir, _dx, row) => {
        const r = row as HTMLElement;
        const id = r.dataset.sessionRow ?? "";
        if (dir === -1) settle(r, -r.offsetWidth, () => latest.current.onLeft(id));
        else if (dir === 1) settle(r, 0, () => latest.current.onRight(id));
        else settle(r, 0, () => undefined);
      },
    });
  }, [list, opts.enabled]);
}

/* ── header swipe: switch tabs ──────────────────────────── */

/** Swiping across a `[data-swipe-tabs]` header goes to the next tab (left) or the previous one (right). */
export function useTabSwipe(root: RefObject<HTMLElement | null>, opts: { enabled: boolean; cycle: (delta: number) => void }) {
  const latest = useRef(opts);
  latest.current = opts;
  useEffect(() => {
    const el = root.current;
    if (!opts.enabled || !el) return;
    const body = (header: Element) => header.firstElementChild as HTMLElement | null;
    return bindPointerSwipe(el, {
      accept: (target, x) => {
        /* the edge belongs to the drawer, and an open menu to its items */
        if (isEdgeStart(x) || target.closest('[role="menu"]')) return null;
        const header = target.closest("[data-swipe-tabs]");
        return header && !swipeBlocked(target, header) ? header : null;
      },
      distance: (header) => Math.min(120, (header as HTMLElement).offsetWidth / 4),
      onMove: (dx, header) => {
        const b = body(header);
        if (!b) return;
        b.style.transition = "none";
        b.style.transform = `translateX(${rubberBand(dx / 3, 24)}px)`;
      },
      onEnd: (dir, _dx, header) => {
        const b = body(header);
        if (b) {
          b.style.transition = reducedMotion() ? "none" : `transform 200ms ${EASE}`;
          b.style.transform = "";
        }
        if (dir) latest.current.cycle(dir === -1 ? 1 : -1);
      },
    });
  }, [root, opts.enabled]);
}
