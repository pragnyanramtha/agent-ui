import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerEvent } from "@/lib/types";

/* The non-Claude message queue, driven through the real route handlers with a fake agent
 * whose turns are real `sh` processes (so Stop, exit and drain timing are the real thing). */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentu-queue-"));
const log = path.join(dir, "sent.log");
/** what the fake agent "saved" to its transcript, like a CLI store */
const saved = path.join(dir, "saved.log");
const events: { key: string; e: ServerEvent }[] = [];
const notices: string[] = [];
/** per-test knobs for the fake agent */
const fake = { turnMs: 400, saveMs: 0, noSave: false, failOn: null as string | null, sends: [] as { text: string; model?: string }[] };

vi.mock("@/lib/server/profiles", () => {
  const profile = { id: "default", label: "Fake", agent: "cursor", env: {}, args: [], models: [], defaultModel: undefined };
  return {
    activeProfile: () => null,
    pickProfile: () => profile,
    setSessionProfile: () => undefined,
    withProfile: <T,>(_p: unknown, fn: () => T) => fn(),
  };
});
vi.mock("@/lib/server/fallback", () => ({
  guardTurn: () => undefined,
  onSessionEvent: () => () => undefined,
  postNotice: (_key: string, text: string) => void notices.push(text),
  postToSession: (key: string, e: ServerEvent) => void events.push({ key, e }),
  sameStore: () => true,
}));
vi.mock("@/lib/server/input", () => ({ InputRefused: class extends Error {}, inputTarget: async () => null, typeIntoTerminal: async () => ({ queued: false }) }));
vi.mock("@/lib/server/agents/bridge", () => ({ terminalOf: async () => null, toRunState: () => null }));
vi.mock("@/lib/server/agents/index", async () => {
  const run = await import("@/lib/server/agents/cli-run");
  const key = (n: string) => `cursor:${n}`;
  const adapter = {
    label: "Fake",
    runState: (n: string) => run.turnState(key(n)),
    stop: async (n: string) => run.stopTurn(key(n)),
    send: async (n: string, text: string, o: { model?: string }) => {
      if (fake.failOn && text.includes(fake.failOn)) throw new Error(`refused ${text}`);
      fake.sends.push({ text, model: o.model });
      const script = `printf '%s\\n' "$1" >> "$2"; sleep "$4"; printf '%s\\n' "$1" >> "$5"; sleep "$3"`;
      run.startTurn(key(n), { cmd: "sh", args: ["-c", script, "sh", text, log, String(fake.turnMs / 1000), String(fake.saveMs / 1000), fake.noSave ? "/dev/null" : saved], cwd: dir });
    },
    history: async () => {
      const lines = fs.existsSync(saved) ? fs.readFileSync(saved, "utf8").trim().split("\n").filter(Boolean) : [];
      return { entries: lines.map((text, i) => ({ kind: "user", id: `u${i}`, ts: "", text, images: 0 })), cursor: null, end: String(lines.length) };
    },
  };
  return { adapterFor: async () => adapter, sessionKey: (agent: string, n: string) => `${agent}:${n}` };
});

const { agentControl, agentMessage } = await import("@/lib/server/agents/routes");
const cli = await import("@/lib/server/agents/cli-run");

let n = 0;
let session = "";
const send = async (text: string, extra: Record<string, unknown> = {}) => (await agentMessage("cursor", session, { text, clientId: `id-${text.replace(/\W/g, "")}`, ...extra })).json();
const sent = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
const lastQueue = () => [...events].reverse().find((x) => x.key === `cursor:${session}` && x.e.type === "queue")?.e as Extract<ServerEvent, { type: "queue" }> | undefined;
const idle = () => vi.waitFor(() => expect(cli.turnState(`cursor:${session}`)?.status).not.toBe("running"), { timeout: 10_000, interval: 50 });
const drained = (count: number) => vi.waitFor(() => expect(sent()).toHaveLength(count), { timeout: 15_000, interval: 50 });

beforeEach(() => {
  session = `s${++n}`;
  fs.rmSync(log, { force: true });
  fs.rmSync(saved, { force: true });
  events.length = 0;
  notices.length = 0;
  Object.assign(fake, { turnMs: 400, saveMs: 0, noSave: false, failOn: null, sends: [] });
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("non-Claude message queue", () => {
  it("sends at once when idle, queues while a turn runs, and drains in order", async () => {
    expect(await send("first")).toMatchObject({ via: "web" });
    expect(await send("second")).toMatchObject({ via: "queued" });
    expect(await send("third")).toMatchObject({ via: "queued" });
    expect(lastQueue()?.items.map((i) => i.text)).toEqual(["second", "third"]);
    await drained(3);
    await idle();
    expect(sent()).toEqual(["first", "second", "third"]);
    expect(lastQueue()?.items).toEqual([]);
  });

  it("a burst of concurrent sends never runs two turns at once or loses one", async () => {
    const texts = Array.from({ length: 6 }, (_, i) => `burst${i}`);
    const results = await Promise.all(texts.map((t) => send(t)));
    expect(results.filter((r) => r.via === "web")).toHaveLength(1);
    await drained(6);
    await idle();
    expect(new Set(sent())).toEqual(new Set(texts));
    expect(sent()[0]).toBe(texts[results.findIndex((r) => r.via === "web")]);
  });

  it("the same client id queued twice (a retried POST) is held once", async () => {
    await send("running");
    await send("dup", { clientId: "same-client-id" });
    await send("dup", { clientId: "same-client-id" });
    expect(lastQueue()?.items).toHaveLength(1);
    await drained(2);
    await idle();
    expect(sent()).toEqual(["running", "dup"]);
  });

  it("Remove takes a message back before it goes out", async () => {
    await send("running");
    await send("keep");
    await send("drop", { clientId: "drop-me-123" });
    await agentControl("cursor", session, { action: "unqueue", value: "drop-me-123" });
    expect(lastQueue()?.items.map((i) => i.text)).toEqual(["keep"]);
    await drained(2);
    await idle();
    await new Promise((r) => setTimeout(r, 300));
    expect(sent()).toEqual(["running", "keep"]);
  });

  it("Send now moves a message first and stops the running turn", async () => {
    fake.turnMs = 20_000;
    await send("long");
    await send("a");
    await send("b", { clientId: "send-b-now" });
    await drained(1);
    fake.turnMs = 300;
    const t0 = Date.now();
    await agentControl("cursor", session, { action: "sendQueued", value: "send-b-now" });
    await drained(3);
    expect(sent()).toEqual(["long", "b", "a"]);
    expect(Date.now() - t0).toBeLessThan(8000);
    await idle();
  });

  it("Stop with a queue goes on to the next message", async () => {
    fake.turnMs = 20_000;
    await send("long");
    fake.turnMs = 200;
    await send("next");
    await drained(1);
    await agentControl("cursor", session, { action: "stop" });
    await drained(2);
    await idle();
    expect(sent()).toEqual(["long", "next"]);
  });

  it("a queued message that fails to start is reported and the next one still goes", async () => {
    await send("ok1");
    await send("BAD message");
    await send("ok2");
    fake.failOn = "BAD";
    await drained(2);
    await idle();
    expect(sent()).toEqual(["ok1", "ok2"]);
    expect(notices.join("\n")).toMatch(/Queued message not sent \("BAD message"\)/);
  });

  it("each queued message keeps its own model", async () => {
    await send("m0", { model: "model-a" });
    await send("m1", { model: "model-b" });
    await send("m2");
    await drained(3);
    await idle();
    expect(fake.sends.map((s) => s.model)).toEqual(["model-a", "model-b", undefined]);
  });

  it("a send that fails to start reports the error and doesn't leave the session stuck", async () => {
    fake.failOn = "boom";
    const res = await agentMessage("cursor", session, { text: "boom now", clientId: "boom-now-1" });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/refused boom now/);
    fake.failOn = null;
    expect(await send("after")).toMatchObject({ via: "web" });
    await idle();
  });

  it("a turn stopped before the agent saved its prompt is reported as unsent", async () => {
    fake.turnMs = 20_000;
    fake.saveMs = 10_000;
    await send("never saved", { clientId: "never-saved-1" });
    await drained(1);
    await agentControl("cursor", session, { action: "stop" });
    await idle();
    await vi.waitFor(() => expect(events.some((x) => x.e.type === "unsent")).toBe(true), { timeout: 6000, interval: 100 });
    const u = [...events].reverse().find((x) => x.e.type === "unsent")!.e as Extract<ServerEvent, { type: "unsent" }>;
    expect(u.items).toEqual([{ id: "never-saved-1", text: "never saved", error: expect.stringContaining("Not delivered") }]);
  });

  it("a stopped turn whose prompt was saved, or a turn nobody stopped, isn't reported", async () => {
    fake.turnMs = 20_000;
    await send("saved then stopped", { clientId: "saved-stop-1" });
    await vi.waitFor(() => expect(fs.existsSync(saved)).toBe(true), { timeout: 5000, interval: 50 });
    await agentControl("cursor", session, { action: "stop" });
    await idle();
    fake.turnMs = 100;
    fake.noSave = true;
    await send("ran to the end", { clientId: "ran-end-1" });
    await idle();
    await new Promise((r) => setTimeout(r, 3500));
    expect(events.some((x) => x.e.type === "unsent")).toBe(false);
  });

  it("rejects an empty message and an unknown control action", async () => {
    expect((await agentMessage("cursor", session, { text: "   " })).status).toBe(400);
    expect((await agentControl("cursor", session, { action: "bogus" })).status).toBe(400);
    expect((await agentControl("cursor", session, { action: "mode", value: "nope" })).status).toBe(400);
  });
});
