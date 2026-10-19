"use client";

import { useEffect, useState, type RefObject } from "react";

type Inertable = { inert: boolean };

/* how many open dialogs hold each element inert; nested dialogs stack, and an element
 * that was inert before any dialog opened is never touched */
const held = new Map<Inertable, number>();

/** Makes every sibling except `keep` inert (unreachable by Tab, clicks and assistive tech). Returns the undo. */
export function inertOutside<T extends Inertable>(keep: T, siblings: ArrayLike<T>): () => void {
  const mine: T[] = [];
  for (const el of Array.from(siblings)) {
    if (el === keep) continue;
    const n = held.get(el);
    if (n === undefined && el.inert) continue;
    held.set(el, (n ?? 0) + 1);
    el.inert = true;
    mine.push(el);
  }
  return () => {
    for (const el of mine) {
      const n = (held.get(el) ?? 1) - 1;
      if (n > 0) held.set(el, n);
      else {
        held.delete(el);
        el.inert = false;
      }
    }
  };
}

type Scroller = { scrollWidth: number; clientWidth: number; scrollHeight: number; clientHeight: number };

/** True when the box has content to scroll to along `axis` ("both": either one). */
export function overflows(el: Scroller, axis: "x" | "y" | "both"): boolean {
  const x = el.scrollWidth > el.clientWidth + 1;
  const y = el.scrollHeight > el.clientHeight + 1;
  return axis === "x" ? x : axis === "y" ? y : x || y;
}

/** Whether `ref`'s element currently overflows, kept up to date as it or its content resizes. */
export function useOverflow(ref: RefObject<HTMLElement | null>, axis: "x" | "y" | "both"): boolean {
  const [over, setOver] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setOver(overflows(el, axis)));
    };
    const ro = new ResizeObserver(measure);
    const watch = () => {
      ro.disconnect();
      ro.observe(el);
      for (const c of el.children) ro.observe(c);
      measure();
    };
    watch();
    const mo = new MutationObserver(watch);
    mo.observe(el, { childList: true });
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      mo.disconnect();
    };
  }, [ref, axis]);
  return over;
}

/** For panels that take focus when they open: focus goes back to whatever opened them when they close,
 * unless the user has already moved it somewhere else. */
export function useReturnFocus(panel: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const active = document.activeElement;
    const opener = active instanceof HTMLElement && active !== document.body ? active : null;
    const node = panel.current;
    node?.focus({ preventScroll: true });
    return () => {
      if (!opener?.isConnected) return;
      const now = document.activeElement;
      if (now && now !== document.body && !node?.contains(now)) return;
      opener.focus({ preventScroll: true });
    };
  }, [panel]);
}
