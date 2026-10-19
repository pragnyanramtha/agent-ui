import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { authFile, newSessionEpoch, sessionEpoch, signSession, verifySession } from "@/lib/auth";

const keys = ["AGENT_U_HOME", "UI_SECRET", "UI_PASSWORD", "UI_PASSWORD_HASH"] as const;
let saved: Record<string, string | undefined> = {};
let dir = "";
beforeEach(() => {
  saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentu-auth-"));
  Object.assign(process.env, { AGENT_U_HOME: path.join(dir, "cfg"), UI_SECRET: "k".repeat(40), UI_PASSWORD: "first-password" });
  delete process.env.UI_PASSWORD_HASH;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("session epoch", () => {
  it("starts empty, and a new one ends every earlier session", async () => {
    expect(sessionEpoch()).toBe("");
    const before = await signSession();
    expect(await verifySession(before)).toBe(true);
    const epoch = newSessionEpoch();
    expect(epoch).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(sessionEpoch()).toBe(epoch);
    expect(fs.statSync(authFile()).mode & 0o777).toBe(0o600);
    expect(await verifySession(before)).toBe(false);
    expect(await verifySession(await signSession())).toBe(true);
  });

  it("an unreadable auth.json doesn't bring back sessions signed before it", async () => {
    const before = await signSession();
    fs.mkdirSync(path.dirname(authFile()), { recursive: true });
    fs.writeFileSync(authFile(), "{not json");
    expect(sessionEpoch()).toBe("invalid");
    expect(await verifySession(before)).toBe(false);
  });

  it("a new password ends every session", async () => {
    const before = await signSession();
    process.env.UI_PASSWORD = "second-password";
    expect(await verifySession(before)).toBe(false);
    process.env.UI_PASSWORD = "first-password";
    expect(await verifySession(before)).toBe(true);
    process.env.UI_PASSWORD_HASH = "scrypt:a:b";
    expect(await verifySession(before)).toBe(false);
  });
});

describe("POST /api/auth/logout", () => {
  const logout = async (body: unknown, cookie?: string) => {
    const { POST } = await import("@/app/api/auth/logout/route");
    return POST(new NextRequest("http://127.0.0.1:3311/api/auth/logout", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) } }));
  };

  it("signs out this browser only, unless asked to sign out everywhere", async () => {
    const other = await signSession();
    const res = await logout({});
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/cui_session=;/);
    expect(await verifySession(other)).toBe(true);

    expect((await logout({ everywhere: true })).status).toBe(200);
    expect(await verifySession(other)).toBe(false);
  });

  it("can't be called signed out (the middleware asks for a session first)", async () => {
    const { middleware } = await import("@/middleware");
    const req = (cookie?: string) =>
      new NextRequest("http://127.0.0.1:3311/api/auth/logout", { method: "POST", body: "{}", headers: { host: "127.0.0.1:3311", origin: "http://127.0.0.1:3311", ...(cookie ? { cookie } : {}) } });
    expect((await middleware(req())).status).toBe(401);
    expect((await middleware(req(`cui_session=${await signSession()}`))).headers.get("x-middleware-next")).toBe("1");
  });
});
