import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanCommitMessage, summaryMessage } from "@/lib/server/git";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentu-gitmsg-"));
const repo = path.join(tmp, "repo");
const bin = path.join(tmp, "bin");
const logs = path.join(tmp, "logs");
let g: typeof import("@/lib/server/git");

const sh = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const write = (p: string, s: string) => fs.writeFileSync(path.join(repo, p), s);
const fake = (name: string, script: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
const NONE = "/nonexistent/agent-u-test-bin";
process.env.XDG_CACHE_HOME = path.join(tmp, "cache");
const saved = { PATH: process.env.PATH, CLAUDE_BIN: process.env.CLAUDE_BIN, CODEX_BIN: process.env.CODEX_BIN, GEMINI_BIN: process.env.GEMINI_BIN };

beforeAll(async () => {
  g = await import("@/lib/server/git");
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  fs.mkdirSync(logs);
  sh(["init", "-q", "-b", "main"]);
  write("a.txt", "one\n");
  sh(["add", "-A"]);
  sh(["commit", "-qm", "Add the first file"]);
  write("a.txt", "two\n");
  sh(["commit", "-qam", "Tweak a.txt wording"]);
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const f of fs.readdirSync(bin)) fs.rmSync(path.join(bin, f));
  for (const f of fs.readdirSync(logs)) fs.rmSync(path.join(logs, f));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** only the fake binaries count: the real ones are pointed at nothing unless a test puts a fake on PATH */
const agentsFrom = (...names: string[]) => {
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ""}`;
  for (const [agent, env] of [["claude", "CLAUDE_BIN"], ["codex", "CODEX_BIN"], ["gemini", "GEMINI_BIN"]] as const) {
    if (names.includes(agent)) delete process.env[env];
    else process.env[env] = NONE;
  }
};

describe("cleanCommitMessage", () => {
  it("keeps a plain subject and body", () => {
    expect(cleanCommitMessage("Fix login redirect\n\nThe cookie was read before it was set.\n")).toBe("Fix login redirect\n\nThe cookie was read before it was set.");
  });

  it("drops preambles, fences, quotes, labels and trailing periods", () => {
    expect(cleanCommitMessage("Here's a commit message:\n\n```\nAdd retry to uploads.\n```\n")).toBe("Add retry to uploads");
    expect(cleanCommitMessage('"Update the README"')).toBe("Update the README");
    expect(cleanCommitMessage("Commit message: **Bump deps**")).toBe("Bump deps");
    expect(cleanCommitMessage("\x1b[32mSubject: Speed up diff\x1b[0m")).toBe("Speed up diff");
  });

  it("cuts a long subject at a word, at most 72 characters", () => {
    const out = cleanCommitMessage(`Refactor ${"the session list rendering ".repeat(5)}`);
    expect(out.length).toBeLessThanOrEqual(72);
    expect(out).toMatch(/^Refactor the session list/);
    expect(out).not.toMatch(/\s$/);
    expect(cleanCommitMessage("x".repeat(100))).toHaveLength(72);
  });

  it("drops attribution lines and returns nothing for an empty reply", () => {
    expect(cleanCommitMessage("Add tests\n\nCovers the parser.\n\nCo-authored-by: Bot <b@x>\nGenerated with a tool")).toBe("Add tests\n\nCovers the parser.");
    expect(cleanCommitMessage("  \n\n")).toBe("");
    expect(cleanCommitMessage("```\n```")).toBe("");
  });
});

describe("summaryMessage", () => {
  const m = (status: "added" | "modified" | "deleted" | "renamed", ...paths: string[]) => paths.map((p) => ({ path: p, status }));

  it("names one to three files", () => {
    expect(summaryMessage(m("modified", "components/claude/GitPanel.tsx", "lib/server/git.ts"))).toBe("Update GitPanel.tsx and git.ts");
    expect(summaryMessage(m("modified", "a.ts"))).toBe("Update a.ts");
    expect(summaryMessage(m("modified", "a.ts", "b.ts", "c.ts"))).toBe("Update a.ts, b.ts and c.ts");
  });

  it("counts the rest", () => {
    expect(summaryMessage(m("modified", "a.ts", "b.ts", "c.ts", "d.ts"))).toBe("Update a.ts, b.ts and 2 more files");
    expect(summaryMessage(m("modified", "a.ts", "b.ts", "c.ts"))).toBe("Update a.ts, b.ts and c.ts");
  });

  it("says Add or Remove when every file was added or deleted", () => {
    expect(summaryMessage(m("added", "x/new.ts"))).toBe("Add new.ts");
    expect(summaryMessage(m("deleted", "old.ts", "older.ts"))).toBe("Remove old.ts and older.ts");
    expect(summaryMessage([...m("added", "a.ts"), ...m("deleted", "b.ts")])).toBe("Update a.ts and b.ts");
  });

  it("stays within 72 characters with long names", () => {
    const long = (c: string) => `${c.repeat(40)}.ts`;
    const out = summaryMessage(m("modified", long("a"), long("b")));
    expect(out.length).toBeLessThanOrEqual(72);
    expect(out).toBe(`Update ${long("a")} and 1 more file`);
    expect(summaryMessage(m("modified", long("a") + long("a")))).toBe("Update 1 file");
  });
});

describe("suggestCommitMessage", () => {
  it("asks claude in print mode with the diff and the repo's style", async () => {
    agentsFrom("claude");
    fake("claude", `printf '%s\\n' "$@" > '${logs}/claude.args'\ncat > '${logs}/claude.stdin'\nprintf '\`\`\`\\nRename the greeting\\n\\nIt reads better.\\n\`\`\`\\n'`);
    write("a.txt", "three\n");
    const r = await g.suggestCommitMessage(repo);
    expect(r).toEqual({ message: "Rename the greeting\n\nIt reads better.", source: "claude", staged: false });
    const args = fs.readFileSync(path.join(logs, "claude.args"), "utf8").split("\n");
    expect(args).toEqual(expect.arrayContaining(["-p", "--model", "haiku"]));
    const prompt = fs.readFileSync(path.join(logs, "claude.stdin"), "utf8");
    expect(prompt).toContain("- Tweak a.txt wording");
    expect(prompt).toContain("- Add the first file");
    expect(prompt).toContain("+three");
    expect(prompt).toContain("modified a.txt (+1 -1)");
  });

  it("describes only the staged changes when some are staged", async () => {
    agentsFrom("claude");
    fake("claude", `cat > '${logs}/claude.stdin'\necho 'Add b'`);
    write("b.txt", "bee\n");
    sh(["add", "b.txt"]);
    const r = await g.suggestCommitMessage(repo);
    expect(r).toMatchObject({ message: "Add b", staged: true });
    const prompt = fs.readFileSync(path.join(logs, "claude.stdin"), "utf8");
    expect(prompt).toContain("+bee");
    expect(prompt).not.toContain("+three");
    sh(["reset", "-q", "b.txt"]);
  });

  it("moves on to codex when claude fails, and reads its last message", async () => {
    agentsFrom("claude", "codex");
    fake("claude", "echo 'not logged in' >&2\nexit 1");
    fake("codex", `cat > /dev/null\nwhile [ $# -gt 0 ]; do\n  if [ "$1" = "--output-last-message" ]; then shift; printf 'Tidy up a.txt\\n' > "$1"; fi\n  shift\ndone\necho 'progress noise'`);
    expect(await g.suggestCommitMessage(repo)).toMatchObject({ message: "Tidy up a.txt", source: "codex" });
  });

  it("falls back to a summary when no agent is installed or answers", async () => {
    agentsFrom();
    expect(await g.suggestCommitMessage(repo)).toMatchObject({ source: "summary", message: "Update a.txt and b.txt" });
    agentsFrom("gemini");
    fake("gemini", "cat > /dev/null\nprintf '\\n\\n'");
    expect((await g.suggestCommitMessage(repo)).source).toBe("summary");
  });

  it("asks gemini last and removes the chat it saved", async () => {
    agentsFrom("gemini");
    const home = path.join(tmp, "gemini-home");
    process.env.GEMINI_CLI_HOME = home;
    const chats = path.join(home, ".gemini", "tmp", "commit-message", "chats");
    fs.mkdirSync(chats, { recursive: true });
    fs.writeFileSync(path.join(chats, "session-2026-01-01T00-00-keepme00.jsonl"), "{}\n");
    fake(
      "gemini",
      `cat > /dev/null\nwhile [ $# -gt 0 ]; do\n  if [ "$1" = "--session-id" ]; then shift; id=$(printf %s "$1" | cut -c1-8); fi\n  shift\ndone\npwd > '${logs}/gemini.cwd'\necho '{}' > '${chats}'/session-2026-10-19T03-55-$id.jsonl\necho 'Speed up the greeting'`,
    );
    try {
      expect(await g.suggestCommitMessage(repo)).toMatchObject({ message: "Speed up the greeting", source: "gemini" });
    } finally {
      delete process.env.GEMINI_CLI_HOME;
    }
    expect(fs.readFileSync(path.join(logs, "gemini.cwd"), "utf8").trim()).toBe(path.join(tmp, "cache", "agent-u", "commit-message"));
    expect(fs.readdirSync(chats)).toEqual(["session-2026-01-01T00-00-keepme00.jsonl"]);
  });

  it("gives up on a slow agent at the timeout", async () => {
    agentsFrom("claude");
    fake("claude", "sleep 5\necho late");
    const t = Date.now();
    const r = await g.suggestCommitMessage(repo, { timeoutMs: 300 });
    expect(r.source).toBe("summary");
    expect(Date.now() - t).toBeLessThan(3000);
  });

  it("refuses when nothing changed", async () => {
    agentsFrom();
    sh(["add", "-A"]);
    sh(["commit", "-qm", "Save"]);
    await expect(g.suggestCommitMessage(repo)).rejects.toThrow("No changes to describe.");
  });
});
