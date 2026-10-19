import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentu-snapshot-"));
const repo = path.join(tmp, "repo");
let g: typeof import("@/lib/server/git");

const sh = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

beforeAll(async () => {
  g = await import("@/lib/server/git");
  fs.mkdirSync(repo);
  sh(["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  sh(["add", "-A"]);
  sh(["commit", "-qm", "init"]);
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("snapshots with a nested repository", () => {
  it("leave out an untracked nested repo without commits instead of failing", async () => {
    sh(["init", "-q", "nested"]);
    fs.writeFileSync(path.join(repo, "nested", "inner.txt"), "inner\n");
    fs.writeFileSync(path.join(repo, "b.txt"), "b\n");
    const status = sh(["status", "--porcelain"]);
    const cp = await g.checkpoint(repo, "s1", "before");
    expect(cp).not.toBeNull();
    expect(sh(["ls-tree", "--name-only", cp!.tree]).split("\n").filter(Boolean)).toEqual(["a.txt", "b.txt"]);
    const d = await g.diff(repo, "s1", { scope: "uncommitted" });
    expect(d.files.map((f) => [f.path, f.status])).toEqual([["b.txt", "added"]]);
    expect(sh(["status", "--porcelain"])).toBe(status);
  });
});
