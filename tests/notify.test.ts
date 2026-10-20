import { describe, expect, it } from "vitest";
import { GONE_MS, forgetSeen } from "@/lib/notify-events";
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

  it("notifies about a session that shows up after a first poll with none, and seeds again after forgetting", () => {
    const seen = new Map<string, Seen>();
    expect(step(seen, [], 0)).toEqual([]);
    expect(step(seen, [row(run("idle", [ask]))], 1000)).toMatchObject([{ kind: "needs" }]);
    forgetSeen(seen);
    expect(step(seen, [row(run("idle", [ask]), { id: "s2" })], 2000)).toEqual([]);
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

  it("forgets sessions that left the list a while ago", () => {
    const seen = new Map<string, Seen>();
    step(seen, [row(run("running"))], 0);
    step(seen, [], 1000);
    expect(seen.size).toBe(1);
    step(seen, [], 1000 + GONE_MS);
    expect(seen.size).toBe(0);
  });

  it("a failed or waiting session that misses a poll doesn't notify again", () => {
    const seen = new Map<string, Seen>();
    step(seen, [row(run("running"))], 0);
    const failed = row(run("error", [], "Not logged in"));
    expect(step(seen, [failed], 3000).map((m) => m.kind)).toEqual(["failed"]);
    /* the agent's list timed out once */
    expect(step(seen, [], 6000)).toEqual([]);
    expect(step(seen, [failed], 9000)).toEqual([]);
    const needs = row(run("running", [ask]), { id: "s2", mtime: 9000 });
    expect(step(seen, [failed, needs], 12_000).map((m) => m.kind)).toEqual(["needs"]);
    step(seen, [failed], 15_000);
    expect(step(seen, [failed, needs], 18_000)).toEqual([]);
  });

  it("a session that appears after the first poll notifies like any other", () => {
    const seen = new Map<string, Seen>();
    step(seen, [row(run("idle"))], 0);
    const two = row(run("running", [ask]), { id: "s2", mtime: 100_000 });
    expect(step(seen, [row(run("idle")), two], 100_000)).toEqual([expect.objectContaining({ kind: "needs", url: "/?s=s2" })]);
    const three = row(run("idle", [], "Not logged in"), { id: "s3", mtime: 100_000 });
    expect(step(seen, [row(run("idle")), three], 101_000)).toEqual([expect.objectContaining({ kind: "failed", url: "/?s=s3" })]);
  });

  it("a new session whose quick turn ended between polls says done; one that only reappeared doesn't", () => {
    const seen = new Map<string, Seen>();
    step(seen, [row(run("idle"))], 0);
    const fresh = row(null, { id: "s2", mtime: 200_000 });
    const old = row(null, { id: "s3", mtime: 1_000 });
    expect(step(seen, [row(run("idle")), fresh, old], 200_500)).toEqual([]);
    const out = step(seen, [row(run("idle")), fresh, old], 200_500 + SETTLE_MS);
    expect(out).toEqual([expect.objectContaining({ kind: "done", url: "/?s=s2" })]);
    expect(seen.get("s2")?.doneSent).toBe(true);
  });

  it("a new busy session starts with done not yet sent", () => {
    const seen = new Map<string, Seen>();
    step(seen, [row(run("idle"))], 0);
    step(seen, [row(run("idle")), row(run("running"), { id: "s2" })], 1000);
    expect(seen.get("s2")).toMatchObject({ phase: "busy", doneSent: false });
    step(seen, [row(run("idle")), row(run("idle"), { id: "s2" })], 2000);
    expect(step(seen, [row(run("idle")), row(run("idle"), { id: "s2" })], 2000 + SETTLE_MS)).toEqual([expect.objectContaining({ kind: "done", url: "/?s=s2" })]);
  });

  it("clips long bodies", () => {
    const seen = new Map<string, Seen>();
    step(seen, [row(run("running"))], 0);
    const [m] = step(seen, [row(run("error", [], "x".repeat(500)))], 1000);
    expect(m.body.length).toBeLessThanOrEqual(140);
  });
});
