import { afterEach, describe, expect, it, vi } from "vitest";
import { frameBatch } from "@/lib/client/frame-batch";
import { initial, reducer } from "@/lib/client/useSession";
import type { Entry, ServerEvent } from "@/lib/types";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("frameBatch", () => {
  it("hands a burst over once, on the next frame", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const got: number[][] = [];
    const b = frameBatch<number>((xs) => got.push(xs));
    b.push(1);
    b.push(2);
    b.push(3);
    expect(got).toEqual([]);
    expect(frames).toHaveLength(1);
    frames[0](0);
    expect(got).toEqual([[1, 2, 3]]);
    b.push(4);
    expect(frames).toHaveLength(2);
  });

  it("falls back to a timer when no frame comes (hidden tab)", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const got: string[][] = [];
    const b = frameBatch<string>((xs) => got.push(xs), 100);
    b.push("a");
    vi.advanceTimersByTime(99);
    expect(got).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(got).toEqual([["a"]]);
  });

  it("flush hands over at once and cancel drops what waits", () => {
    vi.useFakeTimers();
    const got: number[][] = [];
    const b = frameBatch<number>((xs) => got.push(xs));
    b.push(1);
    b.flush();
    expect(got).toEqual([[1]]);
    b.push(2);
    b.cancel();
    vi.advanceTimersByTime(1000);
    expect(got).toEqual([[1]]);
  });
});

describe("batched stream events", () => {
  const text = (id: string, t: string): Entry => ({ kind: "text", id, msgId: id, ts: "2026-10-15T10:00:00Z", text: t });
  it("apply exactly like the same events one at a time", () => {
    const events: ServerEvent[] = [
      { type: "entries", entries: [text("a", "one")] },
      { type: "title", title: "New title" },
      { type: "entries", entries: [text("b", "two"), text("a", "one")] },
    ];
    const oneByOne = events.reduce((s, event) => reducer(s, { type: "event", event }), initial());
    const batched = reducer(initial(), { type: "events", events });
    expect(batched.entries.map((e) => e.id)).toEqual(["a", "b"]);
    expect(batched.title).toBe("New title");
    expect(batched).toEqual(oneByOne);
  });
});
