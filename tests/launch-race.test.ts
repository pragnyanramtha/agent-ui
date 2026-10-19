import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { TerminalInfo } from "@/lib/types";
import { fakes } from "./fake-claude-sdk";

/* A message sent while the session is being opened in a terminal goes to that terminal once it's up,
 * never into a second claude. The terminal, the pane and the launch are fakes; the routes are real. */

vi.mock("@anthropic-ai/claude-agent-sdk", async () => ({ query: (await import("./fake-claude-sdk")).query }));
const terminals = new Map<string, TerminalInfo>();
const typed: string[] = [];
const launch = { fail: false };
vi.mock("@/lib/server/sessions", () => ({ liveTerminals: async () => terminals, terminalFor: async () => null }));
vi.mock("@/lib/server/input", () => ({
  InputRefused: class extends Error {},
  inputTarget: async () => ({ kind: "tmux", pane: "%1" }),
  typeIntoTerminal: async (_t: unknown, text: string) => (typed.push(text), { queued: false, cleared: null }),
}));
vi.mock("@/lib/server/http", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/http")>()),
  sessionContext: async () => ({ file: "/nonexistent.jsonl", meta: { permissionMode: "default" }, cwd: "/tmp", size: 0 }),
}));
vi.mock("@/lib/server/checkpoints", () => ({ beforeTurn: async () => undefined }));
vi.mock("@/lib/server/terminals", () => ({
  listTerminals: async () => ({ terminals: [], tmux: true }),
  launchAgent: async () => {
    if (launch.fail) throw new Error("tmux failed");
    return { id: "agentu-1", session: "x" };
  },
  killTerminal: async () => ({}),
}));
vi.mock("@/lib/server/agents/bridge", () => ({ terminalForKey: async () => null }));

const { POST: message } = await import("@/app/api/sessions/[id]/message/route");
const { POST: openTerminal } = await import("@/app/api/terminals/route");
const { isLaunching, markLaunching, launchDone } = await import("@/lib/server/launching");
const { getRun } = await import("@/lib/server/runner");

const post = (url: string, body: unknown) => new NextRequest(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const send = (id: string, text: string) => message(post(`http://x/api/sessions/${id}/message`, { text }), { params: Promise.resolve({ id }) });
const tui: TerminalInfo = { pid: 4242, status: "idle", name: null, multiplexer: "tmux" };
let n = 0;
const newId = () => `dddddddd-0000-4000-8000-${String(++n).padStart(12, "0")}`;

beforeEach(() => {
  terminals.clear();
  typed.length = 0;
  launch.fail = false;
});

describe("a message during a terminal launch", () => {
  it("waits for the terminal and types into it", async () => {
    const id = newId();
    markLaunching(id);
    const before = fakes.length;
    setTimeout(() => terminals.set(id, tui), 700);
    const res = await send(id, "hello there");
    expect(await res.json()).toMatchObject({ via: "terminal" });
    expect(typed).toEqual(["hello there"]);
    expect(fakes.length).toBe(before);
    expect(getRun(id)).toBeNull();
    expect(isLaunching(id)).toBe(false);
  });

  it("resumes on the web if the launch fails", async () => {
    const id = newId();
    markLaunching(id);
    setTimeout(() => launchDone(id), 300);
    const res = await send(id, "still here?");
    expect(await res.json()).toMatchObject({ via: "web" });
    expect(typed).toEqual([]);
    getRun(id)?.close();
  });

  it("without a launch, goes straight to the web", async () => {
    const id = newId();
    const t0 = Date.now();
    expect(await (await send(id, "hi")).json()).toMatchObject({ via: "web" });
    expect(Date.now() - t0).toBeLessThan(300);
    getRun(id)?.close();
  });
});

describe("opening a Claude session in a terminal", () => {
  it("holds the lock after a launch and drops it when the launch fails", async () => {
    const ok = newId();
    expect((await openTerminal(post("http://x/api/terminals", { session: ok }))).status).toBe(200);
    expect(isLaunching(ok)).toBe(true);
    launchDone(ok);
    const bad = newId();
    launch.fail = true;
    expect((await openTerminal(post("http://x/api/terminals", { session: bad }))).status).toBe(502);
    expect(isLaunching(bad)).toBe(false);
  });

  it("refuses while a turn runs, without taking the lock", async () => {
    const id = newId();
    expect(await (await send(id, "work")).json()).toMatchObject({ via: "web" });
    const res = await openTerminal(post("http://x/api/terminals", { session: id }));
    expect(res.status).toBe(409);
    expect(isLaunching(id)).toBe(false);
    expect(getRun(id)?.live).toBe(true);
    getRun(id)?.close();
  });
});
