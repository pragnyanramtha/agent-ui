import { describe, expect, it } from "vitest";
import { SETTLE_MS, phaseOf, step, type Seen } from "@/lib/server/notify";
import type { PendingAsk, RunState, SessionSummary } from "@/lib/types";

const run = (status: RunState["status"], pending: PendingAsk[] = [], error: string | null = null): RunState => ({
  status,
  model: null,
  permissionMode: "default",
  slashCommands: [],
  pending,
  error,
  costUsd: null,
  sessionId: "s1",
});

const row = (web: RunState | null, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id: "s1",
  agent: "cursor",
  title: "Fix the login",
  cwd: "/w",
  project: "w",
  mtime: 0,
  size: 0,
  terminal: null,
  web,
  ...extra,
});

const ask: PendingAsk = { kind: "permission", requestId: "r", toolName: "Bash", title: "Run rm -rf build", description: null, input: {}, canAlwaysAllow: false };

describe("phaseOf", () => {
  it("reads web runs and terminals", () => {
    expect(phaseOf(row(run("running")))).toBe("busy");
    expect(phaseOf(row(run("idle", [ask])))).toBe("needs");
    expect(phaseOf(row(run("error", [], "boom")))).toBe("failed");
    expect(phaseOf(row(run("idle", [], "boom")))).toBe("failed");
    expect(phaseOf(row(run("idle")))).toBe("idle");
    expect(phaseOf(row(null, { terminal: { pid: 1, status: "busy", multiplexer: null, name: null } }))).toBe("busy");
    expect(phaseOf(row(null, { terminal: { pid: 1, status: "idle", multiplexer: null, name: null } }))).toBe("idle");
  });
});

describe("step", () => {
  it("only seeds a session it sees for the first time", () => {
    const seen = new Map<string, Seen>();
    expect(step(seen, [row(run("idle", [ask]))], 0)).toEqual([]);
    expect(step(seen, [row(run("idle"))], 10_000)).toEqual([]);
  });

  it("says done once the session stays idle, not on a short gap between turns", () => {
    const seen = new Map<string, Seen>();
    step(seen, [row(run("running"))], 0);
    expect(step(seen, [row(run("idle"))], 1000)).toEqual([]);
    /* a queued message starts the next turn before the settle time */
    expect(step(seen, [row(run("running"))], 2000)).toEqual([]);
    expect(step(seen, [row(run("idle"))], 3000)).toEqual([]);
    const out = step(seen, [row(run("idle"))], 3000 + SETTLE_MS);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "done", title: "Cursor finished", body: "Fix the login", url: "/?s=s1" });
    expect(step(seen, [row(run("idle"))], 3000 + 3 * SETTLE_MS)).toEqual([]);
  });

  it("says needs you with the request, once", () => {
    const seen = new Map<string, Seen>();
    step(seen, [row(run("running"))], 0);
    const out = step(seen, [row(run("running", [ask]))], 1000);
    expect(out).toEqual([expect.objectContaining({ kind: "needs", title: "Cursor needs you", body: "Fix the login: Run rm -rf build" })]);
    expect(step(seen, [row(run("running", [ask]))], 2000)).toEqual([]);
  });

  it("an answered request doesn't count as the turn finishing", () => {
    const seen = new Map<string, Seen>();
    step(seen, [row(run("running"))], 0);
    step(seen, [row(run("running", [ask]))], 1000);
    expect(step(seen, [row(run("idle"))], 2000)).toEqual([]);
    expect(step(seen, [row(run("idle"))], 2000 + SETTLE_MS)).toEqual([]);
  });

  it("says failed with the error", () => {
    const seen = new Map<string, Seen>();
    step(seen, [row(run("running"))], 0);
    const out = step(seen, [row(run("error", [], "Not logged in"))], 1000);
    expect(out).toEqual([expect.objectContaining({ kind: "failed", title: "Cursor failed", body: "Fix the login: Not logged in" })]);
  });

  it("forgets sessions that left the list", () => {
    const seen = new Map<string, Seen>();
    step(seen, [row(run("running"))], 0);
    step(seen, [], 1000);
    expect(seen.size).toBe(0);
  });

  it("clips long bodies", () => {
    const seen = new Map<string, Seen>();
    step(seen, [row(run("running"))], 0);
    const [m] = step(seen, [row(run("error", [], "x".repeat(500)))], 1000);
    expect(m.body.length).toBeLessThanOrEqual(140);
  });
});
