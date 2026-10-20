import { describe, expect, it } from "vitest";
import type { DiffRow } from "@/lib/client/diff-chunks";
import { anchorRow, commentLabel, reviewBlock, stillMatches, withReviewBlock } from "@/lib/client/review";

const rows: DiffRow[] = [
  { kind: "hunk", header: "@@ -1,2 +1,2 @@" },
  { kind: "line", line: { type: "ctx", oldNo: 1, newNo: 1, text: "alpha" } },
  { kind: "line", line: { type: "add", oldNo: undefined, newNo: 2, text: "beta" } },
];

describe("anchorRow", () => {
  it("finds the row that shows the comment's last line", () => {
    expect(anchorRow(rows, { lines: [{ type: "ctx", oldNo: 1, newNo: 1, text: "alpha" }] })).toBe(1);
    expect(anchorRow(rows, { lines: [{ type: "add", oldNo: undefined, newNo: 2, text: "beta" }] })).toBe(2);
  });

  it("returns -1 when the diff no longer has that line", () => {
    expect(anchorRow(rows, { lines: [{ type: "ctx", oldNo: 1, newNo: 1, text: "gone" }] })).toBe(-1);
  });
});

describe("stillMatches", () => {
  it("checks new-file lines on disk and ignores removed-only comments", () => {
    const c = { lines: [{ type: "add" as const, oldNo: undefined, newNo: 2, text: "beta" }] };
    expect(stillMatches(c, "alpha\nbeta")).toBe(true);
    expect(stillMatches(c, "alpha\nother")).toBe(false);
    expect(stillMatches(c, null)).toBe(false);
    expect(stillMatches({ lines: [{ type: "del" as const, oldNo: 1, text: "old" }] }, "anything")).toBe(true);
  });
});

describe("reviewBlock", () => {
  it("formats paths, a diff snippet, and the comment body", () => {
    const block = reviewBlock([
      {
        label: "src/a.ts:1-2",
        lines: [
          { type: "ctx", oldNo: 1, newNo: 1, text: "a" },
          { type: "add", oldNo: undefined, newNo: 2, text: "b" },
        ],
        body: "Please rename this.",
      },
    ]);
    expect(block).toContain("Review comments:");
    expect(block).toContain("src/a.ts:1-2");
    expect(block).toContain("```diff");
    expect(block).toContain(" a");
    expect(block).toContain("+b");
    expect(block).toContain("Please rename this.");
  });
});

describe("withReviewBlock", () => {
  it("appends the block before attachment paths", () => {
    expect(withReviewBlock("Hello", "Review comments:\n\nx")).toBe("Hello\n\nReview comments:\n\nx");
    expect(withReviewBlock("Hello\n\nAttached files:\n- /tmp/x.txt", "Review comments:\n\nx")).toBe("Hello\n\nReview comments:\n\nx\n\nAttached files:\n- /tmp/x.txt");
  });
});

describe("commentLabel", () => {
  it("labels removed lines", () => {
    expect(commentLabel("a.ts", [{ type: "del", oldNo: 3, text: "x" }])).toBe("a.ts:3 (removed)");
  });
});
