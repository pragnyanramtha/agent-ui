import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Entry, ToolResult } from "@/lib/types";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentu-handoff-"));
process.env.CLAUDE_HOME = home;
const { writeClaudeTranscript } = await import("@/lib/server/handoff");
const { HISTORY_MAX_CHARS, recentTurns, responsesItems } = await import("@/lib/server/handoff-shape");
const { projectDirFor } = await import("@/lib/server/config");
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

/** `n` turns, each a message and one tool run with a big output */
function source(n: number, outChars = 8000) {
  const entries: Entry[] = [];
  const results: Record<string, ToolResult> = {};
  for (let i = 0; i < n; i++) {
    entries.push({ kind: "user", id: `u${i}`, ts: new Date(i * 1000).toISOString(), text: `step ${i}`, images: 0 });
    entries.push({ kind: "tool", id: `t${i}`, ts: "", msgId: `m${i}`, toolUseId: `x${i}`, name: "Bash", input: { command: "cat big" } });
    results[`x${i}`] = { text: "y".repeat(outChars), truncated: true, isError: false };
  }
  return { agent: "codex" as const, key: "codex:abc", title: "t", cwd: "/w", entries, results };
}

describe("handoff history budget", () => {
  it("into Claude: keeps the newest turns within the budget and says how many were left out", async () => {
    const id = await writeClaudeTranscript(source(2000));
    const file = path.join(projectDirFor("/w"), `${id}.jsonl`);
    expect(fs.statSync(file).size).toBeLessThan(HISTORY_MAX_CHARS * 1.5);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const users = lines.filter((l) => l.type === "user").map((l) => l.message.content as string);
    expect(users[0]).toMatch(/\(\d+ earlier turns left out\)<\/imported-session>$/);
    expect(users.at(-1)).toBe("step 1999");
    const skipped = Number(/\((\d+) earlier/.exec(users[0])![1]);
    expect(skipped + users.length - 1).toBe(2000);
  });

  it("a short conversation goes over whole, with no note", async () => {
    const id = await writeClaudeTranscript(source(3, 100));
    const lines = fs.readFileSync(path.join(projectDirFor("/w"), `${id}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const users = lines.filter((l) => l.type === "user").map((l) => l.message.content as string);
    expect(users[0]).not.toMatch(/left out/);
    expect(users.slice(1)).toEqual(["step 0", "step 1", "step 2"]);
  });

  it("into Codex: the same budget, with the note as the first item", () => {
    const items = responsesItems(source(2000)) as { role: string; content: { text: string }[] }[];
    expect(JSON.stringify(items).length).toBeLessThan(HISTORY_MAX_CHARS * 1.2);
    expect(items[0].content[0].text).toMatch(/^\(\d+ earlier turns left out\)$/);
    expect(items.at(-2)!.content[0].text).toBe("step 1999");
    expect(responsesItems(source(2, 10)).length).toBe(4);
  });

  it("one huge turn keeps its latest steps", () => {
    const src = source(1);
    for (let i = 0; i < 400; i++) {
      src.entries.push({ kind: "tool", id: `big${i}`, ts: "", msgId: "m", toolUseId: `b${i}`, name: "Bash", input: { command: `run ${i}` } });
      src.results[`b${i}`] = { text: "z".repeat(4000), truncated: false, isError: false };
    }
    const { turns, skipped } = recentTurns(src, 4000, 100_000);
    expect(skipped).toBe(0);
    expect(turns).toHaveLength(1);
    const size = turns[0].user.length + turns[0].assistant.reduce((n, a) => n + a.length, 0);
    expect(size).toBeLessThanOrEqual(100_100);
    expect(turns[0].assistant[0]).toMatch(/^\(\d+ earlier steps left out\)$/);
    expect(turns[0].assistant.at(-1)).toContain("[Bash: run 399]");
  });
});
