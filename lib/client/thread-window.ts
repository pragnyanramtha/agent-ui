import type { Block } from "./turns";

/** Blocks a long thread renders when it opens: the newest ones, enough to fill a tall screen several times. */
export const WINDOW_INITIAL = 40;
/** Older blocks added each time the reader nears the top. */
export const WINDOW_STEP = 60;
/** Blocks added per frame while find fills in the whole thread. */
export const WINDOW_FILL_STEP = 200;

/**
 * Index of the first block to render. The window is remembered by the key of its first block, so history
 * prepended by "Load earlier messages" stays outside it until the reader scrolls up, and new blocks at the
 * end always render. With no key yet (or one that no longer exists) it starts `initial` blocks from the end.
 */
export function windowStart(keys: readonly string[], first: string | undefined, initial = WINDOW_INITIAL): number {
  if (first !== undefined) {
    const i = keys.indexOf(first);
    if (i !== -1) return i;
  }
  return Math.max(0, keys.length - initial);
}

/** The key that moves the window `step` blocks further back, or undefined when there is nothing to show. */
export function growWindow(keys: readonly string[], start: number, step = WINDOW_STEP): string | undefined {
  if (!keys.length) return undefined;
  return keys[Math.max(0, Math.min(start, keys.length) - step)];
}

const lineCount = (text: string, perLine: number) => text.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);

/**
 * A guess at a block's height in pixels, for `contain-intrinsic-size` on blocks that are skipped while off
 * screen. Only the first layout uses it ("auto" keeps the real size after that), so it only has to keep the
 * scrollbar and Jump to latest roughly right before the reader gets there.
 */
export function estimateHeight(b: Block, foldsOpen = false): number {
  switch (b.type) {
    case "user":
      return Math.min(340, 48 + 24 * lineCount(b.entry.text, 60));
    case "text":
      return Math.min(6000, 8 + 26 * lineCount(b.entry.text, 90));
    case "notice":
      return b.entry.text.includes("\n") ? Math.min(256, 20 + 18 * lineCount(b.entry.text, 100)) : 32;
    case "changes":
      return 44;
    case "run":
      return 8 + 32 * b.items.length;
    case "fold":
      return foldsOpen ? 48 + b.blocks.reduce((n, c) => n + 16 + estimateHeight(c), 0) : 48;
  }
}
