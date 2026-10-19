"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useSetting } from "./settings";

/* On a phone the composer takes a third of the screen. Scrolling back through the thread folds it into a one-line
 * pill (Settings > Composer > Shrink while reading back); focus, a tap on the pill, or getting near the end brings it
 * back. Only transforms move: the thread's padding stays, so nothing in it jumps. */

/** scrolling up this far in one go folds it */
export const COLLAPSE_AFTER_PX = 48;
/** this close to the end it's open */
export const NEAR_END_PX = 160;

export type CollapseState = { collapsed: boolean; travel: number };

/** One scroll event: `delta` is the change in scrollTop (negative going up), `fromEnd` the distance left to the end.
 * `held` keeps it open (the box has focus, or a notice above it needs reading). */
export function collapseStep(s: CollapseState, delta: number, fromEnd: number, held: boolean): CollapseState {
  if (held || fromEnd <= NEAR_END_PX) return { collapsed: false, travel: 0 };
  if (delta >= 0) return { collapsed: s.collapsed, travel: 0 };
  const travel = s.travel - delta;
  return travel >= COLLAPSE_AFTER_PX ? { collapsed: true, travel: 0 } : { collapsed: s.collapsed, travel };
}

const PHONE = "(max-width: 767px) and (pointer: coarse)";

/** Watches the thread's scroller (`[role="log"]` inside `scope`) and says when the composer should fold. */
export function useComposerCollapse(scope: RefObject<HTMLElement | null>, composer: RefObject<HTMLElement | null>, held: boolean) {
  const [enabled] = useSetting("composerCollapseOnScroll");
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(PHONE);
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const active = enabled && phone;
  const [collapsed, setCollapsed] = useState(false);
  const state = useRef<CollapseState>({ collapsed: false, travel: 0 });
  const heldRef = useRef(held);
  heldRef.current = held;

  const expand = useCallback(() => {
    state.current = { collapsed: false, travel: 0 };
    setCollapsed(false);
  }, []);

  useEffect(() => {
    if (held) expand();
  }, [held, expand]);

  useEffect(() => {
    const root = scope.current;
    if (!active || !root) return expand();
    let scroller: HTMLElement | null = null;
    let last = 0;
    const onScroll = (e: Event) => {
      const el = e.target;
      if (!(el instanceof HTMLElement) || el.getAttribute("role") !== "log") return;
      const top = el.scrollTop;
      const delta = el === scroller ? top - last : 0;
      scroller = el;
      last = top;
      const focused = Boolean(composer.current?.contains(document.activeElement));
      state.current = collapseStep(state.current, delta, el.scrollHeight - top - el.clientHeight, heldRef.current || focused);
      setCollapsed(state.current.collapsed);
    };
    const box = composer.current;
    root.addEventListener("scroll", onScroll, { capture: true, passive: true });
    box?.addEventListener("focusin", expand);
    return () => {
      root.removeEventListener("scroll", onScroll, { capture: true });
      box?.removeEventListener("focusin", expand);
    };
  }, [active, scope, composer, expand]);

  return { collapsed: active && collapsed, expand };
}
