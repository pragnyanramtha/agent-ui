import { describe, expect, it } from "vitest";
import { estimateHeight, growWindow, windowStart, WINDOW_INITIAL } from "@/lib/client/thread-window";
import type { Block } from "@/lib/client/turns";

const keys = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `b${from + i}`);

describe("thread window", () => {
  it("opens on the newest blocks, or all of a short thread", () => {
    expect(windowStart(keys(1500), undefined)).toBe(1500 - WINDOW_INITIAL);
    expect(windowStart(keys(12), undefined)).toBe(0);
    expect(windowStart([], undefined)).toBe(0);
  });

  it("keeps its first block when blocks are appended", () => {
    const k = keys(100);
    const first = k[windowStart(k, undefined)];
    expect(windowStart(keys(130), first)).toBe(60);
  });

  it("leaves prepended history outside until the window grows", () => {
    const before = keys(100, 500);
    const first = before[0];
    const after = [...keys(500), ...before];
    expect(windowStart(after, first)).toBe(500);
    expect(growWindow(after, 500, 60)).toBe("b440");
  });

  it("starts over from the end when its first block is gone", () => {
    expect(windowStart(keys(100), "missing", 40)).toBe(60);
  });

  it("grows back to the first block and stops there", () => {
    const k = keys(100);
    expect(growWindow(k, 60, 60)).toBe("b0");
    expect(growWindow(k, 0, 60)).toBe("b0");
    expect(growWindow([], 0, 60)).toBeUndefined();
  });

  it("sizes skipped blocks from their content", () => {
    const user = (text: string) => ({ type: "user", key: "u", entry: { kind: "user", id: "u", ts: "", text } }) as unknown as Block;
    const text = (t: string) => ({ type: "text", key: "t", entry: { kind: "text", id: "t", ts: "", text: t } }) as unknown as Block;
    expect(estimateHeight(user("hi"))).toBe(72);
    expect(estimateHeight(user("line\n".repeat(200)))).toBe(340);
    expect(estimateHeight(text("a".repeat(900)))).toBeGreaterThan(estimateHeight(text("a".repeat(90))));
    const fold = { type: "fold", key: "f", blocks: [text("x"), text("y")], tools: 2, ms: 1000 } as unknown as Block;
    expect(estimateHeight(fold)).toBe(48);
    expect(estimateHeight(fold, true)).toBe(48 + 2 * (16 + 34));
  });
});
