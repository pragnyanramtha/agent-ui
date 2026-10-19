import { describe, expect, it } from "vitest";
import { initial, lostQueued, parseEvent, reducer, RESET, serverId, type Pending, type SessionView } from "@/lib/client/useSession";
import type { Entry, RunState, ServerEvent } from "@/lib/types";

const now = Date.parse("2026-10-15T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const user = (id: string, text: string, at = now): Entry => ({ kind: "user", id, ts: iso(at), text, images: 0 });
const pending = (localId: string, text: string, patch: Partial<Pending> = {}): Pending => ({ localId, text, at: now, state: "sent", via: "web", ...patch });
const history = (entries: Entry[], run: RunState | null = null): Extract<ServerEvent, { type: "history" }> => ({
  type: "history",
  entries,
  cursor: 5,
  terminal: null,
  run,
  title: "t",
  cwd: "/tmp",
  permissionMode: null,
});
const run = (status: RunState["status"], error: string | null = null): RunState => ({
  status,
  model: null,
  permissionMode: "default",
  slashCommands: [],
  pending: [],
  error,
  costUsd: null,
  sessionId: "s",
});
const ev = (state: SessionView, event: ServerEvent, initialLoad = false) => reducer(state, { type: "event", event, initial: initialLoad });
const withPending = (...p: Pending[]) => p.reduce((s, x) => reducer(s, { type: "pending", pending: x }), initial());

describe("history loading", () => {
  it("the first (GET) load replaces everything and sets the paging cursor", () => {
    let s = ev(initial(), history([user("a", "old")]), true);
    s = ev(s, history([user("b", "new")]), true);
    expect(s.entries.map((e) => e.id)).toEqual(["b"]);
    expect(s.cursor).toBe(5);
  });

  it("sets the cursor even when the first load only succeeded after retries", () => {
    let s = reducer(initial(), { type: "status", status: "reconnecting" });
    s = ev(s, history([user("a", "x")]), true);
    expect(s.cursor).toBe(5);
    expect(s.status).toBe("open");
  });

  it("stream reconnects only add, never reset or move the cursor", () => {
    let s = ev(initial(), history([user("a", "x")]), true);
    s = ev(s, { ...history([user("b", "y")]), cursor: 99 });
    expect(s.entries.map((e) => e.id)).toEqual(["a", "b"]);
    expect(s.cursor).toBe(5);
  });

  it("de-duplicates entries resent after a reconnect", () => {
    let s = ev(initial(), history([user("a", "x")]), true);
    s = ev(s, { type: "entries", entries: [user("a", "x"), user("b", "y")] });
    expect(s.entries.map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("pending bubbles", () => {
  it("drop when their message lands in the transcript", () => {
    const s = ev(withPending(pending("p1", "hello  world")), { type: "entries", entries: [user("u1", "hello world", now + 1000)] });
    expect(s.pending).toEqual([]);
  });

  it("only one bubble drops per landed message, oldest first", () => {
    const s = ev(withPending(pending("p1", "yes"), pending("p2", "yes")), { type: "entries", entries: [user("u1", "yes", now + 1000)] });
    expect(s.pending.map((p) => p.localId)).toEqual(["p2"]);
  });

  it("an older identical message in a full history load doesn't clear a new bubble", () => {
    const s = ev(withPending(pending("p1", "continue")), history([user("u0", "continue", now - 10 * 60_000)]), true);
    expect(s.pending).toHaveLength(1);
  });

  it("a send retried through an outage clears when its entry arrives, however late the reply came", () => {
    let s = ev(initial(), history([]), true);
    /* the server took it at `now`; the reply was lost and the retry's replay came back 75s later */
    s = reducer(s, { type: "pending", pending: pending("p1", "deploy it", { state: "sending" }) });
    s = reducer(s, { type: "updatePending", localId: "p1", patch: { state: "sent", via: "web", sentAt: now + 75_000 } });
    expect(s.pending[0].at).toBe(now);
    /* the stream catches up with the user record written at the first attempt */
    s = ev(s, { type: "entries", entries: [user("u1", "deploy it", now + 500)] });
    expect(s.entries.map((e) => e.id)).toEqual(["u1"]);
    expect(s.pending).toEqual([]);
  });

  it("an entry on the live stream clears the bubble even if the clocks disagree by more than a minute", () => {
    const s = ev(withPending(pending("p1", "go")), { type: "entries", entries: [user("u1", "go", now - 5 * 60_000)] });
    expect(s.pending).toEqual([]);
  });

  it("restoring a saved bubble ignores an identical message from before it was made", () => {
    const s0 = ev(initial(), history([user("u0", "continue", now - 10 * 60_000)]), true);
    const s = reducer(s0, { type: "restorePending", pending: [pending("p1", "continue")] });
    expect(s.pending.map((p) => p.localId)).toEqual(["p1"]);
  });

  it("loading older pages never clears a bubble", () => {
    const s = reducer(withPending(pending("p1", "continue")), { type: "older", entries: [user("u0", "continue", now + 5000)], cursor: null });
    expect(s.pending).toHaveLength(1);
  });

  it("shell-escape messages match with or without the space", () => {
    const s = ev(withPending(pending("p1", "!ls -la")), { type: "entries", entries: [user("u1", "! ls -la", now + 1000)] });
    expect(s.pending).toEqual([]);
  });

  it("a failed run turns delivered web bubbles into Retry, as a fresh send", () => {
    const base = withPending(pending("p1", "a"), pending("p2", "b", { via: "terminal" }), pending("p3", "c", { state: "sending" }));
    const s = ev(base, { type: "run", run: run("error", "No conversation found") });
    const p1 = s.pending.find((p) => p.localId === "p1")!;
    expect(p1.state).toBe("failed");
    expect(p1.resend).toBe(true);
    expect(p1.error).toContain("No conversation found");
    expect(s.pending.find((p) => p.localId === "p2")!.state).toBe("sent");
    expect(s.pending.find((p) => p.localId === "p3")!.state).toBe("sending");
  });

  it("a run that just goes idle leaves bubbles alone", () => {
    const s = ev(withPending(pending("p1", "a")), { type: "run", run: run("idle") });
    expect(s.pending[0].state).toBe("sent");
  });

  it("restoring after a reload skips ones that landed meanwhile", () => {
    const s0 = ev(initial(), history([user("u1", "landed", now + 1000)]), true);
    const s = reducer(s0, { type: "restorePending", pending: [pending("p1", "landed"), pending("p2", "still waiting")] });
    expect(s.pending.map((p) => p.localId)).toEqual(["p2"]);
  });
});

describe("queue events", () => {
  it("track which bubbles the server is holding", () => {
    let s = ev(initial(), { type: "queue", items: [{ id: "p1", text: "a" }, { id: "p2", text: "b" }] });
    expect(s.queue).toEqual(["p1", "p2"]);
    s = ev(s, { type: "queue", items: [] });
    expect(s.queue).toEqual([]);
  });
});

describe("unsent events", () => {
  it("turn the bubble the server never delivered into Retry, matched by the id it was sent as", () => {
    const base = withPending(pending("p1", "lost", { sentAs: "p1-retry2" }), pending("p2", "fine"), pending("p3", "lost too", { state: "failed" }));
    const s = ev(base, { type: "unsent", items: [{ id: "p1-retry2", text: "lost", error: "Stopped before Cursor saved it" }, { id: "p3", text: "lost too", error: "x" }] });
    expect(s.pending.find((p) => p.localId === "p1")).toMatchObject({ state: "failed", resend: true, error: "Stopped before Cursor saved it" });
    expect(s.pending.find((p) => p.localId === "p2")!.state).toBe("sent");
    expect(s.pending.find((p) => p.localId === "p3")!.error).toBeUndefined();
  });

  it("ignores ids it doesn't hold (a replay after the bubble was dropped)", () => {
    const base = withPending(pending("p1", "a"));
    expect(ev(base, { type: "unsent", items: [{ id: "gone", text: "x", error: "y" }] })).toBe(base);
  });

  it("the queue is matched by the id a retry was sent as", () => {
    const p = pending("p1", "a", { sentAs: "p1-abc" });
    expect(serverId(p)).toBe("p1-abc");
    expect(serverId(pending("p2", "b"))).toBe("p2");
  });
});

describe("queued bubbles the server lost", () => {
  const queued = (localId: string, text: string, patch: Partial<Pending> = {}) => pending(localId, text, { via: "queued", ...patch });
  const open = (p: Pending[], queue: string[], status: RunState["status"] = "idle") => {
    const s = ev(withPending(...p), history([], run(status)), true);
    return ev(s, { type: "queue", items: queue.map((id) => ({ id, text: "" })) });
  };
  const ids = (s: SessionView) => lostQueued(s).map((p) => p.localId);

  it("are the queued ones the server no longer holds while nothing runs", () => {
    const s = open([queued("q1", "held"), queued("q2", "lost"), pending("w1", "web"), queued("q3", "failed", { state: "failed" })], ["q1"]);
    expect(ids(s)).toEqual(["q2"]);
    expect(ids(open([queued("q2", "lost")], [], "running"))).toEqual([]);
    expect(ids({ ...open([queued("q2", "lost")], []), status: "reconnecting" })).toEqual([]);
  });

  it("turn into Retry with a fresh send once the grace period ends", () => {
    const s = reducer(open([queued("q1", "lost"), queued("q2", "lost too")], []), { type: "expireQueued", localIds: ["q1"] });
    expect(s.pending.find((p) => p.localId === "q1")).toMatchObject({ state: "failed", resend: true, error: "Queued message not sent." });
    expect(s.pending.find((p) => p.localId === "q2")!.state).toBe("sent");
  });

  it("are left alone when the agent started or the message landed before the timer fired", () => {
    const base = open([queued("q1", "on its way")], []);
    const running = ev(base, { type: "run", run: run("running") });
    expect(reducer(running, { type: "expireQueued", localIds: ["q1"] })).toBe(running);
    const landed = ev(base, { type: "entries", entries: [user("u1", "on its way")] });
    expect(landed.pending).toEqual([]);
    expect(reducer(landed, { type: "expireQueued", localIds: ["q1"] })).toBe(landed);
  });
});

describe("live text", () => {
  it("clears streams when the run ends", () => {
    let s = ev(initial(), { type: "run", run: run("running") });
    s = ev(s, { type: "delta", delta: { msgId: "m1", index: 0, kind: "text", text: "Hel" } });
    s = ev(s, { type: "delta", delta: { msgId: "m1", index: 0, kind: "text", text: "lo" } });
    expect(s.streams[0].text).toBe("Hello");
    s = ev(s, { type: "run", run: run("idle") });
    expect(s.streams).toEqual([]);
  });

  it("ignores another agent's live deltas once its turn is over", () => {
    const s = ev(ev(initial(), { type: "run", run: run("idle") }), { type: "delta", delta: { msgId: "live:k:1:0", index: 0, kind: "text", text: "late" } });
    expect(s.streams).toEqual([]);
  });

  it("a persisted text entry replaces the live stream it matches", () => {
    let s = ev(initial(), { type: "run", run: run("running") });
    s = ev(s, { type: "delta", delta: { msgId: "live:cursor:x:1:0", index: 0, kind: "text", text: "The answer is 42 and that is final." } });
    s = ev(s, { type: "entries", entries: [{ kind: "text", id: "t1", ts: iso(now), msgId: "m9", text: "The answer is 42 and that is final." }] });
    expect(s.streams).toEqual([]);
    expect(s.entries).toHaveLength(1);
  });
});

describe("stream reconnects", () => {
  const delta = (msgId: string, text: string): ServerEvent => ({ type: "delta", delta: { msgId, index: 0, kind: "text", text } });

  it("clear Claude's leftover live text when the run ended during the outage", () => {
    let s = ev(initial(), history([], run("running")), true);
    s = ev(s, delta("msg_1", "Half an ans"));
    s = ev(s, history([], run("idle")));
    expect(s.run?.status).toBe("idle");
    expect(s.streams).toEqual([]);
  });

  it("don't glue deltas from before and after a gap", () => {
    let s = ev(initial(), history([], run("running")), true);
    s = ev(s, delta("msg_1", "The quick "));
    s = ev(s, history([], run("running")));
    s = ev(s, delta("msg_1", "lazy dog"));
    expect(s.streams.map((x) => x.text)).toEqual(["lazy dog"]);
  });

  it("clear other agents' live text too (their server replays it)", () => {
    let s = ev(initial(), history([], run("running")), true);
    s = ev(s, delta("live:codex:t:1:0", "So far"));
    s = ev(s, history([], run("running")));
    expect(s.streams).toEqual([]);
  });

  it("turn delivered web bubbles into Retry when the run crashed while disconnected", () => {
    let s = ev(withPending(pending("p1", "a"), pending("p2", "b", { via: "terminal" })), history([], run("running")), true);
    s = ev(s, history([], run("error", "Claude exited")));
    expect(s.pending.find((p) => p.localId === "p1")).toMatchObject({ state: "failed", resend: true, error: "Claude exited" });
    expect(s.pending.find((p) => p.localId === "p2")!.state).toBe("sent");
  });

  it("leave bubbles alone when the run is fine", () => {
    let s = ev(withPending(pending("p1", "a")), history([], run("running")), true);
    s = ev(s, history([], run("idle")));
    expect(s.pending[0].state).toBe("sent");
  });
});

describe("stream frames", () => {
  it("malformed frames and ones without a type are skipped instead of dropping the connection", () => {
    expect(parseEvent("{not json")).toBeNull();
    expect(parseEvent("null")).toBeNull();
    expect(parseEvent('"text"')).toBeNull();
    expect(parseEvent('{"entries":[]}')).toBeNull();
    expect(parseEvent('{"type":"title","title":"x"}')).toEqual({ type: "title", title: "x" });
  });

  it("a reset or gap marker asks for a fresh load", () => {
    expect(parseEvent('{"type":"reset"}')).toBe(RESET);
    expect(parseEvent('{"type":"gap","reason":"rewritten"}')).toBe(RESET);
  });

  it("event types this client doesn't know leave the view as it was", () => {
    const s = ev(initial(), history([user("a", "x")]), true);
    const unknown = parseEvent('{"type":"somethingNew","payload":1}') as ServerEvent;
    expect(reducer(s, { type: "event", event: unknown })).toBe(s);
  });
});
