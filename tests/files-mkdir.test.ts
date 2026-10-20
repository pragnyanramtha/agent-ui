import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/files/route";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "agentu-mkdir-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const post = async (body: unknown) => {
  const res = await POST(new NextRequest("http://x/api/files", { method: "POST", body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as { path?: string; error?: string } };
};

describe("POST /api/files mkdir", () => {
  it("creates a folder inside the one you are browsing", async () => {
    const parent = tmp();
    const res = await post({ action: "mkdir", path: parent, name: "fresh-agent" });
    expect(res.status).toBe(200);
    expect(res.body.path).toBe(path.join(parent, "fresh-agent"));
    expect(fs.statSync(res.body.path!).isDirectory()).toBe(true);
  });

  it("refuses a name with a slash, and a folder that already exists", async () => {
    const parent = tmp();
    expect((await post({ action: "mkdir", path: parent, name: "a/b" })).status).toBe(400);
    expect((await post({ action: "mkdir", path: parent, name: "taken" })).status).toBe(200);
    const again = await post({ action: "mkdir", path: parent, name: "taken" });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe(`${path.join(parent, "taken")} already exists.`);
  });
});
