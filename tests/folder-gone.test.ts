import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { folderGone } from "@/lib/server/http";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "folder-gone-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("folderGone", () => {
  it("is false for a folder that's there, and for nothing to check", async () => {
    expect(await folderGone(root)).toBe(false);
    expect(await folderGone("")).toBe(false);
    expect(await folderGone(null)).toBe(false);
    expect(await folderGone("relative/path")).toBe(false);
  });

  it("is true once the folder is deleted, or a file took its place", async () => {
    const dir = path.join(root, "project");
    fs.mkdirSync(dir);
    expect(await folderGone(dir)).toBe(false);
    fs.rmSync(dir, { recursive: true });
    expect(await folderGone(dir)).toBe(true);
    fs.writeFileSync(dir, "");
    expect(await folderGone(dir)).toBe(true);
    expect(await folderGone(path.join(dir, "sub"))).toBe(true);
  });
});
