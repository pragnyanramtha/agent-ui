import { reducedMotion } from "./motion";

/* FLIP for lists that reorder: measure where each keyed row sits, let React move them, measure again, then play each
 * row from where it was to where it is with the Web Animations API. A move is capped (a row that jumps far just
 * slides the last stretch) and so is the number of rows animated at once. Off under Reduce motion. */

export const FLIP_MS = 150;
export const FLIP_MAX_TRAVEL = 40;
export const FLIP_MAX_ROWS = 40;

/** The offset a row starts from (old top minus new top), capped to `cap` either way; null when it didn't move. */
export function flipDelta(from: number | undefined, to: number, cap = FLIP_MAX_TRAVEL): number | null {
  if (from === undefined) return null;
  const d = from - to;
  if (Math.abs(d) < 0.5) return null;
  return Math.max(-cap, Math.min(cap, d));
}

/** Which rows to animate and from where: rows present both times that moved, nearest the visible window first, at most
 * `maxRows`. `view` is the visible span in the same coordinates; rows wholly outside it don't animate. */
export function planFlip(prev: ReadonlyMap<string, number>, next: ReadonlyMap<string, number>, opts: { cap?: number; maxRows?: number; view?: readonly [number, number]; rowHeight?: number } = {}): { key: string; delta: number }[] {
  const { cap = FLIP_MAX_TRAVEL, maxRows = FLIP_MAX_ROWS, view, rowHeight = 0 } = opts;
  const out: { key: string; delta: number; top: number }[] = [];
  for (const [key, top] of next) {
    const delta = flipDelta(prev.get(key), top, cap);
    if (delta === null) continue;
    if (view && (top + rowHeight < view[0] - cap || top > view[1] + cap)) continue;
    out.push({ key, delta, top });
  }
  out.sort((a, b) => a.top - b.top);
  return out.slice(0, maxRows).map(({ key, delta }) => ({ key, delta }));
}

/** Where a running animation has got to: the share of its offset still to travel. */
export const remaining = (delta: number, progress: number) => delta * (1 - Math.max(0, Math.min(1, progress)));

type Running = { animation: Animation; delta: number };

/**
 * Watches the rows matching `selector` inside `container`. Call `update()` after every render that may have moved them
 * (a layout effect): the first call only measures. `target` picks the element to move (default: the row itself).
 */
export function createFlip(container: HTMLElement, opts: { selector: string; key: (el: HTMLElement) => string | undefined; target?: (el: HTMLElement) => HTMLElement | null }) {
  let tops: Map<string, number> | null = null;
  const running = new Map<string, Running>();
  const progressOf = (a: Animation) => (a.playState === "finished" ? 1 : (a.effect?.getComputedTiming().progress ?? 1));

  return {
    update() {
      const rows = [...container.querySelectorAll<HTMLElement>(opts.selector)];
      /* where each row shows right now, counting a move still under way */
      const carried = new Map<string, number>();
      for (const [key, r] of running) {
        carried.set(key, remaining(r.delta, progressOf(r.animation)));
        r.animation.cancel();
      }
      running.clear();
      const box = container.getBoundingClientRect();
      const origin = box.top - container.scrollTop;
      const next = new Map<string, number>();
      const els = new Map<string, HTMLElement>();
      let rowHeight = 0;
      for (const el of rows) {
        const key = opts.key(el);
        if (!key || next.has(key)) continue;
        const r = el.getBoundingClientRect();
        if (!r.height) continue;
        rowHeight = Math.max(rowHeight, r.height);
        next.set(key, r.top - origin);
        els.set(key, el);
      }
      const prev = tops;
      tops = next;
      if (!prev || reducedMotion()) return;
      const shown = new Map([...prev].map(([k, top]) => [k, top + (carried.get(k) ?? 0)]));
      const view = [container.scrollTop, container.scrollTop + box.height] as const;
      for (const { key, delta } of planFlip(shown, next, { view, rowHeight })) {
        const el = els.get(key);
        const target = el && (opts.target ? opts.target(el) : el);
        if (typeof target?.animate !== "function") continue;
        const animation = target.animate([{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }], { duration: FLIP_MS, easing: "ease-out" });
        running.set(key, { animation, delta });
        animation.addEventListener("finish", () => running.get(key)?.animation === animation && running.delete(key), { once: true });
      }
    },
    dispose() {
      for (const r of running.values()) r.animation.cancel();
      running.clear();
      tops = null;
    },
  };
}
