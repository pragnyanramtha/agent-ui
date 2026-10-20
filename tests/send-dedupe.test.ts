import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { once } from "@/lib/server/dedupe";
import { postReliably, transient } from "@/lib/client/send";
import { ApiError } from "@/lib/client/api";

describe("server-side send dedupe", () => {
  it("a retried send with the same client id gets the first answer and doesn't run again", async () => {
    let runs = 0;
    const fn = async () => (runs++, NextResponse.json({ id: "s1", via: "web" }));
    const [a, b] = await Promise.all([once("client-abc-1", fn), once("client-abc-1", fn)]);
    const c = await once("client-abc-1", fn);
    expect(runs).toBe(1);
    expect(await a.json()).toEqual({ id: "s1", via: "web" });
    expect(await b.json()).toEqual({ id: "s1", via: "web" });
    expect(c.headers.get("x-agent-u-replay")).toBe("1");
  });

  it("a send that failed can be tried again for real", async () => {
    let runs = 0;
    const fn = async () => (runs++, NextResponse.json({ error: "x" }, { status: runs === 1 ? 502 : 200 }));
    expect((await once("client-fail-1", fn)).status).toBe(502);
    await new Promise((r) => setTimeout(r, 0));
    expect((await once("client-fail-1", fn)).status).toBe(200);
    expect(runs).toBe(2);
  });

  it("a thrown handler doesn't poison the id", async () => {
    let runs = 0;
    const bad = async (): Promise<Response> => {
      runs++;
      throw new Error("boom");
    };
    await expect(once("client-throw-1", bad)).rejects.toThrow("boom");
    await new Promise((r) => setTimeout(r, 0));
    expect((await once("client-throw-1", async () => (runs++, NextResponse.json({ ok: true })))).status).toBe(200);
    expect(runs).toBe(2);
  });

  it("missing or malformed ids aren't deduped", async () => {
    let runs = 0;
    const fn = async () => (runs++, NextResponse.json({}));
    await once(undefined, fn);
    await once(undefined, fn);
    await once("short", fn);
    await once("short", fn);
    await once("bad id with spaces!!", fn);
    expect(runs).toBe(5);
  });
});

describe("client reliable post", () => {
  const calls: unknown[] = [];
  let answers: (() => Response | Promise<Response>)[] = [];
  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      const next = answers.shift();
      if (!next) throw new Error("no more answers");
      return next();
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const netErr = () => Promise.reject(new TypeError("Failed to fetch"));

  it("retries network errors and gateway failures with the same client id", async () => {
    answers = [netErr, () => new Response("<html>Bad gateway</html>", { status: 502 }), json(530, {}), json(200, { via: "web" })];
    const retries: number[] = [];
    const out = await postReliably<{ via: string }>("/api/x", { text: "hi" }, "cid-123456", { onRetry: (n) => retries.push(n) });
    expect(out).toEqual({ via: "web" });
    expect(calls).toHaveLength(4);
    expect(new Set(calls.map((c) => (c as { clientId: string }).clientId))).toEqual(new Set(["cid-123456"]));
    expect(retries).toEqual([1, 2, 3]);
  }, 30_000);

  it("doesn't retry real refusals (409 busy, 500 terminal error, 400)", async () => {
    for (const status of [409, 500, 400]) {
      answers = [json(status, { error: `e${status}`, code: "x" }), json(200, {})];
      calls.length = 0;
      await expect(postReliably("/api/x", {}, "cid-abcdefg")).rejects.toMatchObject({ status, message: `e${status}` });
      expect(calls).toHaveLength(1);
    }
  });

  it("doesn't retry an app error even when it comes with a gateway status", async () => {
    answers = [json(502, { error: "Message too long." }), json(200, {})];
    calls.length = 0;
    await expect(postReliably("/api/x", {}, "cid-app502")).rejects.toMatchObject({ status: 502, message: "Message too long." });
    expect(calls).toHaveLength(1);
  });

  it("gives up after its time budget", async () => {
    answers = Array.from({ length: 20 }, () => netErr);
    await expect(postReliably("/api/x", {}, "cid-budget1", { forMs: 1000 })).rejects.toThrow("Failed to fetch");
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.length).toBeLessThan(5);
  });

  it("stops retrying when aborted", async () => {
    answers = Array.from({ length: 20 }, () => netErr);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    await expect(postReliably("/api/x", {}, "cid-abort12", { signal: ac.signal })).rejects.toThrow();
    expect(calls.length).toBeLessThan(4);
  });
});

describe("transient", () => {
  it("is true for network failures and bare gateway answers only", () => {
    expect(transient(new TypeError("Failed to fetch"))).toBe(true);
    for (const status of [502, 503, 504, 530]) expect(transient(new ApiError(`Request failed (${status})`, status))).toBe(true);
    expect(transient(new ApiError("Couldn't send to the terminal: gone", 502))).toBe(false);
    expect(transient(new ApiError("Request failed (500)", 500))).toBe(false);
    expect(transient(new ApiError("Busy", 409))).toBe(false);
  });
});
