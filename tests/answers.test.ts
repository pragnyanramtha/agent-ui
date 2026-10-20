import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const answerTurn = vi.fn(() => true);
vi.mock("@/lib/server/agents/cli-run", () => ({ answerTurn: (...args: unknown[]) => (answerTurn as (...a: unknown[]) => boolean)(...args) }));

const { POST } = await import("@/app/api/sessions/[id]/respond/route");
const { answerAsk, failureText } = await import("@/lib/client/send");
const { ApiError } = await import("@/lib/client/api");

const post = (id: string, body: unknown) =>
  POST(new NextRequest(`http://x/api/sessions/${id}/respond`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }), {
    params: Promise.resolve({ id }),
  });

describe("respond route", () => {
  beforeEach(() => answerTurn.mockClear());

  it("an answer retried after a lost reply gets the first answer, not 'already closed'", async () => {
    answerTurn.mockReturnValueOnce(true).mockReturnValue(false);
    const body = { requestId: "r1", allow: true, clientId: "cAnswerRetry1" };
    const a = await post("codex:t1", body);
    const b = await post("codex:t1", body);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await b.json()).toEqual({ ok: true });
    expect(answerTurn).toHaveBeenCalledTimes(1);
  });

  it("without a client id a second answer is refused", async () => {
    answerTurn.mockReturnValueOnce(true).mockReturnValue(false);
    expect((await post("codex:t2", { requestId: "r2", allow: true })).status).toBe(200);
    expect((await post("codex:t2", { requestId: "r2", allow: true })).status).toBe(410);
  });
});

describe("answerAsk", () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  let replies: (() => Response | Promise<Response>)[] = [];
  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      const next = replies.shift();
      if (!next) throw new Error("no more replies");
      return next();
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  it("retries a dropped answer under one client id", async () => {
    replies = [() => Promise.reject(new TypeError("Failed to fetch")), json(200, { ok: true })];
    await answerAsk("codex:t1", { requestId: "r1", allow: true });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("/api/sessions/codex%3At1/respond");
    expect(calls[0].body.clientId).toMatch(/^c[a-z0-9]{8,}$/);
    expect(calls[1].body.clientId).toBe(calls[0].body.clientId);
  });

  it("each answer gets its own client id", async () => {
    replies = [json(200, { ok: true }), json(200, { ok: true })];
    await answerAsk("s", { requestId: "r1", allow: true });
    await answerAsk("s", { requestId: "r1", allow: true });
    expect(calls[0].body.clientId).not.toBe(calls[1].body.clientId);
  });

  it("rejects with the server's reason so the card can say it and offer the answer again", async () => {
    replies = [json(410, { error: "That request already closed." })];
    const err = await answerAsk("s", { requestId: "r1", allow: false }).catch((e: unknown) => e);
    expect(failureText(err)).toBe("That request already closed.");
    expect(failureText(new TypeError("Failed to fetch"))).toBe("Couldn't reach the server.");
    expect(failureText(new ApiError("Request failed (502)", 502))).toBe("Couldn't reach the server.");
  });
});
