import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { allowedHosts, hostAllowed } from "@/lib/hosts";

describe("Host allowlist", () => {
  it("accepts any Host when nothing is configured", () => {
    expect(allowedHosts({})).toBeNull();
    expect(hostAllowed("evil.example", null)).toBe(true);
  });

  it("takes ALLOWED_HOSTS and PUBLIC_HOSTNAME, loosely written", () => {
    expect(allowedHosts({ ALLOWED_HOSTS: " A.example , b.example:8443,https://c.example/x,", PUBLIC_HOSTNAME: "agent.example." })).toEqual([
      ["a.example", ""],
      ["b.example", "8443"],
      ["c.example", ""],
      ["agent.example", ""],
    ]);
  });

  it("always lets loopback names in, with any port", () => {
    const allow = allowedHosts({ PUBLIC_HOSTNAME: "agent.example" });
    for (const h of ["127.0.0.1", "127.0.0.1:3311", "localhost:9", "LOCALHOST", "[::1]:3312"]) expect(hostAllowed(h, allow)).toBe(true);
  });

  it("matches names case-insensitively, and ports only when an entry pins one", () => {
    const allow = allowedHosts({ ALLOWED_HOSTS: "b.example:8443", PUBLIC_HOSTNAME: "agent.example" });
    expect(hostAllowed("Agent.Example", allow)).toBe(true);
    expect(hostAllowed("agent.example:443", allow)).toBe(true);
    expect(hostAllowed("b.example:8443", allow)).toBe(true);
    expect(hostAllowed("b.example", allow)).toBe(false);
    expect(hostAllowed("b.example:9443", allow)).toBe(false);
  });

  it("refuses other names, lookalikes and garbage", () => {
    const allow = allowedHosts({ PUBLIC_HOSTNAME: "agent.example" });
    for (const h of ["evil.example", "agent.example.evil.example", "evilagent.example", "agent.example@evil", "", null, undefined, "a b", "127.0.0.1.nip.io", "[::2]"]) {
      expect(hostAllowed(h, allow)).toBe(false);
    }
  });
});

describe("middleware Host check", () => {
  afterEach(() => {
    delete process.env.ALLOWED_HOSTS;
    delete process.env.PUBLIC_HOSTNAME;
    vi.restoreAllMocks();
  });
  const call = async (host: string, path = "/login") => {
    const { middleware } = await import("@/middleware");
    return middleware(new NextRequest(`http://127.0.0.1:3311${path}`, { headers: { host } }));
  };

  it("answers 421 for a Host that isn't ours once a list is set", async () => {
    process.env.PUBLIC_HOSTNAME = "agent.example";
    expect((await call("evil.example")).status).toBe(421);
    expect((await call("evil.example", "/api/sessions")).status).toBe(421);
    expect((await call("agent.example")).status).toBe(200);
    expect((await call("127.0.0.1:3311")).status).toBe(200);
  });

  it("keeps accepting any Host when nothing is set, and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await call("evil.example")).status).toBe(200);
    expect((await call("other.example")).status).toBe(200);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("ALLOWED_HOSTS"))).toHaveLength(1);
  });
});
