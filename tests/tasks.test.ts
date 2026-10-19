import { describe, expect, it } from "vitest";
import type { Entry } from "@/lib/types";
import { latestTasks, showTasks, tasksLabel } from "@/lib/client/tasks";

let n = 0;
const todo = (todos: unknown[], name = "TodoWrite"): Entry => ({ kind: "tool", id: `t${++n}`, ts: "", msgId: "m", toolUseId: `tu${n}`, name, input: { todos } });
const text = (t: string): Entry => ({ kind: "text", id: `x${++n}`, ts: "", msgId: "m", text: t });

describe("latestTasks", () => {
  it("is null without a plan", () => {
    expect(latestTasks([])).toBeNull();
    expect(latestTasks([text("hi"), todo([{ content: "x" }], "Bash")])).toBeNull();
  });

  it("reads the newest plan, counts done and names the step in progress by its active form", () => {
    const p = latestTasks([
      todo([{ content: "Old", status: "pending" }]),
      text("working"),
      todo([
        { content: "Read the code", status: "completed" },
        { content: "Run the tests", activeForm: "Running the tests", status: "in_progress" },
        { content: "Fix the bug", status: "pending" },
      ]),
      text("more"),
    ])!;
    expect(p.total).toBe(3);
    expect(p.done).toBe(1);
    expect(p.current).toBe("Running the tests");
    expect(tasksLabel(p)).toBe("Tasks 1/3 · Running the tests");
  });

  it("falls back to the first pending task, then the last one when all are done", () => {
    expect(latestTasks([todo([{ content: "A", status: "completed" }, { content: "B", status: "pending" }])])!.current).toBe("B");
    const all = latestTasks([todo([{ content: "A", status: "completed" }, { content: "B", status: "completed" }])])!;
    expect(all.current).toBe("B");
    expect(all.done).toBe(2);
  });

  it("takes the shapes other adapters file (Codex steps, cancelled, odd status spellings) and skips junk", () => {
    const p = latestTasks([
      todo([
        { step: "Plan", status: "done" },
        { content: "Skip me", status: "cancelled" },
        { title: "Build", status: "inProgress" },
        null,
        "nope",
        { content: "  " },
        { description: "Ship" },
      ]),
    ])!;
    expect(p.tasks.map((t) => [t.content, t.status])).toEqual([
      ["Plan", "completed"],
      ["Skip me", "completed"],
      ["Build", "in_progress"],
      ["Ship", "pending"],
    ]);
    expect(p.current).toBe("Build");
  });

  it("an emptied plan clears it", () => {
    expect(latestTasks([todo([{ content: "A" }]), todo([])])).toBeNull();
  });
});

describe("showTasks", () => {
  const plan = (done: number, total: number) => latestTasks([todo(Array.from({ length: total }, (_, i) => ({ content: `T${i}`, status: i < done ? "completed" : "pending" })))]);
  it("shows while the agent works, even with every task done", () => {
    expect(showTasks(plan(3, 3), true)).toBe(true);
    expect(showTasks(plan(0, 3), true)).toBe(true);
  });
  it("shows unfinished tasks after the turn ended", () => {
    expect(showTasks(plan(2, 3), false)).toBe(true);
  });
  it("hides a finished plan once the turn ended, and when there is no plan", () => {
    expect(showTasks(plan(3, 3), false)).toBe(false);
    expect(showTasks(null, true)).toBe(false);
  });
});
