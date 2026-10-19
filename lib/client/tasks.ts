import type { Entry } from "@/lib/types";

export type TaskStatus = "pending" | "in_progress" | "completed";
export type Task = { content: string; status: TaskStatus; activeForm?: string };

export type TaskProgress = {
  tasks: Task[];
  done: number;
  total: number;
  /** what the agent is on now (the first unfinished task); the last task once all are done */
  current: string;
  /** the plan update this came from */
  toolUseId: string;
};

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function status(v: unknown): TaskStatus {
  const s = str(v).toLowerCase().replace(/[\s-]+/g, "_");
  if (s === "completed" || s === "complete" || s === "done" || s === "cancelled" || s === "canceled") return "completed";
  if (s === "in_progress" || s === "inprogress" || s === "active" || s === "running") return "in_progress";
  return "pending";
}

function tasksOf(input: Record<string, unknown>): Task[] {
  const list = Array.isArray(input.todos) ? input.todos : [];
  return list.flatMap((t): Task[] => {
    if (!t || typeof t !== "object") return [];
    const o = t as Record<string, unknown>;
    const content = str(o.content) || str(o.step) || str(o.title) || str(o.description);
    if (!content) return [];
    const activeForm = str(o.activeForm);
    return [{ content, status: status(o.status), ...(activeForm ? { activeForm } : {}) }];
  });
}

/**
 * The latest plan in the thread. Every adapter files its plan tool as a `TodoWrite` call with `todos`
 * (Claude's TodoWrite, Codex's update_plan, Gemini's write_todos, OpenCode, Cursor, Devin); each call
 * carries the whole list, so the newest one is the plan.
 */
export function latestTasks(entries: Entry[]): TaskProgress | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind !== "tool" || e.name !== "TodoWrite") continue;
    const tasks = tasksOf(e.input ?? {});
    if (!tasks.length) return null;
    const done = tasks.filter((t) => t.status === "completed").length;
    const next = tasks.find((t) => t.status === "in_progress") ?? tasks.find((t) => t.status === "pending") ?? tasks[tasks.length - 1];
    return { tasks, done, total: tasks.length, current: (next.status === "in_progress" && next.activeForm) || next.content, toolUseId: e.toolUseId };
  }
  return null;
}

/** The pill shows while the agent works or tasks are left; a finished plan goes once the turn ends. */
export const showTasks = (p: TaskProgress | null, live: boolean): p is TaskProgress => Boolean(p && p.total > 0 && (live || p.done < p.total));

/** "Tasks 3/7 · Running the tests" */
export const tasksLabel = (p: TaskProgress) => `Tasks ${p.done}/${p.total} · ${p.current}`;
