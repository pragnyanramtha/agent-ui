import { describe, expect, it } from "vitest";
import { markRead, markUnread, nextFinished, parseFinished } from "@/lib/client/useFinished";
import { inboxCount, inboxGroups } from "@/components/claude/InboxScreen";
import { runFailed } from "@/lib/status";
import type { RunState, SessionSummary } from "@/lib/types";

const run = (status: RunState["status"], pending = 0): RunState => ({
  status,
  model: null,
  permissionMode: "default",
  slashCommands: [],
  pending: Array.from({ length: pending }, (_, i) => ({ kind: "permission" as const, requestId: `r${i}`, toolName: "Bash", title: "x", description: null, input: {}, canAlwaysAllow: false })),
  error: status === "error" ? "boom" : null,
  costUsd: null,
  sessionId: "",
});
const row = (id: string, web: RunState | null): SessionSummary => ({ id, agent: "claude", title: id, cwd: "/", project: "p", mtime: 0, size: 0, terminal: null, web });

describe("finished turns for the inbox", () => {
  it("lists a session whose turn ended while you were elsewhere, and drops it when you open it", () => {
    const busy = new Map<string, boolean>();
    let f = nextFinished({}, busy, [row("a", run("running")), row("b", run("running"))], "b", 1);
    expect(f).toEqual({});
    f = nextFinished(f, busy, [row("a", run("idle")), row("b", run("idle"))], "b", 2);
    expect(f).toEqual({ a: 2 });
    /* opening a clears it; the poll with a open leaves it cleared */
    f = markRead(f, "a");
    expect(f).toEqual({});
    f = nextFinished(f, busy, [row("a", run("idle")), row("b", run("idle"))], "a", 3);
    expect(f).toEqual({});
  });

  it("keeps a session marked unread while it's open", () => {
    const busy = new Map<string, boolean>();
    let f = markUnread({}, "a", 5);
    expect(f).toEqual({ a: 5 });
    f = nextFinished(f, busy, [row("a", run("idle"))], "a", 6);
    expect(f).toEqual({ a: 5 });
    /* an earlier finish keeps its time */
    expect(markUnread(f, "a", 9)).toBe(f);
    expect(markRead(f, "b")).toBe(f);
    expect(markRead(f, null)).toEqual({});
    expect(markRead({}, null)).toEqual({});
  });

  it("reads only well-formed stored values", () => {
    expect(parseFinished(JSON.stringify({ a: 3, b: "x", c: -1, d: null }))).toEqual({ a: 3 });
    expect(parseFinished("nope")).toEqual({});
    expect(parseFinished("[1]")).toEqual({});
    expect(parseFinished(null)).toEqual({});
  });

  it("doesn't list sessions it never saw working, or ones now waiting on an approval", () => {
    const busy = new Map<string, boolean>();
    let f = nextFinished({}, busy, [row("a", run("idle"))], null, 1);
    expect(f).toEqual({});
    f = nextFinished(f, busy, [row("c", run("running"))], null, 2);
    f = nextFinished(f, busy, [row("c", run("running", 1))], null, 3);
    expect(f).toEqual({});
  });

  it("forgets a finish once the session works again", () => {
    const busy = new Map<string, boolean>();
    let f = nextFinished({}, busy, [row("a", run("running"))], null, 1);
    f = nextFinished(f, busy, [row("a", run("idle"))], null, 2);
    expect(f).toEqual({ a: 2 });
    f = nextFinished(f, busy, [row("a", run("running"))], null, 3);
    expect(f).toEqual({});
  });

  it("keeps the same object when nothing changed (no needless saves)", () => {
    const busy = new Map<string, boolean>();
    const f = nextFinished({}, busy, [row("a", run("idle"))], null, 1);
    expect(nextFinished(f, busy, [row("a", run("idle"))], null, 2)).toBe(f);
  });

  it("counts approvals, failures and finished turns", () => {
    expect(inboxCount([row("a", run("running", 2)), row("b", run("error")), row("c", null)], { c: 1 })).toBe(3);
    expect(inboxCount(null, {})).toBe(0);
  });
});

describe("failed turns", () => {
  const idleWithError = (): RunState => ({ ...run("idle"), error: "Credit balance is too low" });

  it("a run back at the prompt with its last turn's error kept counts as failed", () => {
    expect(runFailed(run("error"))).toBe(true);
    expect(runFailed(idleWithError())).toBe(true);
    expect(runFailed(run("idle"))).toBe(false);
    expect(runFailed(run("running"))).toBe(false);
    expect(runFailed({ ...run("running"), error: "stale" })).toBe(false);
    expect(runFailed(null)).toBe(false);
  });

  it("lists it under Failed with its error, not under Finished, and counts it once", () => {
    const sessions = [row("a", idleWithError()), row("b", run("idle"))];
    const g = inboxGroups(sessions, { a: 1, b: 2 });
    expect(g.failed.map((s) => s.id)).toEqual(["a"]);
    expect(g.failed[0].web?.error).toBe("Credit balance is too low");
    expect(g.done.map((s) => s.id)).toEqual(["b"]);
    expect(inboxCount([row("a", idleWithError())], {})).toBe(1);
  });
});
