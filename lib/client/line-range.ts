/* Picking a run of lines with the pointer or the keyboard: a fixed anchor where it started and a head that moves. */

export type LineRange = { anchor: number; head: number };

/** The range as [first, last], whichever way it was picked. */
export const bounds = (r: LineRange): [number, number] => (r.anchor <= r.head ? [r.anchor, r.head] : [r.head, r.anchor]);

export const covers = (r: LineRange | null, i: number) => {
  if (!r) return false;
  const [a, b] = bounds(r);
  return i >= a && i <= b;
};

/** A click at `i`: a new one-line range, or with `extend` (Shift) the old anchor kept and the head moved to `i`. */
export function pick(r: LineRange | null, i: number, extend: boolean): LineRange {
  return extend && r ? { anchor: r.anchor, head: i } : { anchor: i, head: i };
}

/** Arrow keys from `i`, the focused line: Shift grows or shrinks the range from where it started, a plain arrow drops it. */
export function step(r: LineRange | null, i: number, delta: number, extend: boolean, min: number, max: number): { range: LineRange | null; to: number } {
  const to = Math.max(min, Math.min(max, i + delta));
  if (!extend) return { range: null, to };
  const anchor = r && covers(r, i) ? r.anchor : i;
  return { range: { anchor, head: to }, to };
}

/** "12" or "12-20" */
export function rangeText(first: number, last: number) {
  return first === last ? String(first) : `${first}-${last}`;
}
