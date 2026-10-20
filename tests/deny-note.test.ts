import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { fakes, init } from "./fake-claude-sdk";

/* "Deny with note…": the reason travels from the respond route to the agent's permission answer. */

vi.mock("@anthropic-ai/claude-agent-sdk", async () => ({ query: (await import("./fake-claude-sdk")).query }));
const { startRun } = await import("@/lib/server/runner");
const { POST } = await import("@/app/api/sessions/[id]/respond/route");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const post = (id: string, body: unknown) =>
  POST(new NextRequest(`http://x/api/sessions/${id}/respond`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }), {
    params: Promise.resolve({ id }),
  });

async function asking(id: string) {
  const run = startRun({ resume: id, cwd: "/", permissionMode: "default" });
  run.send("hi");
  const f = fakes.at(-1)!;
  f.push(init(id));
  await sleep(5);
  const answer = f.opts.canUseTool("Bash", { command: "rm -rf build" }, { signal: new AbortController().signal, suggestions: [] }) as Promise<{ behavior: string; message?: string }>;
  await sleep(5);
  const requestId = run.state.pending[0]?.requestId;
  return { run, answer, requestId };
}

describe("deny with a note", () => {
  it("Claude gets the note as the reason for the denial", async () => {
    const id = "bbbbbbbb-0000-4000-8000-000000000001";
    const { run, answer, requestId } = await asking(id);
    expect(requestId).toBeTruthy();
    const res = await post(id, { requestId, allow: false, message: "Don't delete build, run make clean instead." });
    expect(res.status).toBe(200);
    expect(await answer).toMatchObject({ behavior: "deny", message: "Don't delete build, run make clean instead." });
    expect(run.state.pending).toHaveLength(0);
    run.close();
  });

  it("without a note the default reason still goes out", async () => {
    const id = "bbbbbbbb-0000-4000-8000-000000000002";
    const { run, answer, requestId } = await asking(id);
    await post(id, { requestId, allow: false });
    expect(await answer).toMatchObject({ behavior: "deny", message: "The user declined this from the web UI." });
    run.close();
  });

  it("the browser sends the note in the answer", async () => {
    const { answerAsk } = await import("@/lib/client/send");
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    try {
      await answerAsk("s", { requestId: "r1", allow: false, message: "Use pnpm." });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(bodies[0]).toMatchObject({ requestId: "r1", allow: false, message: "Use pnpm." });
  });

  it("a note that isn't text is ignored", async () => {
    const id = "bbbbbbbb-0000-4000-8000-000000000003";
    const { run, answer, requestId } = await asking(id);
    await post(id, { requestId, allow: false, message: { evil: true } });
    expect(await answer).toMatchObject({ behavior: "deny", message: "The user declined this from the web UI." });
    run.close();
  });
});
