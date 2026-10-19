import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentu-cplimits-"));
const repo = path.join(tmp, "repo");
let g: typeof import("@/lib/server/git");

const sh = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const write = (p: string, s: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true });
  fs.writeFileSync(path.join(repo, p), s);
};
const read = (p: string) => fs.readFileSync(path.join(repo, p));
const exists = (p: string) => fs.existsSync(path.join(repo, p));
const MB = 1024 * 1024;
/* random bytes, so the size in the object store isn't hidden by compression */
const big = (mb = 30) => crypto.randomBytes(mb * MB);
const files = (commit: string) => sh(["ls-tree", "-r", "--name-only", commit]).split("\n").filter(Boolean);
const indexHash = () => crypto.createHash("sha1").update(fs.readFileSync(path.join(repo, ".git", "index"))).digest("hex");
const objectsKB = () => {
  const out = sh(["count-objects", "-v"]);
  return Number(/^size: (\d+)/m.exec(out)?.[1]) + Number(/^size-pack: (\d+)/m.exec(out)?.[1]);
};
const clean = () => {
  sh(["checkout", "-q", "--", "."]);
  sh(["clean", "-qfdx", "-e", ".gitignore"]);
};

beforeAll(async () => {
  g = await import("@/lib/server/git");
  fs.mkdirSync(repo);
  sh(["init", "-q", "-b", "main"]);
  write(".gitignore", "ignored/\n");
  write("a.txt", "one\n");
  sh(["add", "-A"]);
  sh(["commit", "-qm", "init"]);
}, 60_000);
afterEach(() => {
  delete process.env.CHECKPOINT_MAX_TOTAL_MB;
  delete process.env.CHECKPOINT_MAX_FILE_MB;
  delete process.env.CHECKPOINT_MAX_AGE_DAYS;
  delete process.env.GIT_COMMITTER_DATE;
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("checkpoint size limits", () => {
  it("leave a large untracked file out, keep small ones, and say so", async () => {
    write("data/huge.bin", big());
    write("data/small.txt", "small\n");
    write("odd name [1].txt", "x\n");
    write("a.txt", "two\n");
    const head = sh(["rev-parse", "HEAD"]);
    /* status refreshes the index's stat cache, so it goes first */
    const status = sh(["status", "--porcelain"]);
    const index = indexHash();
    const before = objectsKB();
    const cp = await g.checkpoint(repo, "s1", "with a big file");
    expect(files(cp!.commit)).toEqual([".gitignore", "a.txt", "data/small.txt", "odd name [1].txt"]);
    expect(cp!.skipped).toEqual({ count: 1, bytes: 30 * MB, paths: ["data/huge.bin"] });
    expect(objectsKB() - before).toBeLessThan(1024);
    /* the real index, HEAD and branch are never touched */
    expect(indexHash()).toBe(index);
    expect(sh(["rev-parse", "HEAD"])).toBe(head);
    expect(sh(["status", "--porcelain"])).toBe(status);
    expect(sh(["branch", "--list"]).trim()).toBe("* main");
    expect(sh(["for-each-ref", "--format=%(refname)", "refs/heads/"]).trim()).toBe("refs/heads/main");
    /* the note is kept with the checkpoint */
    expect((await g.listCheckpoints(repo, "s1"))[0]).toMatchObject({ id: cp!.id, label: "with a big file", skipped: { count: 1, paths: ["data/huge.bin"] } });
  });

  it("follow CHECKPOINT_MAX_FILE_MB", async () => {
    process.env.CHECKPOINT_MAX_FILE_MB = "40";
    const cp = await g.checkpoint(repo, "s-file-mb", "higher limit");
    expect(files(cp!.commit)).toContain("data/huge.bin");
    expect(cp!.skipped).toBeUndefined();
    clean();
  });

  it("skip the whole checkpoint when the new files add up to too much", async () => {
    process.env.CHECKPOINT_MAX_TOTAL_MB = "1";
    write("many/one.bin", big(1));
    write("many/two.bin", big(1));
    const refs = sh(["for-each-ref", "refs/agent-u/"]);
    const err = await g.checkpoint(repo, "s-total", "too much").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(g.CheckpointSkipped);
    expect((err as Error).message).toMatch(/^Checkpoint skipped: 2 MB of new files that git doesn't ignore\./);
    expect(sh(["for-each-ref", "refs/agent-u/"])).toBe(refs);
    expect(g.checkpointSkip(fs.realpathSync(repo), "s-total")?.reason).toMatch(/2 MB/);
    /* and a rewind refuses, since it couldn't save the state first */
    delete process.env.CHECKPOINT_MAX_TOTAL_MB;
    const cp = await g.checkpoint(repo, "s-total", "fine now");
    expect(g.checkpointSkip(fs.realpathSync(repo), "s-total")).toBeNull();
    process.env.CHECKPOINT_MAX_TOTAL_MB = "1";
    write("many/three.bin", big(1));
    await expect(g.rewind(repo, "s-total", cp!.id)).rejects.toThrow(/^Can't rewind/);
    expect(exists("many/three.bin")).toBe(true);
    clean();
  });

  it("skip the whole checkpoint when there are too many new files", async () => {
    const dir = path.join(repo, "lots");
    fs.mkdirSync(dir);
    for (let i = 0; i <= 20_000; i++) fs.writeFileSync(path.join(dir, `${i}.txt`), "");
    await expect(g.checkpoint(repo, "s-count", "too many")).rejects.toThrow(/more than 20,000 new files/);
    expect(await g.listCheckpoints(repo, "s-count")).toEqual([]);
    clean();
  }, 60_000);
});

describe("rewinding around files left out", () => {
  it("never removes a large file made since the checkpoint", async () => {
    const cp = await g.checkpoint(repo, "r1", "before");
    expect(cp!.skipped).toBeUndefined();
    const data = big();
    write("video.mp4", data);
    write("notes.txt", "new\n");
    const res = await g.rewind(repo, "r1", cp!.id);
    expect(res).toMatchObject({ removed: 1, kept: 0 });
    expect(exists("notes.txt")).toBe(false);
    expect(read("video.mp4").equals(data)).toBe(true);
    clean();
  });

  it("leaves a file that grew too large to save as it is", async () => {
    write("grows.bin", "small\n");
    const cp = await g.checkpoint(repo, "r2", "small then");
    expect(files(cp!.commit)).toContain("grows.bin");
    const data = big();
    write("grows.bin", data);
    write("a.txt", "changed\n");
    const res = await g.rewind(repo, "r2", cp!.id);
    expect(res).toMatchObject({ changed: 1, kept: 1 });
    expect(read("a.txt").toString()).toBe("one\n");
    expect(read("grows.bin").equals(data)).toBe(true);
    clean();
  });

  it("doesn't remove a file the checkpoint itself left out", async () => {
    write("shrinks.bin", big());
    const cp = await g.checkpoint(repo, "r3", "large then");
    expect(cp!.skipped?.paths).toEqual(["shrinks.bin"]);
    write("shrinks.bin", "small now\n");
    write("other.txt", "made since\n");
    const res = await g.rewind(repo, "r3", cp!.id);
    expect(res).toMatchObject({ removed: 1, kept: 1 });
    expect(exists("other.txt")).toBe(false);
    expect(read("shrinks.bin").toString()).toBe("small now\n");
    /* the undo checkpoint has the small version, so it can come back */
    expect(files((await g.listCheckpoints(repo, "r3")).find((c) => c.id === res.undo)!.commit)).toContain("shrinks.bin");
    clean();
  });
});

describe("pruning old checkpoints", () => {
  it("deletes checkpoints older than CHECKPOINT_MAX_AGE_DAYS across sessions", async () => {
    const day = 86_400;
    const now = Math.floor(Date.now() / 1000);
    write("a.txt", "fresh\n");
    const fresh = await g.checkpoint(repo, "p-fresh", "today");
    process.env.GIT_COMMITTER_DATE = `@${now - 40 * day} +0000`;
    write("a.txt", "old\n");
    await g.checkpoint(repo, "p-old", "forty days ago");
    process.env.GIT_COMMITTER_DATE = `@${now - 10 * day} +0000`;
    write("a.txt", "older than five\n");
    await g.checkpoint(repo, "p-mid", "ten days ago");
    delete process.env.GIT_COMMITTER_DATE;
    /* pruning ran at most once this hour, so creating them didn't remove them */
    expect(await g.listCheckpoints(repo, "p-old")).toHaveLength(1);

    expect(await g.pruneCheckpoints(repo)).toBe(1);
    expect(await g.listCheckpoints(repo, "p-old")).toEqual([]);
    expect(await g.listCheckpoints(repo, "p-mid")).toHaveLength(1);
    expect((await g.listCheckpoints(repo, "p-fresh"))[0].id).toBe(fresh!.id);

    process.env.CHECKPOINT_MAX_AGE_DAYS = "5";
    expect(await g.pruneCheckpoints(repo)).toBe(1);
    expect(await g.listCheckpoints(repo, "p-mid")).toEqual([]);
    expect(await g.listCheckpoints(repo, "p-fresh")).toHaveLength(1);
    /* only checkpoint refs go */
    expect(sh(["rev-parse", "--verify", "main"]).trim()).toMatch(/^[0-9a-f]{40}$/);
  });
});
