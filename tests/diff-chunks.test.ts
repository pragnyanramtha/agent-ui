import { describe, expect, it } from "vitest";
import { chunkRows, chunkText, diffRows, CHUNK_ROWS } from "@/lib/client/diff-chunks";
import type { PatchFile, PatchLine } from "@/lib/client/diff";

const ctx = (n: number, text = `line ${n}`): PatchLine => ({ type: "ctx", oldNo: n, newNo: n, text });
const file = (lines: PatchLine[][]): PatchFile =>
  ({
    path: "a.ts",
    status: "modified",
    additions: 0,
    deletions: 0,
    binary: false,
    truncated: false,
    hunks: lines.map((l, i) => ({ header: `@@ hunk ${i} @@`, oldStart: 1, newStart: 1, lines: l })),
  }) as unknown as PatchFile;

describe("diff chunks", () => {
  it("lists hunk headers and lines in order", () => {
    const rows = diffRows(file([[ctx(1), ctx(2)], [ctx(9)]]), false);
    expect(rows.map((r) => r.kind)).toEqual(["hunk", "line", "line", "hunk", "line"]);
  });

  it("pairs removals with additions side by side", () => {
    const del: PatchLine = { type: "del", oldNo: 2, text: "old" };
    const add: PatchLine = { type: "add", newNo: 2, text: "new" };
    const rows = diffRows(file([[ctx(1), del, add]]), true);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toEqual({ kind: "pair", left: del, right: add });
    expect(chunkText(rows)).toBe("@@ hunk 0 @@\nline 1\nold\tnew");
  });

  it("cuts rows into runs, the last one shorter", () => {
    const rows = Array.from({ length: CHUNK_ROWS * 2 + 5 }, (_, i) => i);
    const chunks = chunkRows(rows);
    expect(chunks.map((c) => c.length)).toEqual([CHUNK_ROWS, CHUNK_ROWS, 5]);
    expect(chunks.flat()).toEqual(rows);
    expect(chunkRows([])).toEqual([]);
  });

  it("stands in for unmounted rows with one text line per row", () => {
    const rows = diffRows(file([[ctx(1, "alpha"), ctx(2, ""), ctx(3, "gamma")]]), false);
    const text = chunkText(rows);
    expect(text.split("\n")).toHaveLength(rows.length);
    expect(text).toContain("alpha");
  });
});
