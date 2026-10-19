import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { newSessionEpoch, signSession } from "@/lib/auth";
import { readRespondToken, RESPOND_HEADER, RESPOND_TTL_MS, signRespondToken, spendRespondToken } from "@/lib/server/push-token";
import { askUser, stopTurn, startTurn, turnState, type Answer } from "@/lib/server/agents/cli-run";
import { withActions } from "@/lib/server/notify";
import type { PushMessage } from "@/lib/server/push";
import type { PendingAsk, RunState, SessionSummary } from "@/lib/types";

const keys = ["AGENT_U_HOME", "UI_SECRET", "UI_PASSWORD", "UI_PASSWORD_HASH"] as const;
let saved: Record<string, string | undefined> = {};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentu-push-respond-"));
beforeEach(() => {
  saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { AGENT_U_HOME: fs.mkdtempSync(path.join(dir, "cfg-")), UI_SECRET: "s".repeat(40), UI_PASSWORD: "pw" });
  delete process.env.UI_PASSWORD_HASH;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const T0 = 1_800_000_000_000;

describe("respond tokens", () => {
  it("name one request of one session and verify until they expire", () => {
    const t = signRespondToken("codex:abc", "req-1", T0);
    expect(readRespondToken(t, T0)).toEqual({ session: "codex:abc", request: "req-1", expires: T0 + RESPOND_TTL_MS });
    expect(readRespondToken(t, T0 + RESPOND_TTL_MS)).not.toBeNull();
    expect(readRespondToken(t, T0 + RESPOND_TTL_MS + 1)).toBeNull();
  });

  it("refuse anything edited, forged, oversized or signed too far ahead", () => {
    const t = signRespondToken("codex:abc", "req-1", T0);
    const [s, r, e, sig] = t.split(".");
    const other = Buffer.from("req-2").toString("base64url");
    expect(readRespondToken([s, other, e, sig].join("."), T0)).toBeNull();
    expect(readRespondToken([s, r, String(Number(e) + 1), sig].join("."), T0)).toBeNull();
    expect(readRespondToken([s, r, e, `${sig.slice(0, -2)}AA`].join("."), T0)).toBeNull();
    expect(readRespondToken(`${s}=.${r}.${e}.${sig}`, T0)).toBeNull();
    expect(readRespondToken(`${t}.x`, T0)).toBeNull();
    expect(readRespondToken("", T0)).toBeNull();
    expect(readRespondToken(null, T0)).toBeNull();
    expect(readRespondToken("a".repeat(2000), T0)).toBeNull();
    /* a validly signed token that lives longer than we ever sign */
    expect(readRespondToken(signRespondToken("codex:abc", "req-1", T0 + 3 * RESPOND_TTL_MS), T0)).toBeNull();
  });

  it("die with a new secret, a new password or a sign-out everywhere", () => {
    const t = signRespondToken("codex:abc", "req-1", T0);
    process.env.UI_SECRET = "t".repeat(40);
    expect(readRespondToken(t, T0)).toBeNull();
    process.env.UI_SECRET = "s".repeat(40);
    process.env.UI_PASSWORD = "new";
    expect(readRespondToken(t, T0)).toBeNull();
    process.env.UI_PASSWORD = "pw";
    expect(readRespondToken(t, T0)).not.toBeNull();
    newSessionEpoch();
    expect(readRespondToken(t, T0)).toBeNull();
  });

  it("can't be signed or read without a real secret", () => {
    const t = signRespondToken("codex:abc", "req-1", T0);
    process.env.UI_SECRET = "short";
    expect(() => signRespondToken("codex:abc", "req-1", T0)).toThrow(/UI_SECRET/);
    expect(readRespondToken(t, T0)).toBeNull();
  });

  it("work once", () => {
    const t = signRespondToken("codex:abc", "req-once", T0);
    expect(spendRespondToken(t, T0)).not.toBeNull();
    expect(spendRespondToken(t, T0 + 1)).toBeNull();
    expect(readRespondToken(t, T0 + 1)).not.toBeNull();
  });
});

describe("approval pushes", () => {
  const permission: PendingAsk = { kind: "permission", requestId: "r1", toolName: "Bash", title: "Run ls", description: null, input: {}, canAlwaysAllow: false };
  const question: PendingAsk = { kind: "question", requestId: "q1", questions: [] };
  const web = (pending: PendingAsk[]): RunState => ({ status: "idle", model: null, permissionMode: "default", slashCommands: [], pending, error: null, costUsd: null, sessionId: "x" });
  const row = (id: string, pending: PendingAsk[]): SessionSummary => ({ id, agent: "codex", title: "t", cwd: "/", project: "", mtime: 0, size: 0, terminal: null, web: web(pending) });
  const msg = (kind: PushMessage["kind"], session: string): PushMessage => ({ kind, title: "t", body: "b", tag: `act:${session}`, url: "/", session });

  it("carry a token only for a tool approval", () => {
    const rows = [row("codex:a", [permission]), row("codex:b", [question])];
    const sign = (s: string, r: string) => `${s}|${r}`;
    const out = withActions([msg("needs", "codex:a"), msg("needs", "codex:b"), msg("failed", "codex:a"), msg("needs", "codex:gone")], rows, sign);
    expect(out.map((m) => m.respond?.token ?? null)).toEqual(["codex:a|r1", null, null, null]);
  });

  it("go out without buttons when tokens can't be signed", () => {
    const out = withActions([msg("needs", "codex:a")], [row("codex:a", [permission])], () => {
      throw new Error("UI_SECRET must be set");
    });
    expect(out[0].respond).toBeUndefined();
  });
});

describe("POST /api/push/respond", () => {
  const url = "http://127.0.0.1:3311/api/push/respond";
  const req = (body: unknown, headers: Record<string, string> = {}) =>
    new NextRequest(url, { method: "POST", body: JSON.stringify(body), headers: { host: "127.0.0.1:3311", origin: "http://127.0.0.1:3311", "content-type": "application/json", ...headers } });

  /* a turn of a CLI agent that asks before running a tool, like Codex's app server */
  function asking(key: string, ask: PendingAsk) {
    const answers: Answer[] = [];
    const run = startTurn(key, { cmd: "sh", args: ["-c", "sleep 5"], cwd: "/" });
    askUser(run, ask, (a) => answers.push(a));
    return answers;
  }

  it("the middleware lets only this route through, only as a POST, only with a valid token", async () => {
    const { middleware } = await import("@/middleware");
    const token = signRespondToken("codex:mw", "r1");
    const res = await middleware(req({ action: "allow" }, { [RESPOND_HEADER]: token }));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect((await middleware(req({ action: "allow" }))).status).toBe(401);
    expect((await middleware(req({ action: "allow" }, { [RESPOND_HEADER]: `${token}x` }))).status).toBe(401);
    /* the token opens no other route */
    const other = new NextRequest("http://127.0.0.1:3311/api/sessions/codex:mw/respond", { method: "POST", body: "{}", headers: { host: "127.0.0.1:3311", origin: "http://127.0.0.1:3311", [RESPOND_HEADER]: token } });
    expect((await middleware(other)).status).toBe(401);
    const get = new NextRequest(url, { headers: { host: "127.0.0.1:3311", [RESPOND_HEADER]: token } });
    expect((await middleware(get)).status).toBe(401);
    /* and a foreign page can't post it */
    expect((await middleware(req({ action: "allow" }, { [RESPOND_HEADER]: token, origin: "https://evil.example" }))).status).toBe(403);
  });

  it("answers the approval the token names, once", async () => {
    const { POST } = await import("@/app/api/push/respond/route");
    const key = "codex:pushallow";
    const answers = asking(key, { kind: "permission", requestId: "r1", toolName: "Bash", title: "Run ls", description: null, input: {}, canAlwaysAllow: true });
    const token = signRespondToken(key, "r1");
    const res = await POST(req({ action: "allow" }, { [RESPOND_HEADER]: token }));
    expect(res.status).toBe(200);
    expect(answers).toEqual([{ allow: true, always: false }]);
    expect(turnState(key)?.pending).toEqual([]);
    const again = await POST(req({ action: "deny" }, { [RESPOND_HEADER]: token }));
    expect(again.status).toBe(401);
    expect(answers).toHaveLength(1);
    stopTurn(key);
  });

  it("denies, and never answers a question, another request or another session", async () => {
    const { POST } = await import("@/app/api/push/respond/route");
    const key = "codex:pushdeny";
    const answers = asking(key, { kind: "permission", requestId: "r1", toolName: "Bash", title: "Run ls", description: null, input: {}, canAlwaysAllow: false });
    const qKey = "codex:pushquestion";
    const qAnswers = asking(qKey, { kind: "question", requestId: "q1", questions: [] });

    expect((await POST(req({ action: "allow" }, { [RESPOND_HEADER]: signRespondToken(key, "r2") }))).status).toBe(410);
    expect((await POST(req({ action: "allow" }, { [RESPOND_HEADER]: signRespondToken("codex:other", "r1") }))).status).toBe(410);
    expect((await POST(req({ action: "allow" }, { [RESPOND_HEADER]: signRespondToken(qKey, "q1") }))).status).toBe(410);
    expect(qAnswers).toEqual([]);
    expect(answers).toEqual([]);

    /* a bad action doesn't spend the token */
    const token = signRespondToken(key, "r1");
    expect((await POST(req({ action: "always" }, { [RESPOND_HEADER]: token }))).status).toBe(400);
    expect((await POST(req({ action: "deny" }, { [RESPOND_HEADER]: token }))).status).toBe(200);
    expect(answers).toEqual([{ allow: false, always: false }]);
    stopTurn(key);
    stopTurn(qKey);
  });

  it("ignores the session cookie: no token, no answer", async () => {
    const { POST } = await import("@/app/api/push/respond/route");
    const key = "codex:pushcookie";
    const answers = asking(key, { kind: "permission", requestId: "r1", toolName: "Bash", title: "Run ls", description: null, input: {}, canAlwaysAllow: false });
    const res = await POST(req({ action: "allow" }, { cookie: `cui_session=${await signSession()}` }));
    expect(res.status).toBe(401);
    expect(answers).toEqual([]);
    stopTurn(key);
  });
});
