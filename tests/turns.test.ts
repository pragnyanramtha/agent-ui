import { describe, expect, it } from "vitest";
import type { Entry } from "@/lib/types";
import { foldLabel, runSummary, splitTurns, toBlocks, undoCheckpoint, workedFor, type Block, type RunItem } from "@/lib/client/turns";

let n = 0;
const at = (s: number) => new Date(Date.UTC(2026, 9, 19, 10, 0, s)).toISOString();
const user = (text: string, s = 0): Entry => ({ kind: "user", id: `u${++n}`, ts: at(s), text, images: 0 });
const text = (t: string, s = 0): Entry => ({ kind: "text", id: `t${++n}`, ts: at(s), msgId: "m", text: t });
const think = (t: string, s = 0): Extract<Entry, { kind: "thinking" }> => ({ kind: "thinking", id: `k${++n}`, ts: at(s), msgId: "m", text: t });
const tool = (name: string, input: Record<string, unknown> = {}, s = 0): Extract<Entry, { kind: "tool" }> => {
  const id = `x${++n}`;
  return { kind: "tool", id, ts: at(s), msgId: "m", toolUseId: `use-${id}`, name, input };
};
const notice = (t: string, s = 0): Entry => ({ kind: "notice", id: `n${++n}`, ts: at(s), tone: "warn", text: t });
const usage = (s: number): Entry => ({ kind: "usage", id: `g${++n}`, ts: at(s), model: "m", input: 1, cacheRead: 0, cacheWrite: 0, output: 1 });

const shape = (blocks: Block[]): unknown[] =>
  blocks.map((b) => {
    if (b.type === "fold") return { fold: shape(b.blocks), tools: b.tools };
    if (b.type === "run") return `run:${b.items.length}`;
    if (b.type === "text") return b.final ? `final:${b.entry.text}` : `text:${b.entry.text}`;
    if (b.type === "notice") return `notice:${b.entry.text}`;
    if (b.type === "changes") return `changes:${b.tools.length}`;
    return `user:${b.entry.text}`;
  });

describe("toBlocks", () => {
  const turn = [
    user("fix it", 0),
    think("hmm", 1),
    text("I'll read the server first.", 2),
    tool("Read", { file_path: "/r/src/a.ts" }, 3),
    tool("Grep", { pattern: "x" }, 4),
    text("Found it.", 5),
    tool("Edit", { file_path: "/r/src/a.ts", old_string: "a", new_string: "b" }, 6),
    text("Done.", 7),
    text("Details follow.", 8),
    usage(134),
  ];

  it("folds a finished turn into its work, then the answer and the changed files", () => {
    const blocks = toBlocks(turn);
    expect(shape(blocks)).toEqual([
      "user:fix it",
      { fold: ["run:1", "text:I'll read the server first.", "run:2", "text:Found it.", "run:1"], tools: 3 },
      "text:Done.",
      "final:Details follow.",
      "changes:1",
    ]);
    const fold = blocks[1] as Extract<Block, { type: "fold" }>;
    expect(fold.ms).toBe(134_000);
  });

  it("keeps the live turn as separate blocks", () => {
    expect(shape(toBlocks(turn, true))).toEqual([
      "user:fix it",
      "run:1",
      "text:I'll read the server first.",
      "run:2",
      "text:Found it.",
      "run:1",
      "text:Done.",
      "text:Details follow.",
    ]);
  });

  it("leaves thinking out when it's hidden, in finished and live turns", () => {
    expect(shape(toBlocks(turn, false, { thinking: false }))[1]).toEqual({ fold: ["text:I'll read the server first.", "run:2", "text:Found it.", "run:1"], tools: 3 });
    expect(shape(toBlocks(turn, true, { thinking: false })).slice(0, 3)).toEqual(["user:fix it", "text:I'll read the server first.", "run:2"]);
    const runs = toBlocks([user("go"), think("a"), tool("Read", { file_path: "/a" }), think("b"), text("ok")], true, { thinking: false }).filter((b) => b.type === "run");
    expect(runs.map((b) => (b as Extract<Block, { type: "run" }>).items.map((i) => i.kind))).toEqual([["tool"]]);
  });

  it("only the last turn is live", () => {
    const blocks = toBlocks([...turn, user("again", 200), tool("Bash", { command: "ls" }, 201)], true);
    expect(shape(blocks).slice(0, 2)).toEqual(["user:fix it", expect.objectContaining({ tools: 3 })]);
    expect(shape(blocks).slice(-2)).toEqual(["user:again", "run:1"]);
  });

  it("never folds notices, plans or questions", () => {
    const plan = tool("ExitPlanMode", { plan: "# Plan" }, 3);
    const blocks = toBlocks([user("plan it"), tool("Read", { file_path: "/a" }), notice("Rate limited"), tool("Grep", { pattern: "p" }), plan, tool("Bash", { command: "x" }), text("Here is the plan.")]);
    expect(shape(blocks)).toEqual(["user:plan it", { fold: ["run:1", "run:1", "run:1"], tools: 3 }, "notice:Rate limited", "run:1", "final:Here is the plan."]);
    expect((blocks[3] as Extract<Block, { type: "run" }>).items[0]).toBe(plan);
  });

  it("a turn of prose alone needs no fold", () => {
    expect(shape(toBlocks([user("hi"), text("Hello."), notice("note"), text("More.")]))).toEqual(["user:hi", "text:Hello.", "notice:note", "final:More."]);
  });

  it("a turn without prose folds everything", () => {
    expect(shape(toBlocks([user("go"), tool("Bash", { command: "ls" }), think("ok")]))).toEqual(["user:go", { fold: ["run:2"], tools: 1 }]);
  });

  it("history loaded from the middle starts with a turn that has no prompt", () => {
    const blocks = toBlocks([tool("Read", { file_path: "/a" }, 5), text("Answer.", 9), user("next", 20), text("Sure.", 21)]);
    expect(shape(blocks)).toEqual([{ fold: ["run:1"], tools: 1 }, "final:Answer.", "user:next", "final:Sure."]);
    expect((blocks[0] as Extract<Block, { type: "fold" }>).ms).toBe(4000);
  });

  it("drops empty reasoning and splits turns on prompts", () => {
    expect(shape(toBlocks([user("a"), think("  "), text("b")]))).toEqual(["user:a", "final:b"]);
    expect(splitTurns([user("a"), text("b"), user("c")]).map((t) => t.entries.length)).toEqual([1, 0]);
  });

  it("keeps keys unique across folds", () => {
    const keys: string[] = [];
    const walk = (bs: Block[]) => bs.forEach((b) => (keys.push(b.key), b.type === "fold" && walk(b.blocks)));
    walk(toBlocks([...turn, user("x"), tool("Bash", { command: "y" }), text("z")]));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("labels", () => {
  it("summarizes a whole run", () => {
    const items: RunItem[] = [
      tool("Read", { file_path: "/a" }),
      tool("Read", { file_path: "/b" }),
      tool("Read", { file_path: "/a" }),
      tool("Edit", { file_path: "/a" }),
      tool("Edit", { file_path: "/a" }),
      tool("Write", { file_path: "/c", content: "x" }),
      tool("Bash", { command: "ls" }),
      tool("Grep", { pattern: "x" }),
      think("t"),
    ];
    expect(runSummary(items)).toBe("Read 2 files, edited 2, searched once, ran 1 command");
    expect(runSummary([tool("Edit", { file_path: "/a" }), tool("Bash", { command: "a" }), tool("Bash", { command: "b" })])).toBe("Edited 1 file, ran 2 commands");
    expect(runSummary([think("hm")])).toBe("Thought");
    expect(runSummary([tool("TodoWrite", { todos: [] }), tool("mcp__gh__list", {})])).toBe("Updated the plan, used 1 tool");
  });

  it("formats the fold row", () => {
    expect(workedFor(45_400)).toBe("45s");
    expect(workedFor(134_000)).toBe("2m 14s");
    expect(workedFor(3_780_000)).toBe("1h 3m");
    expect(foldLabel(134_000, 9)).toEqual({ title: "Worked for 2m 14s", detail: "9 tool calls" });
    expect(foldLabel(null, 1)).toEqual({ title: "Worked", detail: "1 tool call" });
    expect(foldLabel(400, 0)).toEqual({ title: "Worked", detail: "" });
  });
});

describe("undoCheckpoint", () => {
  const T = (s: number) => Date.parse(at(s));
  const turns = [
    { text: "explain the auth flow", ts: at(0), edits: false },
    { text: "now  fix\nit", ts: at(100), edits: true },
    { text: "thanks", ts: at(200), edits: false },
  ];

  it("finds the checkpoint saved for the turn", () => {
    expect(undoCheckpoint([{ id: "a", at: T(-1), label: "explain the auth flow" }, { id: "b", at: T(99), label: "now fix it" }], turns, 1)).toBe("b");
  });

  it("reuses an earlier prompt's checkpoint when nothing changed since", () => {
    expect(undoCheckpoint([{ id: "a", at: T(-1), label: "explain the auth flow" }], turns, 1)).toBe("a");
  });

  it("refuses when a turn in between edited files", () => {
    const more = [...turns, { text: "and the tests", ts: at(300), edits: true }];
    expect(undoCheckpoint([{ id: "b", at: T(99), label: "now fix it" }], more, 3)).toBeNull();
    expect(undoCheckpoint([{ id: "b", at: T(99), label: "now fix it" }, { id: "d", at: T(299), label: "and the tests" }], more, 3)).toBe("d");
  });

  it("ignores the next prompt's checkpoint even inside the slack", () => {
    const quick = [
      { text: "a", ts: at(0), edits: true },
      { text: "b", ts: at(5), edits: false },
    ];
    expect(undoCheckpoint([{ id: "a", at: T(-1), label: "a" }, { id: "b", at: T(4), label: "b" }], quick, 0)).toBe("a");
  });

  it("gives up when something newer was saved or nothing matches", () => {
    expect(undoCheckpoint([{ id: "a", at: T(-1), label: "explain the auth flow" }, { id: "r", at: T(50), label: "Before rewinding to 10:00" }], turns, 1)).toBeNull();
    expect(undoCheckpoint([], turns, 1)).toBeNull();
    expect(undoCheckpoint([{ id: "x", at: T(99), label: "something typed in a terminal" }], turns, 1)).toBeNull();
    expect(undoCheckpoint([{ id: "b", at: T(99), label: "now fix it" }], [{ text: "now fix it", ts: "bad", edits: true }], 0)).toBeNull();
  });
});
