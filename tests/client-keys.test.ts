import { describe, expect, it } from "vitest";
import { onFirstLine, onLastLine } from "@/lib/client/caret";
import { comboFor, hasMod } from "@/lib/client/shortcuts";
import { inOrder } from "@/lib/client/useSessions";

describe("caret lines", () => {
  const text = "first\nsecond\nthird";

  it("treats an empty or single-line draft as both first and last line", () => {
    expect(onFirstLine("", 0)).toBe(true);
    expect(onLastLine("", 0)).toBe(true);
    expect(onFirstLine("one line", 4)).toBe(true);
    expect(onLastLine("one line", 4)).toBe(true);
  });

  it("knows the first line ends at the first newline", () => {
    expect(onFirstLine(text, 0)).toBe(true);
    expect(onFirstLine(text, 5)).toBe(true);
    expect(onFirstLine(text, 6)).toBe(false);
    expect(onFirstLine(text, text.length)).toBe(false);
  });

  it("knows the last line starts after the last newline", () => {
    expect(onLastLine(text, text.length)).toBe(true);
    expect(onLastLine(text, 13)).toBe(true);
    expect(onLastLine(text, 12)).toBe(false);
    expect(onLastLine(text, 0)).toBe(false);
  });
});

describe("Mod key", () => {
  const ev = (ctrlKey: boolean, metaKey: boolean) => ({ ctrlKey, metaKey });

  it("is Cmd alone on a Mac", () => {
    expect(hasMod(ev(false, true), true)).toBe(true);
    expect(hasMod(ev(true, false), true)).toBe(false);
    expect(hasMod(ev(true, true), true)).toBe(false);
  });

  it("is Ctrl alone elsewhere", () => {
    expect(hasMod(ev(true, false), false)).toBe(true);
    expect(hasMod(ev(false, true), false)).toBe(false);
  });

  it("labels the terminal toggle, and the key that still works from inside a terminal", () => {
    expect(comboFor("terminal", false, { bindings: {} })).toBe("Ctrl+J");
    expect(comboFor("terminal", true, { bindings: {} })).toBe("⌘J");
    expect(comboFor("terminal", false, { inTerminal: true, bindings: {} })).toBe("Ctrl+`");
    expect(comboFor("terminal", true, { inTerminal: true, bindings: {} })).toBe("⌘J");
  });
});

describe("per-session save order", () => {
  const later = <T>(ms: number, value: T, fail = false) =>
    new Promise<T>((resolve, reject) => setTimeout(() => (fail ? reject(new Error(String(value))) : resolve(value)), ms));

  it("runs a later save only after the earlier one for the same key settles", async () => {
    const queues = new Map<string, Promise<unknown>>();
    const order: string[] = [];
    const archive = inOrder("s1", () => later(30, "archive").then((v) => (order.push(v), v)), queues);
    const undo = inOrder("s1", () => later(1, "undo").then((v) => (order.push(v), v)), queues);
    await expect(Promise.all([archive, undo])).resolves.toEqual(["archive", "undo"]);
    expect(order).toEqual(["archive", "undo"]);
    expect(queues.size).toBe(0);
  });

  it("keeps going after a failed save, and passes the failure to its caller", async () => {
    const queues = new Map<string, Promise<unknown>>();
    const order: string[] = [];
    const first = inOrder("s1", () => later(20, "first", true), queues);
    const second = inOrder("s1", () => later(1, "second").then((v) => (order.push(v), v)), queues);
    await expect(first).rejects.toThrow("first");
    await expect(second).resolves.toBe("second");
    expect(order).toEqual(["second"]);
  });

  it("doesn't hold up other sessions", async () => {
    const queues = new Map<string, Promise<unknown>>();
    const order: string[] = [];
    const a = inOrder("a", () => later(30, "a").then((v) => (order.push(v), v)), queues);
    const b = inOrder("b", () => later(1, "b").then((v) => (order.push(v), v)), queues);
    await Promise.all([a, b]);
    expect(order).toEqual(["b", "a"]);
  });
});
