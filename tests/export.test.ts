import { describe, expect, it } from "vitest";
import type { Entry } from "@/lib/types";
import { code, exportFilename, slugify, toMarkdown } from "@/lib/server/export";

const ts = "2026-10-18T10:00:01.000Z";
const tool = (id: string, name: string, input: Record<string, unknown>): Entry => ({ kind: "tool", id, ts, msgId: "m1", toolUseId: id, name, input });
const result = (id: string, text: string, isError = false, truncated = false): Entry => ({ kind: "result", id: `${id}:r`, ts, toolUseId: id, result: { text, isError, truncated } });

const entries: Entry[] = [
  { kind: "notice", id: "n0", ts, tone: "info", text: "Context compacted" },
  { kind: "user", id: "u1", ts, text: "Fix the **build**.\n\nAttached files:\n- /home/u/.cache/agent-u/attachments/2026-10-18-ab/log.txt", images: 2 },
  { kind: "thinking", id: "th1", ts, msgId: "m1", text: "secret pondering" },
  { kind: "usage", id: "m1:usage", ts, model: "claude", input: 1200, cacheRead: 0, cacheWrite: 0, output: 50 },
  { kind: "text", id: "t1", ts, msgId: "m1", text: "Let me look.\n\n```ts\nconst a = 1;\n```" },
  tool("b1", "Bash", { command: "npm test", description: "Run the tests" }),
  result("b1", "1 failing", true),
  tool("r1", "Read", { file_path: "/proj/src/a.ts" }),
  result("r1", "     1\tconst a = 1;"),
  tool("e1", "Edit", { file_path: "/proj/src/a.ts", old_string: "const a = 1;", new_string: "const a = 2;" }),
  result("e1", "The file has been updated."),
  tool("w1", "Write", { file_path: "/elsewhere/notes.md", content: "one\ntwo\n" }),
  { kind: "text", id: "t2", ts, msgId: "m2", text: "Fixed." },
  { kind: "notice", id: "n1", ts, tone: "warn", text: "Stopped\nby you" },
  { kind: "user", id: "u2", ts: "2026-10-18T10:05:00.000Z", text: "thanks", images: 0 },
];
const opts = { title: "Fix the build", agent: "claude" as const, cwd: "/proj", exportedAt: new Date("2026-10-19T02:42:00Z") };

describe("toMarkdown", () => {
  const md = toMarkdown(entries, opts);

  it("starts with the title, agent, folder and dates", () => {
    expect(md.startsWith("# Fix the build\n\n- Agent: Claude\n- Folder: `/proj`\n- Started: 2026-10-18 10:00 UTC\n- Exported: 2026-10-19 02:42 UTC\n")).toBe(true);
  });

  it("keeps user and agent text in full, in turns", () => {
    expect(md).toContain("## User\n\nFix the **build**.\n\n_2 images_\n\nAttached files:\n- `/home/u/.cache/agent-u/attachments/2026-10-18-ab/log.txt`");
    expect(md).toContain("## Claude\n\nLet me look.\n\n```ts\nconst a = 1;\n```");
    expect(md).toContain("Fixed.");
    expect(md.match(/## User/g)).toHaveLength(2);
    expect(md.match(/## Claude/g)).toHaveLength(1);
  });

  it("summarises tool calls in one list, paths relative to the folder", () => {
    expect(md).toContain("- Ran `npm test` (failed)\n- Read `src/a.ts`\n- Edited `src/a.ts`\n- Wrote 3 lines `/elsewhere/notes.md`\n\nFixed.");
  });

  it("shows notices as blockquotes and leaves out thinking, usage and results", () => {
    expect(md).toContain("> Context compacted");
    expect(md).toContain("> Stopped\n> by you");
    expect(md).not.toContain("secret pondering");
    expect(md).not.toContain("1200");
    expect(md).not.toContain("1 failing");
    expect(md).not.toContain("```diff");
  });

  it("adds diffs and clipped output with tools=full", () => {
    const full = toMarkdown(entries, { ...opts, tools: "full" });
    expect(full).toContain("- Edited `src/a.ts`\n\n```diff\n-const a = 1;\n+const a = 2;\n```");
    expect(full).toContain("```diff\n+one\n+two\n```");
    expect(full).toContain("- Ran `npm test` (failed)\n\n```text\n1 failing\n```");
    expect(full).toContain("```text\n     1\tconst a = 1;\n```");
    /* an edit's "file updated" isn't worth repeating */
    expect(full).not.toContain("The file has been updated.");
    const long = toMarkdown([tool("x", "Bash", { command: "seq 100" }), result("x", Array.from({ length: 100 }, (_, i) => String(i + 1)).join("\n"))], { ...opts, tools: "full" });
    expect(long).toContain("40\n… 60 more lines\n```");
    expect(long).not.toContain("\n41\n");
  });

  it("drops tool lines with tools=none", () => {
    const none = toMarkdown(entries, { ...opts, tools: "none" });
    expect(none).not.toMatch(/^- (Ran|Read|Edited|Wrote)/m);
    expect(none).toContain("Let me look.");
  });

  it("renders patches and multi-line commands in full mode", () => {
    const patch = "*** Begin Patch\n*** Update File: /proj/b.ts\n@@ fn\n-old\n+new\n*** End Patch";
    const full = toMarkdown([tool("p", "apply_patch", { patch }), tool("c", "Bash", { command: "cd x\nmake" })], { ...opts, agent: "codex", tools: "full" });
    expect(full).toContain("## Codex\n\n- Patched `b.ts`\n\n```diff\n--- b.ts\n+++ b.ts\n@@ fn @@\n-old\n+new\n```");
    expect(full).toContain("- Ran `cd x make`\n\n```sh\ncd x\nmake\n```");
  });

  it("shows a continued session as a notice and the user's next message", () => {
    const text = 'This conversation continues a session that started in Codex ("Old"), working in /proj.\n<previous_session>...</previous_session>\n\nContinue from there. The user\'s next message:\n\nkeep going';
    const md2 = toMarkdown([{ kind: "user", id: "u", ts, text, images: 0 }], opts);
    expect(md2).toContain("> Continued from Codex\n\n## User\n\nkeep going");
    expect(md2).not.toContain("previous_session");
  });

  it("keeps backticks in commands from breaking the line", () => {
    expect(code("echo `date`")).toBe("`` echo `date` ``");
    expect(code("a`b")).toBe("``a`b``");
    expect(toMarkdown([tool("x", "Bash", { command: "echo `date`" })], opts)).toContain("- Ran `` echo `date` ``");
  });

  it("fences output that itself has fences", () => {
    const full = toMarkdown([tool("x", "Bash", { command: "cat a.md" }), result("x", "```js\nx\n```")], { ...opts, tools: "full" });
    expect(full).toContain("````text\n```js\nx\n```\n````");
  });
});

describe("export file names", () => {
  it("slugs the title", () => {
    expect(slugify("Fix the build: café/../../etc")).toBe("fix-the-build-cafe-etc");
    expect(slugify("  ")).toBe("session");
    expect(slugify("日本語")).toBe("session");
    expect(slugify("a".repeat(100))).toHaveLength(60);
  });

  it("uses the day the session started", () => {
    expect(exportFilename("Fix it", entries, "md")).toBe("fix-it-2026-10-18.md");
    expect(exportFilename("", [], "json", new Date("2026-01-02T00:00:00Z"))).toBe("session-2026-01-02.json");
  });
});
