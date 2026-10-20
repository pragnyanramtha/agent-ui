import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/guard", () => ({ guard: async () => null }));
const { POST } = await import("@/app/api/files/upload/route");

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentu-upload-")));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const chunk = (name: string, offset: number, total: number, body: Buffer, extra = "") =>
  POST(new NextRequest(`http://x/api/files/upload?dir=${encodeURIComponent(dir)}&name=${name}&offset=${offset}&total=${total}&key=k1${extra}`, { method: "POST", body: new Uint8Array(body) }));

describe("resumable upload", () => {
  const data = Buffer.from("0123456789abcdefghij");

  it("assembles chunks in order and moves the file into place", async () => {
    expect(await (await chunk("a.txt", 0, 20, data.subarray(0, 8))).json()).toEqual({ done: false, received: 8 });
    expect(await (await chunk("a.txt", 8, 20, data.subarray(8))).json()).toMatchObject({ done: true, received: 20 });
    expect(fs.readFileSync(path.join(dir, "a.txt"))).toEqual(data);
    expect(fs.readdirSync(dir).filter((f) => f.includes("agentu-upload"))).toEqual([]);
  });

  it("a last chunk sent twice at the same time doesn't replace the file with that chunk", async () => {
    await chunk("b.txt", 0, 20, data.subarray(0, 12));
    const [x, y] = await Promise.all([chunk("b.txt", 12, 20, data.subarray(12)), chunk("b.txt", 12, 20, data.subarray(12))]);
    expect((await x.json()).done).toBe(true);
    expect((await y.json()).done).toBe(true);
    expect(fs.readFileSync(path.join(dir, "b.txt"))).toEqual(data);
  });

  it("a middle chunk sent twice is refused with the size received so far", async () => {
    await chunk("c.txt", 0, 20, data.subarray(0, 5));
    const [x, y] = await Promise.all([chunk("c.txt", 5, 20, data.subarray(5, 10)), chunk("c.txt", 5, 20, data.subarray(5, 10))]);
    const statuses = [x.status, y.status].sort();
    expect(statuses).toEqual([200, 409]);
    const refused = x.status === 409 ? await x.json() : await y.json();
    expect(refused).toMatchObject({ code: "offset", received: 10 });
    await chunk("c.txt", 10, 20, data.subarray(10));
    expect(fs.readFileSync(path.join(dir, "c.txt"))).toEqual(data);
  });

  it("won't overwrite an existing file unless asked to", async () => {
    fs.writeFileSync(path.join(dir, "d.txt"), "old");
    expect((await chunk("d.txt", 0, 3, Buffer.from("new"))).status).toBe(409);
    expect((await chunk("d.txt", 0, 3, Buffer.from("new"), "&replace=1")).status).toBe(200);
    expect(fs.readFileSync(path.join(dir, "d.txt"), "utf8")).toBe("new");
  });

  it("refuses a chunk declared too large before reading any of it", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({ pull: (c) => void (pulled++, c.enqueue(new Uint8Array(1024))) });
    const req = new NextRequest(`http://x/api/files/upload?dir=${encodeURIComponent(dir)}&name=big.bin&offset=0&total=${20 << 20}&key=k2`, {
      method: "POST",
      body,
      headers: { "content-length": String(10 << 20) },
      duplex: "half",
    } as unknown as ConstructorParameters<typeof NextRequest>[1]);
    expect((await POST(req)).status).toBe(413);
    expect(pulled).toBeLessThanOrEqual(1);
    expect(fs.readdirSync(dir).some((f) => f.includes("big.bin"))).toBe(false);
  });

  it("stops reading a chunk with no length once it passes the limit", async () => {
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull: (c) => {
        sent += 1 << 20;
        if (sent > 64 << 20) return c.close();
        c.enqueue(new Uint8Array(1 << 20));
      },
    });
    const req = new NextRequest(`http://x/api/files/upload?dir=${encodeURIComponent(dir)}&name=big2.bin&offset=0&total=${80 << 20}&key=k3`, { method: "POST", body, duplex: "half" } as unknown as ConstructorParameters<typeof NextRequest>[1]);
    expect((await POST(req)).status).toBe(413);
    expect(sent).toBeLessThan(16 << 20);
  });

  it("refuses bad offsets, oversize chunks and path tricks in the name", async () => {
    expect((await chunk("e.txt", 5, 3, Buffer.from("x"))).status).toBe(400);
    expect((await chunk("e.txt", 0, 2, Buffer.from("xyz"))).status).toBe(400);
    expect((await chunk("..%2F..%2Fescape.txt", 0, 1, Buffer.from("x"))).status).toBeGreaterThanOrEqual(400);
    expect(fs.existsSync(path.join(dir, "..", "..", "escape.txt"))).toBe(false);
  });
});
