import { describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@/lib/types";

/* Claude web runs driven by a fake Agent SDK: the test pushes the SDK messages a real `claude` would send. */

type Msg = Record<string, unknown>;
const fakes: Fake[] = [];
class Fake {
  queue: Msg[] = [];
  wake: (() => void) | null = null;
  done = false;
  fail: Error | null = null;
  opts: Record<string, any>;
  closed = 0;
  constructor(a: { prompt: AsyncIterable<unknown>; options: Record<string, any> }) {
    this.opts = a.options;
    fakes.push(this);
  }
  push(m: Msg) {
    this.queue.push(m);
    this.wake?.();
  }
  end(err?: Error) {
    this.done = true;
    this.fail = err ?? null;
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      while (this.queue.length) yield this.queue.shift()!;
      if (this.done) {
        if (this.fail) throw this.fail;
        return;
      }
      await new Promise<void>((r) => (this.wake = r));
    }
  }
  async interrupt() {}
  close() {
    this.closed++;
    this.end();
  }
  async setModel() {}
  async setPermissionMode() {}
}
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: (a: any) => new Fake(a) }));

const listed: Omit<SessionSummary, "web">[] = [];
vi.mock("@/lib/server/sessions", () => ({ listSessions: async () => listed }));
vi.mock("@/lib/server/agents/bridge", () => ({ agentSummaries: async () => [] }));

const { startRun, getRun, lastFailure } = await import("@/lib/server/runner");
const { phaseOf, step } = await import("@/lib/server/notify");
const { sessionRows } = await import("@/lib/server/rows");
const { LIMIT_ERROR } = await import("@/lib/server/profiles");
const tick = () => new Promise((r) => setTimeout(r, 10));
const init = (id: string, extra: Msg = {}) => ({ type: "system", subtype: "init", session_id: id, model: "m", permissionMode: "default", slash_commands: [], ...extra });
let n = 0;
const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

function started(id: string) {
  const run = startRun({ resume: id, cwd: "/", permissionMode: "default" });
  run.send("hi");
  const f = fakes.at(-1)!;
  f.push(init(id));
  return { run, f };
}

const row = (id: string): Omit<SessionSummary, "web"> => ({ id, agent: "claude", title: "Fix it", cwd: "/w", project: "w", mtime: 0, size: 0, terminal: null });

describe("what a failed turn says", () => {
  it("error_* results carry the CLI's errors, so fallback sees a usage limit", async () => {
    const id = newId();
    const { run, f } = started(id);
    f.push({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["API Error: 429", "rate_limit_error: usage limit reached"], terminal_reason: "api_error", total_cost_usd: 0 });
    await tick();
    expect(run.state.error).toBe("API Error: 429; rate_limit_error: usage limit reached");
    expect(LIMIT_ERROR.test(run.state.error!)).toBe(true);
    f.push({ type: "result", subtype: "error_max_turns", is_error: true, errors: [], total_cost_usd: 0 });
    await tick();
    expect(run.state.error).toBe("Turn ended: error max turns");
    run.close();
  });

  it("limit terminal reasons read as a usage limit even without text", async () => {
    const id = newId();
    const { run, f } = started(id);
    for (const reason of ["blocking_limit", "rapid_refill_breaker"]) {
      f.push({ type: "result", subtype: "success", is_error: true, result: "", terminal_reason: reason, total_cost_usd: 0 });
      await tick();
      expect(run.state.error).toBe("Usage limit reached.");
      expect(LIMIT_ERROR.test(run.state.error!)).toBe(true);
    }
    f.push({ type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached|1760000000", terminal_reason: "blocking_limit", total_cost_usd: 0 });
    await tick();
    expect(run.state.error).toBe("Claude AI usage limit reached|1760000000");
    f.push({ type: "result", subtype: "success", is_error: true, result: "", terminal_reason: "aborted_streaming", total_cost_usd: 0 });
    await tick();
    expect(run.state.error).toBeNull();
    run.close();
  });
});

describe("failed Claude turns", () => {
  it("a turn that ends with an error reads as failed while the run stays open", async () => {
    const id = newId();
    const { run, f } = started(id);
    f.push({ type: "result", subtype: "success", is_error: true, result: "API Error: 500", total_cost_usd: 0 });
    await tick();
    expect(run.state).toMatchObject({ status: "idle", error: "API Error: 500" });
    expect(phaseOf({ terminal: null, web: getRun(id)!.state })).toBe("failed");
    run.close();
  });

  it("a run that crashed keeps its failure for the list, the inbox and push until the next send", async () => {
    const id = newId();
    const { run, f } = started(id);
    await tick();
    f.end(new Error("Claude Code process exited with code 1"));
    await tick();
    expect(getRun(id)).toBeNull();
    expect(lastFailure(id)).toMatchObject({ status: "error", error: "Claude Code process exited with code 1", pending: [] });
    listed.splice(0, listed.length, row(id));
    const rows = await sessionRows();
    expect(rows[0].web).toMatchObject({ status: "error", error: "Claude Code process exited with code 1" });
    expect(phaseOf(rows[0])).toBe("failed");
    /* the next message starts a new run and the old failure is gone */
    const next = startRun({ resume: id, cwd: "/", permissionMode: "default" });
    expect(lastFailure(id)).toBeNull();
    next.close();
    expect(run.live).toBe(false);
  });

  it("an idle run reaped after a failed turn still reports the failure; a clean close doesn't", async () => {
    const a = newId();
    const one = started(a);
    one.f.push({ type: "result", subtype: "success", is_error: true, result: "Overloaded", total_cost_usd: 0 });
    await tick();
    one.run.close();
    expect(lastFailure(a)).toMatchObject({ status: "error", error: "Overloaded" });
    const b = newId();
    const two = started(b);
    two.f.push({ type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 0 });
    await tick();
    two.run.close();
    expect(lastFailure(b)).toBeNull();
  });

  it("a session open in a terminal doesn't show an old web failure", async () => {
    const id = newId();
    const { run, f } = started(id);
    f.push({ type: "result", subtype: "success", is_error: true, result: "boom", total_cost_usd: 0 });
    await tick();
    run.close();
    listed.splice(0, listed.length, { ...row(id), terminal: { pid: 1, status: "idle", multiplexer: "tmux", name: null } });
    expect((await sessionRows())[0].web).toBeNull();
  });

  it("push says failed, not finished", async () => {
    const id = newId();
    const { run, f } = started(id);
    await tick();
    const seen = new Map();
    listed.splice(0, listed.length, row(id));
    expect(step(seen, await sessionRows(), 0)).toEqual([]);
    f.push({ type: "result", subtype: "success", is_error: true, result: "API Error: 500", total_cost_usd: 0 });
    await tick();
    const out = [...step(seen, await sessionRows(), 1000), ...step(seen, await sessionRows(), 60_000)];
    expect(out.map((m) => [m.kind, m.title])).toEqual([["failed", "Claude failed"]]);
    run.close();
  });
});
