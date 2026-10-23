import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { typeable, typeIntoTerminal } from "@/lib/server/input";

/* A fake tmux/zellij on PATH records every call, one JSON line each (with a delay, so overlapping writers would interleave). */
const bin = fs.mkdtempSync(path.join(os.tmpdir(), "agentu-input-"));
const log = path.join(bin, "calls.log");
for (const name of ["tmux", "zellij"]) {
  fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env node\nsetTimeout(() => require("fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify([${JSON.stringify(name)}, ...process.argv.slice(2)]) + "\\n"), 15);\n`, { mode: 0o755 });
}
const PATH = process.env.PATH;
process.env.PATH = `${bin}:${PATH}`;
afterAll(() => {
  process.env.PATH = PATH;
  fs.rmSync(bin, { recursive: true, force: true });
});
beforeEach(() => fs.rmSync(log, { force: true }));
const calls = (): string[][] => fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));

describe("typing into terminals", () => {
  it("strips what a terminal would act on: newlines, tabs, escapes, other control chars", () => {
    expect(typeable("a\nb\r\nc\tд\u001b[2J\u0003e 🙂")).toBe("a b c  д[2Je 🙂");
  });

  it("keeps line breaks when asked, still dropping the other control chars", () => {
    expect(typeable("a\nb\r\n\r\nc\u001b\td", { newlines: true })).toBe("a\nb\n\nc  d");
  });

  it("multi-line text: each line literal, Ctrl+J between, one Enter at the end", async () => {
    await typeIntoTerminal({ kind: "tmux", pane: "%4" }, "first\n\nthird", { checkPrompt: false, newlines: true });
    expect(calls()).toEqual([
      ["tmux", "send-keys", "-t", "%4", "-l", "--", "first"],
      ["tmux", "send-keys", "-t", "%4", "C-j"],
      ["tmux", "send-keys", "-t", "%4", "C-j"],
      ["tmux", "send-keys", "-t", "%4", "-l", "--", "third"],
      ["tmux", "send-keys", "-t", "%4", "Enter"],
    ]);
  });

  it("zellij: line break is byte 10", async () => {
    await typeIntoTerminal({ kind: "zellij", session: "s", pane: "terminal_2" }, "a\nb", { checkPrompt: false, newlines: true });
    expect(calls().map((c) => c.slice(-1)[0])).toEqual(["a", "10", "b", "13"]);
  });

  it("tmux: literal text, then Enter; text starting with a dash isn't read as flags", async () => {
    await typeIntoTerminal({ kind: "tmux", pane: "%3" }, "-x fix the list", { checkPrompt: false });
    expect(calls()).toEqual([
      ["tmux", "send-keys", "-t", "%3", "-l", "--", "-x fix the list"],
      ["tmux", "send-keys", "-t", "%3", "Enter"],
    ]);
  });

  it("zellij: `--` before the text", async () => {
    await typeIntoTerminal({ kind: "zellij", session: "s", pane: "terminal_1" }, "--help me", { checkPrompt: false });
    expect(calls()[0]).toEqual(["zellij", "--session", "s", "action", "write-chars", "-p", "terminal_1", "--", "--help me"]);
  });

  it("long text goes in pieces under tmux's limit, emoji intact, then one Enter", async () => {
    const text = "🙂".repeat(9000);
    await typeIntoTerminal({ kind: "tmux", pane: "%1" }, text, { checkPrompt: false });
    const c = calls();
    const pieces = c.filter((x) => x.includes("-l")).map((x) => x.at(-1)!);
    expect(pieces.length).toBe(5);
    expect(pieces.every((p) => Buffer.byteLength(p) <= 8000)).toBe(true);
    expect(pieces.join("")).toBe(text);
    expect(c.at(-1)).toEqual(["tmux", "send-keys", "-t", "%1", "Enter"]);
  });

  it("two sends to one pane never interleave", async () => {
    const pane = { kind: "tmux" as const, pane: "%9" };
    await Promise.all([typeIntoTerminal(pane, "first", { checkPrompt: false }), typeIntoTerminal(pane, "second", { checkPrompt: false })]);
    expect(calls().map((x) => x.at(-1))).toEqual(["first", "Enter", "second", "Enter"]);
  });
});
