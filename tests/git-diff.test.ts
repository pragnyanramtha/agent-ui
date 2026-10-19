import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseUnifiedPatch, splitRows } from "@/lib/client/diff";

describe("parseUnifiedPatch", () => {
  it("numbers lines across multiple hunks", () => {
    const [f] = parseUnifiedPatch(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "index 1111111..2222222 100644",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,3 +1,3 @@ export function x() {",
        " one",
        "-two",
        "+TWO",
        " three",
        "@@ -10,2 +10,3 @@",
        " ten",
        "+ten and a half",
        " eleven",
        "",
      ].join("\n"),
    );
    expect(f).toMatchObject({ path: "src/a.ts", status: "modified", additions: 2, deletions: 1 });
    expect(f.oldPath).toBeUndefined();
    expect(f.hunks).toHaveLength(2);
    expect(f.hunks[0].header).toBe("@@ -1,3 +1,3 @@ export function x() {");
    expect(f.hunks[0].lines).toEqual([
      { type: "ctx", oldNo: 1, newNo: 1, text: "one" },
      { type: "del", oldNo: 2, text: "two" },
      { type: "add", newNo: 2, text: "TWO" },
      { type: "ctx", oldNo: 3, newNo: 3, text: "three" },
    ]);
    expect(f.hunks[1].lines.map((l) => [l.type, l.oldNo, l.newNo])).toEqual([
      ["ctx", 10, 10],
      ["add", undefined, 11],
      ["ctx", 11, 12],
    ]);
  });

  it("reads added and deleted files, and a missing newline at the end", () => {
    const files = parseUnifiedPatch(
      [
        "diff --git a/new.txt b/new.txt",
        "new file mode 100644",
        "index 0000000..117827f",
        "--- /dev/null",
        "+++ b/new.txt",
        "@@ -0,0 +1,2 @@",
        "+hello",
        "+noeol",
        "\\ No newline at end of file",
        "diff --git a/gone.txt b/gone.txt",
        "deleted file mode 100644",
        "index 117827f..0000000",
        "--- a/gone.txt",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-bye",
        "",
      ].join("\n"),
    );
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ["new.txt", "added", 2, 0],
      ["gone.txt", "deleted", 0, 1],
    ]);
    expect(files[0].hunks[0].lines.at(-1)).toEqual({ type: "add", newNo: 2, text: "noeol", noEol: true });
    expect(files[0].hunks[0].lines[0].noEol).toBeUndefined();
    expect(files[1].hunks[0].lines).toEqual([{ type: "del", oldNo: 1, text: "bye" }]);
  });

  it("reads renames, binaries, quoted names and names with spaces", () => {
    const files = parseUnifiedPatch(
      [
        "diff --git a/old name.txt b/new name.txt",
        "similarity index 90%",
        "rename from old name.txt",
        "rename to new name.txt",
        "index 1..2 100644",
        "--- a/old name.txt\t",
        "+++ b/new name.txt\t",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "diff --git a/pure.txt b/moved/pure.txt",
        "similarity index 100%",
        "rename from pure.txt",
        "rename to moved/pure.txt",
        "diff --git a/img.png b/img.png",
        "index 3..4 100644",
        "Binary files a/img.png and b/img.png differ",
        'diff --git "a/caf\\303\\251 \\"x\\".txt" "b/caf\\303\\251 \\"x\\".txt"',
        "index 5..6 100644",
        '--- "a/caf\\303\\251 \\"x\\".txt"',
        '+++ "b/caf\\303\\251 \\"x\\".txt"',
        "@@ -1 +1 @@",
        "-1",
        "+2",
        "diff --git a/run.sh b/run.sh",
        "old mode 100644",
        "new mode 100755",
      ].join("\n"),
    );
    expect(files.map((f) => [f.path, f.oldPath, f.status])).toEqual([
      ["new name.txt", "old name.txt", "renamed"],
      ["moved/pure.txt", "pure.txt", "renamed"],
      ["img.png", undefined, "binary"],
      ['café "x".txt', undefined, "modified"],
      ["run.sh", undefined, "modified"],
    ]);
    expect(files[0]).toMatchObject({ additions: 1, deletions: 1 });
    expect(files[1].hunks).toEqual([]);
    expect(files[2].hunks).toEqual([]);
    expect(files[4].modeChange).toEqual({ from: "100644", to: "100755" });
  });

  it("doesn't mistake removed lines that look like headers for headers", () => {
    const [f] = parseUnifiedPatch(["diff --git a/x.md b/x.md", "--- a/x.md", "+++ b/x.md", "@@ -1,2 +1 @@", "--- a/y", "-+++ b/z", "+@@ -1 +1 @@"].join("\n"));
    expect(f.path).toBe("x.md");
    expect(f.hunks[0].lines.map((l) => [l.type, l.text])).toEqual([
      ["del", "-- a/y"],
      ["del", "+++ b/z"],
      ["add", "@@ -1 +1 @@"],
    ]);
  });

  it("keeps whole lines of a patch cut off mid-hunk", () => {
    const [f] = parseUnifiedPatch(["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1,5 +1,5 @@", " a", "-b"].join("\n"));
    expect(f.hunks[0].lines).toHaveLength(2);
    expect(parseUnifiedPatch("")).toEqual([]);
  });

  it("pairs removals with additions side by side", () => {
    const [f] = parseUnifiedPatch(["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1,5 +1,3 @@", " a", "-b", "-c", "+B", " d", "-e"].join("\n"));
    expect(splitRows(f.hunks[0].lines).map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ["a", "a"],
      ["b", "B"],
      ["c", null],
      ["d", "d"],
      ["e", null],
    ]);
  });
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentu-gitdiff-"));
const repo = path.join(tmp, "repo");
let g: typeof import("@/lib/server/git");

const sh = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const write = (p: string, s: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true });
  fs.writeFileSync(path.join(repo, p), s);
};
const byPath = <F extends { path: string }>(d: { files: F[] }) => Object.fromEntries(d.files.map((f) => [f.path, f]));

beforeAll(async () => {
  g = await import("@/lib/server/git");
  fs.mkdirSync(repo);
  sh(["init", "-q", "-b", "main"]);
  write(".gitignore", "secret.env\n");
  write("keep.txt", "one\ntwo\nthree\n");
  write("gone.txt", "bye\n");
  write("space.txt", "a b\n");
  sh(["add", "-A"]);
  sh(["commit", "-qm", "init"]);
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("diff", () => {
  it("shows uncommitted changes, untracked files included, without touching the index", async () => {
    write("keep.txt", "one\nTWO\nthree\n");
    write("fresh/new.txt", "hello\n");
    write("secret.env", "KEY=1\n");
    write("space.txt", "a  b\n");
    fs.rmSync(path.join(repo, "gone.txt"));
    const status = sh(["status", "--porcelain"]);
    const d = await g.diff(repo, "s1", { scope: "uncommitted" });
    expect(sh(["status", "--porcelain"])).toBe(status);
    expect(d).toMatchObject({ scope: "uncommitted", baseLabel: "HEAD", truncated: false });
    const f = byPath(d);
    expect(Object.keys(f).sort()).toEqual(["fresh/new.txt", "gone.txt", "keep.txt", "space.txt"]);
    expect(f["keep.txt"]).toMatchObject({ status: "modified", additions: 1, deletions: 1 });
    expect(f["fresh/new.txt"]).toMatchObject({ status: "added", additions: 1, deletions: 0 });
    expect(f["gone.txt"]).toMatchObject({ status: "deleted", additions: 0, deletions: 1 });
    expect(d.additions).toBe(3);
    expect(d.deletions).toBe(3);
  });

  it("leaves whitespace-only changes out when asked", async () => {
    const d = await g.diff(repo, "s1", { scope: "uncommitted", ignoreWhitespace: true });
    expect(d.files.map((f) => f.path)).not.toContain("space.txt");
    expect(d.files.map((f) => f.path)).toContain("keep.txt");
  });

  it("compares with a checkpoint of this session only", async () => {
    const cp = await g.checkpoint(repo, "s1", "before more");
    write("keep.txt", "one\nTWO\nthree\nfour\n");
    const d = await g.diff(repo, "s1", { scope: "checkpoint", checkpoint: cp!.id });
    expect(d.files.map((f) => [f.path, f.additions, f.deletions])).toEqual([["keep.txt", 1, 0]]);
    expect(d.baseLabel).toBe("before more");
    await expect(g.diff(repo, "s2", { scope: "checkpoint", checkpoint: cp!.id })).rejects.toThrow(/checkpoint/i);
    await expect(g.diff(repo, "s1", { scope: "checkpoint", checkpoint: "../../heads/main" })).rejects.toThrow(/checkpoint/i);
  });

  it("compares a branch with where it left main", async () => {
    sh(["add", "-A"]);
    sh(["commit", "-qm", "work on main"]);
    sh(["checkout", "-qb", "feature"]);
    write("feature.txt", "f\n");
    sh(["add", "-A"]);
    sh(["commit", "-qm", "feature"]);
    write("keep.txt", "zero\n");
    write("main-moved.txt", "x\n");
    sh(["stash", "-u", "-q"]);
    sh(["checkout", "-q", "main"]);
    write("later-on-main.txt", "m\n");
    sh(["add", "-A"]);
    sh(["commit", "-qm", "main moves on"]);
    sh(["checkout", "-q", "feature"]);
    sh(["stash", "pop", "-q"]);
    const d = await g.diff(repo, "s1", { scope: "branch" });
    expect(d.baseLabel).toBe("main");
    expect(d.files.map((f) => f.path).sort()).toEqual(["feature.txt", "keep.txt", "main-moved.txt"]);
  });

  it("lists files too large to show without their lines", async () => {
    write("huge.txt", Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n"));
    const d = await g.diff(repo, "s1", { scope: "uncommitted" });
    expect(byPath(d)["huge.txt"]).toMatchObject({ status: "added", additions: 5000, hunks: [], truncated: true });
    expect(byPath(d)["keep.txt"].hunks.length).toBeGreaterThan(0);
    expect(d.truncated).toBe(true);
  });

  it("stops at the size cap and still lists the files after it", async () => {
    for (const n of ["m1", "m2", "m3"]) write(`many/${n}.txt`, Array.from({ length: 200 }, (_, i) => `${n} ${i}`).join("\n") + "\n");
    const d = await g.diff(repo, "s1", { scope: "uncommitted", maxBytes: 3000 });
    const f = byPath(d);
    expect(d.truncated).toBe(true);
    expect(d.files.filter((x) => x.truncated && x.hunks.length).map((x) => x.path)).toEqual(["many/m2.txt"]);
    expect(f["many/m3.txt"]).toMatchObject({ additions: 200, hunks: [], truncated: true });
    expect(f["keep.txt"].truncated).toBeUndefined();
  });

  it("works before the first commit", async () => {
    const fresh = path.join(tmp, "fresh");
    fs.mkdirSync(fresh);
    sh(["init", "-q", "-b", "main"], fresh);
    fs.writeFileSync(path.join(fresh, "a.txt"), "a\n");
    const d = await g.diff(fresh, "s1", { scope: "uncommitted" });
    expect(d.files.map((f) => [f.path, f.status])).toEqual([["a.txt", "added"]]);
    await expect(g.diff(fresh, "s1", { scope: "branch" })).rejects.toThrow(/no commits/i);
    await expect(g.diff(tmp, "s1", { scope: "uncommitted" })).rejects.toThrow(/git repository/);
  });

  it("keeps tabs in file names, renamed ones too", async () => {
    const tabs = path.join(tmp, "tabs");
    fs.mkdirSync(tabs);
    sh(["init", "-q", "-b", "main"], tabs);
    fs.writeFileSync(path.join(tabs, "old\tname.txt"), "same\ncontent\nhere\n");
    sh(["add", "-A"], tabs);
    sh(["commit", "-qm", "init"], tabs);
    fs.renameSync(path.join(tabs, "old\tname.txt"), path.join(tabs, "new\tname.txt"));
    fs.writeFileSync(path.join(tabs, "a\tb.txt"), "x\n");
    const d = await g.diff(tabs, "s1", { scope: "uncommitted" });
    expect(d.files.map((f) => [f.path, f.oldPath, f.status, f.additions])).toEqual([
      ["a\tb.txt", undefined, "added", 1],
      ["new\tname.txt", "old\tname.txt", "renamed", 0],
    ]);
  });

  it("shares one diff between identical requests in flight", async () => {
    const [a, b] = await Promise.all([g.diff(repo, "s1", { scope: "uncommitted" }), g.diff(repo, "s2", { scope: "uncommitted" })]);
    expect(a).toBe(b);
    const c = await g.diff(repo, "s1", { scope: "uncommitted" });
    expect(c).not.toBe(a);
    expect(c).toEqual(a);
  });
});
