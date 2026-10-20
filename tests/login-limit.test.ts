import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { clientKey, GLOBAL_MAX_FAILURES, GLOBAL_WINDOW_MS, ipBucket, LoginLimiter, MAX_ATTEMPTS, SHARED, WINDOW_MS } from "@/lib/server/login-limit";

describe("login client key", () => {
  it("ignores client-supplied address headers unless the proxy is trusted", () => {
    const h = new Headers({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.1" });
    expect(clientKey(h, false)).toBe(SHARED);
    expect(clientKey(h, true)).toBe("203.0.113.9");
    expect(clientKey(new Headers({ "x-forwarded-for": "198.51.100.1" }), true)).toBe(SHARED);
  });

  it("buckets IPv6 by /64 and unwraps IPv4-mapped addresses", () => {
    expect(ipBucket("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(ipBucket("2001:0db8:0001:0002::1")).toBe("2001:db8:1:2::/64");
    expect(ipBucket("2001:DB8:1:2::ffff")).toBe("2001:db8:1:2::/64");
    expect(ipBucket("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipBucket("::1")).toBe("0:0:0:0::/64");
    expect(ipBucket("::ffff:192.0.2.7")).toBe("192.0.2.7");
    expect(ipBucket("192.0.2.7")).toBe("192.0.2.7");
  });

  it("puts garbage in the shared bucket", () => {
    for (const bad of ["", "not-an-ip", "1:2:3", "1::2::3", "12345::1", "1:2:3:4:5:6:7:8:9"]) expect(ipBucket(bad)).toBe(SHARED);
  });
});

describe("LoginLimiter", () => {
  it("allows a few attempts per client, then says how long to wait", () => {
    const l = new LoginLimiter();
    const t = 1_000_000;
    for (let i = 0; i < MAX_ATTEMPTS; i++) expect(l.begin("a", t + i).ok).toBe(true);
    const no = l.begin("a", t + 100);
    expect(no).toEqual({ ok: false, retryAfter: Math.ceil((WINDOW_MS - 100) / 1000) });
    expect(l.begin("b", t + 100).ok).toBe(true);
    expect(l.begin("a", t + WINDOW_MS + 1).ok).toBe(true);
  });

  it("a success clears that client's count", () => {
    const l = new LoginLimiter();
    for (let i = 0; i < MAX_ATTEMPTS; i++) l.begin("a", i);
    l.succeeded("a");
    expect(l.begin("a", 10).ok).toBe(true);
  });

  it("stops everyone after too many failures across all clients", () => {
    const l = new LoginLimiter();
    const t = 5_000_000;
    for (let i = 0; i < GLOBAL_MAX_FAILURES; i++) {
      expect(l.begin(`client-${i}`, t + i).ok).toBe(true);
      l.failed(t + i);
    }
    const no = l.begin("fresh", t + 1000);
    expect(no.ok).toBe(false);
    expect(no.ok === false && no.retryAfter).toBe(Math.ceil((GLOBAL_WINDOW_MS - 1000) / 1000));
    expect(l.begin("fresh", t + GLOBAL_WINDOW_MS + GLOBAL_MAX_FAILURES).ok).toBe(true);
  });
});

describe("POST /api/auth/login", () => {
  beforeEach(() => {
    process.env.UI_PASSWORD = "right-password";
    process.env.UI_SECRET = "s".repeat(40);
    delete process.env.UI_PASSWORD_HASH;
    delete process.env.TRUST_PROXY_HEADERS;
    delete (globalThis as { __agentuLoginLimit?: unknown }).__agentuLoginLimit;
  });
  const login = async (password: string, ip: string) => {
    const { POST } = await import("@/app/api/auth/login/route");
    return POST(new NextRequest("http://127.0.0.1:3311/api/auth/login", { method: "POST", body: JSON.stringify({ password }), headers: { "cf-connecting-ip": ip, "content-type": "application/json" } }));
  };

  it("a rotating cf-connecting-ip doesn't reset the limit when the proxy isn't trusted", async () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) expect((await login("wrong", `198.51.100.${i}`)).status).toBe(401);
    const res = await login("wrong", "198.51.100.200");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("with a trusted proxy each address has its own bucket, and the right password still signs in", async () => {
    process.env.TRUST_PROXY_HEADERS = "1";
    for (let i = 0; i < MAX_ATTEMPTS; i++) expect((await login("wrong", "198.51.100.1")).status).toBe(401);
    expect((await login("wrong", "198.51.100.1")).status).toBe(429);
    const ok = await login("right-password", "198.51.100.2");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toContain("cui_session=");
  });

  it("a trusted proxy's IPv6 clients in one /64 share a bucket", async () => {
    process.env.TRUST_PROXY_HEADERS = "1";
    for (let i = 0; i < MAX_ATTEMPTS; i++) expect((await login("wrong", `2001:db8:5:6::${i + 1}`)).status).toBe(401);
    expect((await login("wrong", "2001:db8:5:6:ffff::1")).status).toBe(429);
  });
});
