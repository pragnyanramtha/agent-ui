import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonWithEtag } from "@/lib/server/etag";
import { getListing } from "@/lib/client/useSessions";

const req = (inm?: string) => new Request("http://127.0.0.1:3311/api/sessions", { headers: inm ? { "If-None-Match": inm } : {} });

describe("jsonWithEtag", () => {
  it("answers with the JSON and a tag for it", async () => {
    const res = jsonWithEtag(req(), { a: 1 });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(await res.json()).toEqual({ a: 1 });
    expect(res.headers.get("etag")).toMatch(/^"[\w-]+"$/);
  });

  it("gives an empty 304 when the client has the same body", async () => {
    const tag = jsonWithEtag(req(), { a: 1 }).headers.get("etag")!;
    for (const inm of [tag, `W/${tag}`, `"other", ${tag}`, "*"]) {
      const res = jsonWithEtag(req(inm), { a: 1 });
      expect(res.status).toBe(304);
      expect(res.headers.get("etag")).toBe(tag);
      expect(await res.text()).toBe("");
    }
  });

  it("sends the body again once it changed", () => {
    const tag = jsonWithEtag(req(), { a: 1 }).headers.get("etag")!;
    const res = jsonWithEtag(req(tag), { a: 2 });
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).not.toBe(tag);
  });
});

describe("getListing", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the last tag and reads a 304 as unchanged", async () => {
    const listing = { sessions: [], projects: [], more: false };
    const seen: (string | null)[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const r = new Request("http://x/", init);
      seen.push(r.headers.get("if-none-match"));
      return jsonWithEtag(r, listing);
    });
    const etag = { current: null as string | null };
    expect(await getListing("/api/sessions", etag)).toEqual(listing);
    expect(etag.current).toBeTruthy();
    expect(await getListing("/api/sessions", etag)).toBeNull();
    expect(seen).toEqual([null, etag.current]);
  });

  it("throws the server's reason", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ error: "Nope" }, { status: 500 }));
    await expect(getListing("/api/sessions", { current: null })).rejects.toThrow("Nope");
  });
});
