import { editsIn, type Block } from "./turns";

/* The prompt timeline: one mark per prompt along the whole thread. A long thread renders only its newest blocks
 * (lib/client/thread-window), so positions mix two measures: blocks older than the window count at their estimated
 * height, rendered ones at where they really are. Once everything is rendered the estimate drops out. */

export type PromptMark = {
  key: string;
  /** index of the prompt's block */
  index: number;
  text: string;
  ts: string;
  failed: boolean;
  waiting: boolean;
  changed: boolean;
};

/** How far below the top of the view a prompt lands after a jump, in px. */
export const JUMP_MARGIN = 16;

/** The first non-empty line of a prompt, cut to `max` characters. */
export function firstLine(text: string, max = 90): string {
  const line = text.split("\n").find((l) => l.trim())?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A mark per prompt, with what its turn left behind: an error, a question waiting on you, changed files. */
export function promptMarks(blocks: Block[], opts: { waiting?: boolean; lastFailed?: boolean } = {}): PromptMark[] {
  const out: PromptMark[] = [];
  let cur: PromptMark | null = null;
  blocks.forEach((b, index) => {
    if (b.type === "user") {
      cur = { key: b.key, index, text: b.entry.text, ts: b.entry.ts, failed: false, waiting: false, changed: false };
      out.push(cur);
      return;
    }
    if (!cur) return;
    if (b.type === "changes" || (b.type === "run" && editsIn(b.items).length > 0)) cur.changed = true;
    else if (b.type === "notice" && b.entry.tone === "warn" && b.entry.text !== "Stopped") cur.failed = true;
  });
  const last = out[out.length - 1];
  if (last) {
    if (opts.lastFailed) last.failed = true;
    if (opts.waiting) last.waiting = true;
  }
  return out;
}

/** Running totals of the blocks' estimated heights: `sums[i]` is everything above block i. */
export function prefixSums(heights: readonly number[]): number[] {
  const out = new Array<number>(heights.length + 1);
  out[0] = 0;
  for (let i = 0; i < heights.length; i++) out[i + 1] = out[i] + heights[i];
  return out;
}

/**
 * Each prompt's distance from the top of the whole thread, in px. `start` is the first rendered block; `measured`
 * gives a rendered prompt's top inside the scroll box (or null when it isn't in the page yet). Everything rendered
 * sits below `sums[start]`, the estimated height of what isn't.
 */
export function promptOffsets(marks: readonly Pick<PromptMark, "index" | "key">[], start: number, sums: readonly number[], measured: (key: string) => number | null): number[] {
  const above = sums[Math.min(start, sums.length - 1)] ?? 0;
  let floor = 0;
  return marks.map((m) => {
    const real = m.index < start ? null : measured(m.key);
    const top = real === null ? (sums[m.index] ?? 0) : above + real;
    /* never above the one before: a block taking its real height between two reads mustn't reorder the marks */
    floor = Math.max(floor, top);
    return floor;
  });
}

/** Offsets as fractions of the whole thread, for the strip. */
export const fractions = (offsets: readonly number[], total: number) => offsets.map((o) => (total > 0 ? Math.min(1, Math.max(0, o / total)) : 0));

/** The prompt the reader is in: the last one starting at or above the reading line (`top`, in the same px). */
export function currentPrompt(offsets: readonly number[], top: number, slack = 8): number {
  let cur = -1;
  for (let i = 0; i < offsets.length && offsets[i] <= top + slack; i++) cur = i;
  return cur;
}

/** Where Alt+Up or Alt+Down goes from the reading line: the prompt above it or the next one below; null at either end. */
export function adjacentPrompt(offsets: readonly number[], top: number, dir: -1 | 1, slack = 8): number | null {
  if (dir > 0) {
    const i = offsets.findIndex((o) => o > top + slack);
    return i === -1 ? null : i;
  }
  for (let i = offsets.length - 1; i >= 0; i--) if (offsets[i] < top - slack) return i;
  return null;
}
