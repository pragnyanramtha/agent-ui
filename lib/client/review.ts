/* Review comments on diff lines: where they sit in a file's diff, whether the file still has those lines, and the
 * block they become at the end of the next message. No React, no DOM. */

import { splitAttachments, withAttachments } from "@/lib/attachments";
import type { PatchLine } from "./diff";
import type { DiffRow } from "./diff-chunks";
import { rangeText } from "./line-range";

/** "old" and "new" are the columns of the split layout; the unified layout has one column with both. */
export type DiffSide = "old" | "new" | "both";

export type ReviewLine = { type: PatchLine["type"]; oldNo?: number; newNo?: number; text: string };

export type ReviewComment = {
  id: string;
  /** absolute, for reading the file when the message goes out */
  file: string;
  /** as the diff names it (relative to the repository) */
  path: string;
  lines: ReviewLine[];
  body: string;
  at: number;
};

/** The line a row shows in a column; a unified row has just the one. */
export function rowLine(r: DiffRow, side: DiffSide): PatchLine | null {
  if (r.kind === "hunk") return null;
  if (r.kind === "line") return r.line;
  return side === "old" ? r.left : side === "new" ? r.right : (r.right ?? r.left);
}

/** The first and last line rows of the hunk row `i` is in. */
export function hunkBounds(rows: readonly DiffRow[], i: number): [number, number] {
  let a = i;
  let b = i;
  while (a > 0 && rows[a - 1].kind !== "hunk") a--;
  while (b < rows.length - 1 && rows[b + 1].kind !== "hunk") b++;
  return [a, b];
}

/** `head` kept inside the anchor's hunk: line numbers jump between hunks, so a range never crosses one. */
export function clampToHunk(rows: readonly DiffRow[], anchor: number, head: number): number {
  const [a, b] = hunkBounds(rows, anchor);
  return Math.max(a, Math.min(b, head));
}

/** The lines rows `from`..`to` show in a column, copied (the diff's own objects get replaced on reload). */
export function linesIn(rows: readonly DiffRow[], from: number, to: number, side: DiffSide): ReviewLine[] {
  const out: ReviewLine[] = [];
  for (let i = Math.max(0, from); i <= Math.min(rows.length - 1, to); i++) {
    const l = rowLine(rows[i], side);
    if (l) out.push({ type: l.type, oldNo: l.oldNo, newNo: l.newNo, text: l.text });
  }
  return out;
}

const same = (a: ReviewLine, b: PatchLine | null) => Boolean(b) && a.type === b!.type && a.oldNo === b!.oldNo && a.newNo === b!.newNo && a.text === b!.text;

/** The row a comment shows under (its last line), in either layout; -1 when the diff no longer has that line. */
export function anchorRow(rows: readonly DiffRow[], c: Pick<ReviewComment, "lines">): number {
  const last = c.lines.at(-1);
  if (!last) return -1;
  return rows.findIndex((r) => (r.kind === "line" ? same(last, r.line) : r.kind === "pair" ? same(last, r.left) || same(last, r.right) : false));
}

/** The numbers a comment points at: the new file's where it has any, else the removed lines' old ones. */
export function lineSpan(lines: readonly ReviewLine[]): { side: "new" | "old"; first: number; last: number } | null {
  const fresh = lines.flatMap((l) => (l.newNo !== undefined ? [l.newNo] : []));
  const nums = fresh.length ? fresh : lines.flatMap((l) => (l.oldNo !== undefined ? [l.oldNo] : []));
  if (!nums.length) return null;
  return { side: fresh.length ? "new" : "old", first: Math.min(...nums), last: Math.max(...nums) };
}

/** "src/app.ts:12-14", or for removed lines only "src/app.ts:30 (removed)" */
export function commentLabel(path: string, lines: readonly ReviewLine[]): string {
  const s = lineSpan(lines);
  if (!s) return path;
  return `${path}:${rangeText(s.first, s.last)}${s.side === "old" ? " (removed)" : ""}`;
}

/** Whether the file on disk still has the comment's lines where the diff showed them. Removed lines aren't in the
 * file any more, so a comment on those alone always stands. `file` null: the file is gone. */
export function stillMatches(c: Pick<ReviewComment, "lines">, file: string | null): boolean {
  const fresh = c.lines.filter((l) => l.newNo !== undefined);
  if (!fresh.length) return true;
  if (file === null) return false;
  const lines = file.split("\n");
  return fresh.every((l) => lines[l.newNo! - 1] === l.text);
}

/** Fenced with more backticks than any run inside, lines kept exactly (blank ones too). */
function fence(body: string, lang: string) {
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((m) => m.length));
  const f = "`".repeat(Math.max(3, longest + 1));
  return `${f}${lang}\n${body}\n${f}`;
}

const MARK: Record<ReviewLine["type"], string> = { add: "+", del: "-", ctx: " " };

/** The comment's lines as a diff snippet. */
export const snippet = (lines: readonly ReviewLine[]) => lines.map((l) => `${MARK[l.type]}${l.text}`).join("\n");

/** Comments in file order, then by line. */
export function sortComments<T extends Pick<ReviewComment, "path" | "lines" | "at">>(list: readonly T[]): T[] {
  const start = (c: T) => lineSpan(c.lines)?.first ?? 0;
  return [...list].sort((a, b) => a.path.localeCompare(b.path) || start(a) - start(b) || a.at - b.at);
}

/** What the agent reads: a heading, then per comment where it is, the lines, and what was said about them. */
export function reviewBlock(items: readonly { label: string; lines: readonly ReviewLine[]; body: string }[]): string {
  if (!items.length) return "";
  const parts = items.map((c) => `${c.label}\n${fence(snippet(c.lines), "diff")}\n${c.body.trim()}`);
  return `Review comments:\n\n${parts.join("\n\n")}`;
}

/** The message with the block after its text and before the attached files, which stay last so they're still found. */
export function withReviewBlock(text: string, block: string): string {
  if (!block) return text;
  const { text: body, paths } = splitAttachments(text);
  const joined = body.trim() ? `${body.trimEnd()}\n\n${block}` : block;
  return paths.length ? withAttachments(joined, paths) : joined;
}

/** A path for the agent: relative to the session's folder when it's inside it. */
export function relToRoot(abs: string, root: string | null | undefined): string {
  const r = root?.replace(/\/+$/, "");
  return r && abs.startsWith(`${r}/`) ? abs.slice(r.length + 1) : abs;
}
