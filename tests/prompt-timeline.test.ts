import { describe, expect, it } from "vitest";
import { adjacentPrompt, currentPrompt, firstLine, fractions, prefixSums, promptMarks, promptOffsets } from "@/lib/client/prompt-timeline";
import type { Block } from "@/lib/client/turns";

const user = (key: string, text: string, ts = "2026-10-19T10:00:00.000Z"): Block => ({
  type: "user",
  key,
  entry: { kind: "user", id: key, text, ts, images: 0 },
});

const text = (key: string, body: string): Block => ({
  type: "text",
  key,
  entry: { kind: "text", id: key, msgId: key, text: body, ts: "2026-10-19T10:01:00.000Z" },
});

describe("prompt marks", () => {
  it("collects one mark per user block and flags the last turn", () => {
    const blocks = [user("u1", "hello"), text("t1", "hi"), user("u2", "fix it"), text("t2", "done")];
    const marks = promptMarks(blocks, { waiting: true, lastFailed: true });
    expect(marks).toHaveLength(2);
    expect(marks[0].text).toBe("hello");
    expect(marks[1].waiting).toBe(true);
    expect(marks[1].failed).toBe(true);
  });

  it("truncates the hover preview to one line", () => {
    expect(firstLine("line one\nline two")).toBe("line one");
    expect(firstLine("x".repeat(120)).length).toBe(90);
    expect(firstLine("x".repeat(120)).endsWith("…")).toBe(true);
  });
});

describe("prompt offsets", () => {
  const heights = [100, 50, 200, 80];
  const sums = prefixSums(heights);
  const marks = [{ key: "a", index: 0 }, { key: "b", index: 1 }, { key: "c", index: 2 }, { key: "d", index: 3 }];

  it("uses estimates before the window and measured tops inside it", () => {
    const measured = (k: string) => (k === "c" ? 40 : null);
    const offsets = promptOffsets(marks, 2, sums, measured);
    expect(offsets[0]).toBe(sums[0]);
    expect(offsets[1]).toBe(sums[1]);
    expect(offsets[2]).toBe(sums[2] + 40);
    expect(offsets[3]).toBeGreaterThanOrEqual(offsets[2]);
  });

  it("never reorders marks when a block grows between reads", () => {
    const a = promptOffsets(marks, 0, sums, () => null);
    const b = promptOffsets(marks, 0, sums, (k) => (k === "b" ? 999 : null));
    for (let i = 1; i < a.length; i++) expect(a[i]).toBeGreaterThanOrEqual(a[i - 1]);
    for (let i = 1; i < b.length; i++) expect(b[i]).toBeGreaterThanOrEqual(b[i - 1]);
  });

  it("maps offsets to fractions along the thread", () => {
    expect(fractions([0, 50, 100], 200)).toEqual([0, 0.25, 0.5]);
    expect(fractions([], 0)).toEqual([]);
  });
});

describe("prompt navigation", () => {
  const offsets = [0, 100, 250, 400];

  it("finds the prompt at the reading line", () => {
    expect(currentPrompt(offsets, 0)).toBe(0);
    expect(currentPrompt(offsets, 120)).toBe(1);
    expect(currentPrompt(offsets, 500)).toBe(3);
  });

  it("steps to the previous and next prompt", () => {
    expect(adjacentPrompt(offsets, 120, -1)).toBe(1);
    expect(adjacentPrompt(offsets, 120, 1)).toBe(2);
    expect(adjacentPrompt(offsets, 0, -1)).toBeNull();
    expect(adjacentPrompt(offsets, 500, 1)).toBeNull();
  });
});
