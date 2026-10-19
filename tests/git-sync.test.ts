import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentu-gitsync-"));
const remote = path.join(tmp, "remote.git");
const repo = path.join(tmp, "repo");
const other = path.join(tmp, "other");
let g: typeof import("@/lib/server/git");

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const sh = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENV });
const write = (dir: string, p: string, s: string) => fs.writeFileSync(path.join(dir, p), s);
const commitIn = (dir: string, file: string, text: string) => {
  write(dir, file, text);
  sh(["add", "-A"], dir);
  sh(["commit", "-qm", `edit ${file}`], dir);
};

beforeAll(async () => {
  g = await import("@/lib/server/git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["clone", "-q", remote, repo], { env: ENV, stdio: "pipe" });
  sh(["checkout", "-q", "-b", "main"]);
  commitIn(repo, "a.txt", "one\n");
  sh(["push", "-q", "-u", "origin", "main"]);
  execFileSync("git", ["clone", "-q", remote, other], { env: ENV });
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("status", () => {
  it("names the default branch", async () => {
    expect(await g.status(repo)).toMatchObject({ branch: "main", defaultBranch: "main", upstream: "origin/main" });
  });
});

describe("pull", () => {
  it("fast-forwards to the upstream", async () => {
    commitIn(other, "b.txt", "bee\n");
    sh(["push", "-q"], other);
    sh(["fetch", "-q"]);
    expect((await g.status(repo))?.behind).toBe(1);
    expect(await g.pull(repo)).toBe("main");
    expect(fs.readFileSync(path.join(repo, "b.txt"), "utf8")).toBe("bee\n");
    expect(await g.status(repo)).toMatchObject({ ahead: 0, behind: 0 });
  });

  it("refuses a diverged branch without touching it", async () => {
    commitIn(other, "c.txt", "sea\n");
    sh(["push", "-q"], other);
    commitIn(repo, "d.txt", "dee\n");
    sh(["fetch", "-q"]);
    const head = sh(["rev-parse", "HEAD"]);
    await expect(g.pull(repo)).rejects.toThrow(/both moved on/);
    expect(sh(["rev-parse", "HEAD"])).toBe(head);
  });

  it("needs an upstream", async () => {
    sh(["checkout", "-q", "-b", "local-only"]);
    await expect(g.pull(repo)).rejects.toThrow(/doesn't track/);
    sh(["checkout", "-q", "main"]);
  });
});
