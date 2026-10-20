/** Start offsets of each case-insensitive, non-overlapping match of `needle` in `text`, at most `max` of them. */
export function matchOffsets(text: string, needle: string, max = Infinity): number[] {
  const out: number[] = [];
  const hay = text.toLowerCase();
  const n = needle.toLowerCase();
  if (!n) return out;
  for (let i = hay.indexOf(n); i !== -1 && out.length < max; i = hay.indexOf(n, i + n.length)) out.push(i);
  return out;
}

/**
 * Where the `nth` match inside one element went after it re-rendered (a collapsed code block opening, say):
 * the index in `list` of the nth match that is still `inside` it, or of its last one if fewer came back.
 * -1 when none did.
 */
export function nthWithin<T>(list: readonly T[], inside: (item: T) => boolean, nth: number): number {
  let last = -1;
  let seen = 0;
  for (let i = 0; i < list.length; i++) {
    if (!inside(list[i])) continue;
    if (seen++ === nth) return i;
    last = i;
  }
  return last;
}
