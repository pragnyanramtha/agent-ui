import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { childEnv } from "@/lib/server/child-env";
import { onTurn, startTurn } from "@/lib/server/agents/cli-run";
import { getProfile, saveProfiles, withProfile, type ResolvedProfile } from "@/lib/server/profiles";
import type { CliRunState } from "@/lib/server/agents/types";

const SECRETS = { UI_SECRET: "x".repeat(40), UI_PASSWORD: "hunter2-password", UI_PASSWORD_HASH: "scrypt:abc:def" };
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(Object.keys(SECRETS).map((k) => [k, process.env[k]]));
  Object.assign(process.env, SECRETS);
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("child process environment", () => {
  it("keeps the environment but drops the app's secrets, also when extra env names them", () => {
    const env = childEnv({ FOO: "1", UI_SECRET: "again" }, undefined, { BAR: "2" });
    expect(env.FOO).toBe("1");
    expect(env.BAR).toBe("2");
    expect(env.PATH).toBe(process.env.PATH);
    for (const k of Object.keys(SECRETS)) expect(env).not.toHaveProperty(k);
    expect(process.env.UI_SECRET).toBe(SECRETS.UI_SECRET);
  });

  it("agent turns don't see them, with or without a profile", async () => {
    const run = (key: string) =>
      new Promise<string>((resolve) => {
        let out = "";
        const off = onTurn(key, (s: CliRunState) => s.status !== "running" && (off(), resolve(out)));
        startTurn(key, { cmd: "sh", args: ["-c", "env"], cwd: process.cwd(), env: { FROM_SPEC: "yes" } }, (l) => (out += `${l}\n`));
      });
    const plain = await run("env:plain");
    expect(plain).toContain("FROM_SPEC=yes");
    expect(plain).not.toMatch(/^UI_(SECRET|PASSWORD|PASSWORD_HASH)=/m);

    const profile = { id: "p", label: "p", agent: "codex", binPath: null, env: { UI_PASSWORD: "leak", FROM_PROFILE: "yes" }, args: [], builtin: false } as ResolvedProfile;
    const viaProfile = await withProfile(profile, () => run("env:profile"));
    expect(viaProfile).toContain("FROM_PROFILE=yes");
    expect(viaProfile).not.toMatch(/^UI_(SECRET|PASSWORD|PASSWORD_HASH)=/m);
  });

  it("a profile can't read them through ${VAR}", () => {
    process.env.AGENTU_TEST_PROXY_KEY = "proxy-key";
    expect(saveProfiles([{ id: "leaky", label: "Leaky", agent: "codex", env: { A: "${UI_SECRET}", B: "${UI_PASSWORD}-${AGENTU_TEST_PROXY_KEY}" } }])).toEqual({ ok: true });
    expect(getProfile("leaky")?.env).toEqual({ A: "", B: "-proxy-key" });
    delete process.env.AGENTU_TEST_PROXY_KEY;
  });
});

describe("session cookie lifetime", () => {
  const sign = (expires: number) => `${expires}.${createHmac("sha256", SECRETS.UI_SECRET).update(String(expires)).digest("base64url")}`;

  it("refuses a validly signed cookie that expires further out than a session can last", async () => {
    const { SESSION_DAYS, signSession, verifySession } = await import("@/lib/auth");
    expect(await verifySession(await signSession())).toBe(true);
    expect(await verifySession(sign(Date.now() + (SESSION_DAYS + 1) * 86_400_000))).toBe(false);
    expect(await verifySession(sign(Date.now() + 100 * 365 * 86_400_000))).toBe(false);
  });
});
