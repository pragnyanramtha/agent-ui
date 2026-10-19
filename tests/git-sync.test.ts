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

describe("background fetch", () => {
  let n = 0;
  const fresh = () => {
    const dir = path.join(tmp, `fetch-${n++}`);
    execFileSync("git", ["clone", "-q", remote, dir], { env: ENV, stdio: "pipe" });
    return dir;
  };

  it("brings in new remote commits, then waits out the interval", async () => {
    const dir = fresh();
    commitIn(other, "e.txt", "e\n");
    sh(["push", "-q"], other);
    const fetchHead = () => fs.statSync(path.join(dir, ".git", "FETCH_HEAD"), { throwIfNoEntry: false })?.mtimeMs;
    await g.autoFetch(dir);
    const st = await g.status(dir);
    expect(st?.behind).toBe(1);
    expect(st?.fetchError).toBeNull();
    expect(st?.fetchedAt).toBeGreaterThan(0);
    const first = fetchHead();
    commitIn(other, "f.txt", "f\n");
    sh(["push", "-q"], other);
    await g.autoFetch(dir);
    expect(fetchHead()).toBe(first);
    expect((await g.status(dir))?.behind).toBe(1);
    /* past the interval it fetches again */
    await g.autoFetch(dir, { intervalMs: 1 });
    expect((await g.status(dir))?.behind).toBe(2);
  });

  it("runs one fetch at a time per repo", async () => {
    const dir = fresh();
    const log = path.join(tmp, "uploads.log");
    const pack = path.join(tmp, "counting-upload-pack");
    fs.writeFileSync(pack, `#!/bin/sh\necho run >> '${log}'\nsleep 0.3\nexec git-upload-pack "$@"\n`, { mode: 0o755 });
    sh(["config", "remote.origin.uploadpack", pack], dir);
    const a = g.autoFetch(dir, { intervalMs: 1 });
    await new Promise((r) => setTimeout(r, 100));
    const b = g.autoFetch(dir, { intervalMs: 1 });
    await Promise.all([a, b, g.autoFetch(dir, { intervalMs: 1 })]);
    expect(fs.readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
    expect((await g.status(dir))?.fetchError).toBeNull();
  });

  it("keeps failures quiet but reports them in status", async () => {
    const dir = fresh();
    sh(["remote", "set-url", "origin", path.join(tmp, "gone.git")], dir);
    await expect(g.autoFetch(dir)).resolves.toBeUndefined();
    const st = await g.status(dir);
    expect(st?.fetchError).toMatch(/gone\.git|repository/);
    expect(st?.behind).toBe(0);
  });

  it("never fetches without a remote, or when turned off", async () => {
    const dir = path.join(tmp, "lonely");
    fs.mkdirSync(dir);
    sh(["init", "-q"], dir);
    await g.autoFetch(dir);
    expect((await g.status(dir))?.fetchedAt).toBeNull();
    const off = fresh();
    await g.autoFetch(off, { intervalMs: 0 });
    expect((await g.status(off))?.fetchedAt).toBeNull();
  });

  it("gives up after the timeout", async () => {
    const dir = fresh();
    const bin = path.join(tmp, "slow-bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "git-upload-pack"), "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
    sh(["config", "remote.origin.uploadpack", path.join(bin, "git-upload-pack")], dir);
    const t = Date.now();
    await g.autoFetch(dir, { timeoutMs: 400 });
    expect(Date.now() - t).toBeLessThan(4000);
    expect((await g.status(dir))?.fetchError).toMatch(/timed out/);
  });
});
