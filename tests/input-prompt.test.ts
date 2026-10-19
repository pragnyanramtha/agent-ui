import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { typeIntoTerminal } from "@/lib/server/input";

/* A fake tmux whose pane shows Claude's prompt box with some text. Ctrl+U clears real text after `delay` ms
 * (a busy Claude redraws late); a suggestion (`ghost`) never clears. */
const bin = fs.mkdtempSync(path.join(os.tmpdir(), "agentu-prompt-"));
const state = path.join(bin, "state.json");
fs.writeFileSync(
  path.join(bin, "tmux"),
  `#!/usr/bin/env node
const fs = require("fs");
const st = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
const args = process.argv.slice(2);
const rule = "─".repeat(40);
if (args[0] === "capture-pane") {
  const cleared = st.clearAt && Date.now() >= st.clearAt;
  process.stdout.write(["", rule, "❯ " + (cleared ? "" : st.text), rule, "  ? for shortcuts", ""].join("\\n"));
} else if (args[0] === "send-keys" && args.includes("C-u") && !st.ghost) {
  st.clearAt = Date.now() + st.delay;
  fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(st));
}
`,
  { mode: 0o755 },
);
const PATH = process.env.PATH;
process.env.PATH = `${bin}:${PATH}`;
afterAll(() => {
  process.env.PATH = PATH;
  fs.rmSync(bin, { recursive: true, force: true });
});
const pane = (text: string, o: { delay?: number; ghost?: boolean } = {}) => fs.writeFileSync(state, JSON.stringify({ text, delay: o.delay ?? 0, ghost: o.ghost ?? false }));

describe("text already in the terminal prompt", () => {
  it("real text that clears slowly after Ctrl+U is reported as cleared, not taken for a suggestion", async () => {
    pane("half typed", { delay: 350 });
    expect(await typeIntoTerminal({ kind: "tmux", pane: "%1" }, "hello")).toEqual({ queued: false, cleared: "half typed" });
  });

  it("text that never clears is Claude's suggestion: typing replaces it and nothing is reported", async () => {
    pane("run the tests", { ghost: true });
    expect(await typeIntoTerminal({ kind: "tmux", pane: "%1" }, "hello")).toEqual({ queued: false, cleared: null });
  });

  it("text that clears at once is reported as cleared", async () => {
    pane("draft", { delay: 0 });
    expect(await typeIntoTerminal({ kind: "tmux", pane: "%1" }, "hello")).toEqual({ queued: false, cleared: "draft" });
  });
});
