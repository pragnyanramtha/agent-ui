import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import nextConfig from "@/next.config";

describe("security headers", () => {
  it("every app response gets framing, sniffing, referrer and opener policies; HSTS only over HTTPS", async () => {
    const rules = await nextConfig.headers!();
    const app = rules.find((r) => r.source === "/((?!api/files/raw).*)")!;
    const values = Object.fromEntries(app.headers.map((h) => [h.key, h.value]));
    expect(values).toMatchObject({
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Opener-Policy": "same-origin",
    });
    const hsts = rules.find((r) => r.headers.some((h) => h.key === "Strict-Transport-Security"))!;
    expect(hsts.has).toEqual([{ type: "header", key: "x-forwarded-proto", value: "https" }]);
  });
});

describe("login redirect", () => {
  const go = async (headers: Record<string, string>) => {
    const { middleware } = await import("@/middleware");
    const res = await middleware(new NextRequest("http://127.0.0.1:3311/session/abc", { headers }));
    expect(res.status).toBe(307);
    return res.headers.get("location");
  };

  it("goes to /login on the Host the browser used, whatever x-forwarded-host says", async () => {
    expect(await go({ host: "agent.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" })).toBe("https://agent.example/login");
    expect(await go({ host: "agent.example", "x-forwarded-proto": "javascript" })).toBe("http://agent.example/login");
  });

  it("falls back to the request URL when the Host doesn't parse", async () => {
    expect(new URL((await go({ host: "a b" }))!).pathname).toBe("/login");
  });
});
