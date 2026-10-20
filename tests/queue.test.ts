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
const fake = { turnMs: 400, saveMs: 0, noSave: false, failOn: null as string | null, cwd: dir, sends: [] as { text: string; model?: string; mode?: string }[] };

vi.mock("@/lib/server/profiles", () => {
  const profile = { id: "default", label: "Fake", agent: "cursor", env: {}, args: [], models: [], defaultModel: undefined };
  return {
    CONFIG_DIR: dir,
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
    get: async (n: string) => ({ id: n, cwd: fake.cwd }),
    runState: (n: string) => run.turnState(key(n)),
    stop: async (n: string) => run.stopTurn(key(n)),
    send: async (n: string, text: string, o: { model?: string; mode?: string }) => {
      if (fake.failOn && text.includes(fake.failOn)) throw new Error(`refused ${text}`);
      fake.sends.push({ text, model: o.model, mode: o.mode });
      const script = `printf '%s\\n' "$1" >> "$2"; sleep "$4"; printf '%s\\n' "$1" >> "$5"; sleep "$3"`;
      run.startTurn(key(n), { cmd: "sh", args: ["-c", script, "sh", text, log, String(fake.turnMs / 1000), String(fake.saveMs / 1000), fake.noSave ? "/dev/null" : saved], cwd: dir });
    },
    history: async () => {
      const lines = fs.existsSync(saved) ? fs.readFileSync(saved, "utf8").trim().split("\n").filter(Boolean) : [];
      return { entries: lines.map((text, i) => ({ kind: "user", id: `u${i}`, ts: "", text, images: 0 })), cursor: null, end: String(lines.length) };
    },
  };
  return {
    adapterFor: async () => adapter,
    sessionKey: (agent: string, n: string) => `${agent}:${n}`,
    parseSessionKey: (k: string) => ({ agent: k.slice(0, k.indexOf(":")), native: k.slice(k.indexOf(":") + 1) }),
  };
});

let routes = await import("@/lib/server/agents/routes");
const agentControl: typeof routes.agentControl = (...a) => routes.agentControl(...a);
const agentMessage: typeof routes.agentMessage = (...a) => routes.agentMessage(...a);
const cli = await import("@/lib/server/agents/cli-run");
const queueFile = path.join(dir, "queue.json");

/* What a restart does to this module state: running turns die, in-memory maps are gone, modules load again.
 * `edit` changes the saved file in between (as if it had been written by an older run). */
async function restart(edit?: (saved: { modes: Record<string, string>; queues: Record<string, unknown[]> }) => void) {
  const gg = globalThis as Record<string, unknown> & { __agentuDrains?: Map<string, () => void> };
  gg.__agentuDrains?.forEach((off) => off());
  (await import("@/lib/server/agents/queue-store")).flushQueues();
  for (const k of ["__agentuQueueStore", "__agentuDrains", "__agentuResumed", "__agentuUnsent", "__agentuSending", "__agentuStopped"]) delete gg[k];
  cli.runningTurns().forEach((k) => cli.stopTurn(k));
  await vi.waitFor(() => expect(cli.runningTurns()).toEqual([]), { timeout: 10_000, interval: 50 });
  if (edit) {
    const saved = JSON.parse(fs.readFileSync(queueFile, "utf8"));
    edit(saved);
    fs.writeFileSync(queueFile, JSON.stringify(saved));
  }
  vi.resetModules();
  routes = await import("@/lib/server/agents/routes");
}
const onDisk = async () => {
  (await import("@/lib/server/agents/queue-store")).flushQueues();
  return JSON.parse(fs.readFileSync(queueFile, "utf8")) as { modes: Record<string, string>; queues: Record<string, { id: string; text: string; at: number }[]> };
};

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
  Object.assign(fake, { turnMs: 400, saveMs: 0, noSave: false, failOn: null, cwd: dir, sends: [] });
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

  it("switching the approval mode applies to messages already queued", async () => {
    await send("q0", { permissionMode: "bypassPermissions" });
    await send("q1", { permissionMode: "bypassPermissions" });
    await agentControl("cursor", session, { action: "mode", value: "default" });
    await drained(2);
    await idle();
    expect(fake.sends.map((s) => s.mode)).toEqual(["bypassPermissions", "default"]);
    expect((await onDisk()).queues[`cursor:${session}`] ?? []).toEqual([]);
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

  it("a session whose folder is gone says so instead of starting the agent", async () => {
    fake.cwd = path.join(dir, "deleted-project");
    const res = await agentMessage("cursor", session, { text: "hello", clientId: "gone-1" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: `This session's folder is gone: ${fake.cwd}. Put it back, or start a new session in another folder.`, code: "folder_missing" });
    expect(fake.sends).toEqual([]);
    fake.cwd = dir;
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

describe("queue and approval mode across a restart", () => {
  const key = () => `cursor:${session}`;
  const unsentEvents = () => events.filter((x) => x.key === key() && x.e.type === "unsent").map((x) => x.e as Extract<ServerEvent, { type: "unsent" }>);

  it("saves the queue to disk with each change, owner-only", async () => {
    fake.turnMs = 20_000;
    await send("running");
    await send("held one", { clientId: "held-1", model: "model-a" });
    await send("held two", { clientId: "held-2" });
    expect((await onDisk()).queues[key()]).toEqual([
      expect.objectContaining({ id: "held-1", text: "held one", model: "model-a", mode: "bypassPermissions", at: expect.any(Number) }),
      expect.objectContaining({ id: "held-2", text: "held two" }),
    ]);
    expect(fs.statSync(queueFile).mode & 0o777).toBe(0o600);
    await agentControl("cursor", session, { action: "unqueue", value: "held-1" });
    expect((await onDisk()).queues[key()].map((q) => q.id)).toEqual(["held-2"]);
    await agentControl("cursor", session, { action: "unqueue", value: "held-2" });
    expect((await onDisk()).queues[key()]).toBeUndefined();
    await agentControl("cursor", session, { action: "stop" });
    await idle();
  });

  it("messages queued before a restart go out after it, in order, with their own model", async () => {
    fake.turnMs = 20_000;
    await send("long");
    await send("after one", { model: "model-b" });
    await send("after two");
    await drained(1);
    await restart();
    expect(sent()).toEqual(["long"]);
    fake.turnMs = 200;
    await routes.resumeQueues();
    await drained(3);
    await idle();
    expect(sent()).toEqual(["long", "after one", "after two"]);
    expect(fake.sends.slice(1).map((s) => s.model)).toEqual(["model-b", undefined]);
    await vi.waitFor(async () => expect((await onDisk()).queues[key()]).toBeUndefined(), { timeout: 5000, interval: 100 });
  });

  it("messages that waited more than 6 hours are reported instead of sent", async () => {
    await restart((saved) => {
      saved.queues[key()] = [
        { id: "stale-1", text: "from yesterday", mode: "default", profile: null, at: Date.now() - 7 * 60 * 60_000 },
        { id: "fresh-1", text: "from a minute ago", mode: "default", profile: null, at: Date.now() - 60_000 },
      ];
    });
    await routes.resumeQueues();
    await drained(1);
    await idle();
    expect(sent()).toEqual(["from a minute ago"]);
    expect(fake.sends[0].mode).toBe("default");
    expect(unsentEvents().at(-1)?.items).toEqual([{ id: "stale-1", text: "from yesterday", error: "Queued message not sent after restart." }]);
    expect((await onDisk()).queues[key()]).toBeUndefined();
  });

  it("resuming survives an agent that can't start, and only runs once", async () => {
    fake.failOn = "BROKEN";
    await restart((saved) => {
      saved.queues[key()] = [
        { id: "broken-1", text: "BROKEN agent", mode: "default", profile: null, at: Date.now() },
        { id: "fine-1", text: "fine after", mode: "default", profile: null, at: Date.now() },
      ];
    });
    await Promise.all([routes.resumeQueues(), routes.resumeQueues()]);
    await drained(1);
    await idle();
    await new Promise((r) => setTimeout(r, 300));
    expect(sent()).toEqual(["fine after"]);
    expect(unsentEvents().at(-1)?.items).toEqual([{ id: "broken-1", text: "BROKEN agent", error: expect.stringMatching(/^Not sent: refused BROKEN agent/) }]);
  });

  it("the approval mode chosen for a session survives a restart", async () => {
    expect((await agentControl("cursor", session, { action: "mode", value: "default" })).status).toBe(200);
    expect((await onDisk()).modes[key()]).toBe("default");
    await restart();
    await send("after restart");
    await idle();
    expect(fake.sends.map((s) => s.mode)).toEqual(["default"]);
    /* a session nobody chose a mode for still starts in Bypass */
    session = `s${++n}`;
    await send("other session");
    await idle();
    expect(fake.sends.map((s) => s.mode)).toEqual(["default", "bypassPermissions"]);
  });
});
