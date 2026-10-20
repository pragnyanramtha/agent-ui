import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { signSession } from "@/lib/auth";
import { parseShareParam, sharedText } from "@/lib/share";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentu-share-"));
const keys = ["AGENT_U_HOME", "AGENT_U_ATTACH", "UI_SECRET", "UI_PASSWORD"] as const;
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { AGENT_U_HOME: path.join(dir, "cfg"), AGENT_U_ATTACH: path.join(dir, "attach"), UI_SECRET: "s".repeat(40), UI_PASSWORD: "pw" });
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the share landing address", () => {
  it("reads a share id or the too-large note, and nothing else", () => {
    expect(parseShareParam("?s=new&share=0123456789abcdef01234567")).toEqual({ id: "0123456789abcdef01234567" });
    expect(parseShareParam("?share=big")).toEqual({ error: "big" });
    expect(parseShareParam("?s=new")).toBeNull();
    expect(parseShareParam("?share=../../etc")).toBeNull();
    expect(parseShareParam("?share=0123456789ABCDEF01234567")).toBeNull();
    expect(parseShareParam("")).toBeNull();
  });
});

describe("shared text", () => {
  it("joins title, text and link without repeating them", () => {
    expect(sharedText({ title: "A page", text: "Look at this", url: "https://x.example/a" })).toBe("A page\n\nLook at this\n\nhttps://x.example/a");
    expect(sharedText({ title: "A page", text: "Look at this https://x.example/a", url: "https://x.example/a" })).toBe("A page\n\nLook at this https://x.example/a");
    expect(sharedText({ title: "Same", text: "Same" })).toBe("Same");
    expect(sharedText({ title: "https://x.example", url: "https://x.example" })).toBe("https://x.example");
    expect(sharedText({ text: "  line one\r\nline two  " })).toBe("line one\nline two");
    expect(sharedText({})).toBe("");
    expect(sharedText({ text: "x".repeat(50) }, 10)).toHaveLength(10);
  });
});

describe("POST /share", () => {
  const base = "http://127.0.0.1:3311";
  async function post(form: FormData, headers: Record<string, string> = {}) {
    const { POST } = await import("@/app/share/route");
    /* the browser sends a Content-Length with a form; a Request built here has none until it's serialized */
    const encoded = new Response(form);
    const type = encoded.headers.get("content-type")!;
    const body = await encoded.arrayBuffer();
    return POST(
      new NextRequest(`${base}/share`, {
        method: "POST",
        body,
        headers: { host: "127.0.0.1:3311", "content-type": type, "content-length": String(body.byteLength), cookie: `cui_session=${await signSession()}`, ...headers },
      }),
    );
  }
  const landing = (res: Response) => new URL(res.headers.get("location")!);

  it("keeps the files as attachments and lands on a new session that picks the share up", async () => {
    const form = new FormData();
    form.set("title", "Bug report");
    form.set("text", "It crashes");
    form.append("files", new File(["png bytes"], "Screen Shot.png", { type: "image/png" }));
    form.append("files", new File(["png bytes 2"], "Screen Shot.png", { type: "image/png" }));
    const res = await post(form, { origin: "null" });
    expect(res.status).toBe(303);
    const to = landing(res);
    expect(to.origin).toBe(base);
    expect(to.searchParams.get("s")).toBe("new");
    const id = to.searchParams.get("share")!;
    expect(parseShareParam(to.search)).toEqual({ id });

    const { GET } = await import("@/app/api/share/route");
    const got = await GET(new NextRequest(`${base}/api/share?id=${id}`));
    expect(got.status).toBe(200);
    const shared = (await got.json()) as { text: string; files: { name: string; size: number; path: string }[] };
    expect(shared.text).toBe("Bug report\n\nIt crashes");
    expect(shared.files.map((f) => f.name)).toEqual(["Screen-Shot.png", "Screen-Shot-2.png"]);
    for (const f of shared.files) {
      expect(f.path.startsWith(path.join(dir, "attach"))).toBe(true);
      expect(fs.statSync(f.path).mode & 0o777).toBe(0o600);
    }
    expect(fs.readFileSync(shared.files[1].path, "utf8")).toBe("png bytes 2");
    /* still there for a reload of the landing page */
    expect((await GET(new NextRequest(`${base}/api/share?id=${id}`))).status).toBe(200);
  });

  it("sends the signed-out to the login page, and refuses other hosts' pages", async () => {
    const form = new FormData();
    form.set("text", "hi");
    const out = await post(form, { cookie: "" });
    expect(out.status).toBe(303);
    expect(landing(out).pathname).toBe("/login");
    expect((await post(form, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(form, { origin: base })).status).toBe(303);
  });

  it("says when a share is too large, and lands plainly on an empty one", async () => {
    const big = new FormData();
    big.set("text", "hi");
    const res = await post(big, { "content-length": String(200 * 1024 * 1024) });
    expect(landing(res).searchParams.get("share")).toBe("big");
    const empty = await post(new FormData());
    expect(landing(empty).search).toBe("?s=new");
  });

  it("only hands out shares by a well-formed id", async () => {
    const { GET } = await import("@/app/api/share/route");
    expect((await GET(new NextRequest(`${base}/api/share?id=0123456789abcdef01234567`))).status).toBe(404);
    expect((await GET(new NextRequest(`${base}/api/share?id=../x`))).status).toBe(404);
  });
});
