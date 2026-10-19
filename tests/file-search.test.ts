import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/files/search/route";
import { clearFileCache, listFiles, rankFiles, walkFiles } from "@/lib/server/file-search";
import { insertMention, mentionAt } from "@/lib/client/mentions";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agentu-fs-"));
const put = (root: string, rel: string, text = "x") => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const search = async (params: Record<string, string>) => {
  const res = await GET(new NextRequest(`http://x/api/files/search?${new URLSearchParams(params)}`));
  return { status: res.status, body: await res.json() };
};

beforeEach(() => clearFileCache());

describe("ranking", () => {
  const files = ["src/components/Composer.tsx", "src/lib/compose.ts", "docs/composer-notes.md", "Composer.tsx", "src/app/page.tsx", "test/cmp/osr.ts", "README.md"];

  it("puts file-name hits before path hits, exact before prefix before contains", () => {
    expect(rankFiles(files, "composer.tsx")).toEqual(["Composer.tsx", "src/components/Composer.tsx"]);
    expect(rankFiles(files, "compose").slice(0, 4)).toEqual(["src/lib/compose.ts", "Composer.tsx", "docs/composer-notes.md", "src/components/Composer.tsx"]);
  });

  it("matches folders and then characters in order along the path", () => {
    expect(rankFiles(files, "src/app")).toEqual(["src/app/page.tsx"]);
    const fuzzy = rankFiles(files, "cmpsr");
    expect(fuzzy).toContain("src/components/Composer.tsx");
    expect(fuzzy).not.toContain("README.md");
    expect(rankFiles(files, "zzz")).toEqual([]);
  });

  it("lists the shallowest files for an empty query, capped", () => {
    expect(rankFiles(files, "", 3)).toEqual(["README.md", "Composer.tsx", "docs/composer-notes.md"]);
  });

  it("ignores case and a leading ./", () => {
    expect(rankFiles(files, "./readme")[0]).toBe("README.md");
  });
});

describe("listing", () => {
  it("walks breadth first, skipping node_modules, .git and dot folders, within the cap", async () => {
    const root = tmp();
    put(root, "a.txt");
    put(root, ".env");
    put(root, "deep/er/b.txt");
    put(root, "node_modules/x/index.js");
    put(root, ".cache/c.txt");
    expect((await walkFiles(root)).files.sort()).toEqual([".env", "a.txt", "deep/er/b.txt"]);
    const capped = await walkFiles(root, { max: 1 });
    expect(capped.truncated).toBe(true);
    expect(capped.files).toHaveLength(1);
  });

  it("uses git in a repo: tracked and untracked files, minus ignored ones", async () => {
    const root = tmp();
    execFileSync("git", ["init", "-q"], { cwd: root });
    put(root, ".gitignore", "dist/\n");
    put(root, "src/main.ts");
    put(root, "dist/out.js");
    put(root, "notes with space.md");
    execFileSync("git", ["add", "src/main.ts"], { cwd: root });
    expect((await listFiles(root)).files.sort()).toEqual([".gitignore", "notes with space.md", "src/main.ts"]);
  });

  it("caches a folder's list briefly", async () => {
    const root = tmp();
    put(root, "one.txt");
    expect((await listFiles(root)).files).toEqual(["one.txt"]);
    put(root, "two.txt");
    expect((await listFiles(root)).files).toEqual(["one.txt"]);
    clearFileCache();
    expect((await listFiles(root)).files.sort()).toEqual(["one.txt", "two.txt"]);
  });
});

describe("GET /api/files/search", () => {
  it("answers relative paths, best first, from the real folder", async () => {
    const root = tmp();
    put(root, "lib/util.ts");
    put(root, "util-old.ts");
    const link = path.join(tmp(), "link");
    fs.symlinkSync(root, link);
    const { status, body } = await search({ cwd: link, q: "util" });
    expect(status).toBe(200);
    expect(body.root).toBe(fs.realpathSync(root));
    expect(body.files).toEqual(["lib/util.ts", "util-old.ts"]);
    expect(body.truncated).toBe(false);
  });

  it("refuses relative, missing and non-folder paths", async () => {
    const root = tmp();
    put(root, "f.txt");
    expect((await search({ cwd: "relative/dir", q: "" })).status).toBe(400);
    expect((await search({ q: "" })).status).toBe(400);
    expect((await search({ cwd: path.join(root, "nope"), q: "" })).status).toBe(404);
    expect((await search({ cwd: path.join(root, "f.txt"), q: "" })).status).toBe(400);
    expect((await search({ cwd: `${root}\0x`, q: "" })).status).toBe(400);
  });

  it("caps the limit", async () => {
    const root = tmp();
    for (let i = 0; i < 5; i++) put(root, `f${i}.txt`);
    expect((await search({ cwd: root, q: "", limit: "2" })).body.files).toHaveLength(2);
  });
});

describe("mention text", () => {
  it("finds the @ token at the start or after whitespace only", () => {
    expect(mentionAt("@src", 4)).toEqual({ start: 0, end: 4, query: "src" });
    expect(mentionAt("look at @co", 11)).toEqual({ start: 8, end: 11, query: "co" });
    expect(mentionAt("me@example.com", 14)).toBeNull();
    expect(mentionAt("@done ", 6)).toBeNull();
    expect(mentionAt("x @ab|cd y".replace("|", ""), 5)).toEqual({ start: 2, end: 7, query: "abcd" });
  });

  it("puts the path in place of the token, quoting paths with spaces", () => {
    expect(insertMention("see @co", 4, 7, "src/Composer.tsx")).toEqual({ text: "see src/Composer.tsx ", caret: 21 });
    expect(insertMention("@n please", 0, 2, "my notes.md")).toEqual({ text: "`my notes.md` please", caret: 14 });
  });
});
