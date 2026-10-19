import { splitRows, type PatchFile, type PatchLine } from "./diff";

/** One row of a file's diff as drawn: a hunk header, a unified line, or a side-by-side pair. */
export type DiffRow = { kind: "hunk"; header: string } | { kind: "line"; line: PatchLine } | { kind: "pair"; left: PatchLine | null; right: PatchLine | null };

/** Rows mounted together. Big enough that a screen needs only a few, small enough that one mounts within a frame. */
export const CHUNK_ROWS = 80;

/** Every row of a file's diff, in order, hunk headers included. */
export function diffRows(f: PatchFile, split: boolean): DiffRow[] {
  const out: DiffRow[] = [];
  for (const h of f.hunks) {
    out.push({ kind: "hunk", header: h.header });
    if (split) for (const r of splitRows(h.lines)) out.push({ kind: "pair", left: r.left, right: r.right });
    else for (const line of h.lines) out.push({ kind: "line", line });
  }
  return out;
}

/** `rows` in runs of `size`. */
export function chunkRows<T>(rows: readonly T[], size = CHUNK_ROWS): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * A not-yet-mounted chunk as plain text, one line per row: it takes the chunk's height at the same line height,
 * and the browser's find in page still reaches it.
 */
export function chunkText(rows: readonly DiffRow[]): string {
  return rows
    .map((r) => {
      if (r.kind === "hunk") return r.header;
      if (r.kind === "line") return r.line.text;
      return r.left === r.right ? (r.left?.text ?? "") : `${r.left?.text ?? ""}\t${r.right?.text ?? ""}`;
    })
    .join("\n");
}
