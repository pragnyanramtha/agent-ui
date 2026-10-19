import type { Settings } from "@/lib/settings-schema";

/** Lines over which "Collapse large files" (Settings > Git > Files in a diff) starts a file folded. */
export const BIG_FILE_LINES = 400;

/** Whether a diff's file starts expanded, before the user opens or folds it. */
export function fileStartsOpen(state: Settings["diffFileState"], lines: number, big = BIG_FILE_LINES): boolean {
  if (state === "expanded") return true;
  if (state === "collapsed") return false;
  return lines <= big;
}
