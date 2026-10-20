import { describe, expect, it } from "vitest";
import type { Entry, ToolResult } from "@/lib/types";
import { appendToDraft } from "@/lib/client/composer-insert";
import { askText, codeLang, quoteMarkdown, selectionBlock } from "@/lib/client/quote";
import { filesSummary, toolEdits, turnFiles, writesFiles } from "@/lib/client/file-edits";
import { collectChanges } from "@/components/claude/ChangesPanel";
import { editsIn, toBlocks, type Block } from "@/lib/client/turns";
import { branchTitle, claudeCutter, cutIndex, parseBranchBody, rewriteRecord, truncateSource } from "@/lib/server/branch-shape";
import type { Source } from "@/lib/server/handoff-shape";
import { editBody, editPlan, lastPrompt, lastReply } from "@/lib/client/branching";

const tool = (id: string, name: string, input: Record<string, unknown>): Entry => ({ kind: "tool", id, ts: "2026-10-19T10:00:00.000Z", msgId: "m", toolUseId: id, name, input });
const user = (id: string, text: string, ts = "2026-10-19T10:00:00.000Z"): Entry => ({ kind: "user", id, ts, text, images: 0 });
const text = (id: string, t: string): Entry => ({ kind: "text", id, ts: "2026-10-19T10:00:01.000Z", msgId: id, text: t });
const result = (id: string, isError = false): Entry => ({ kind: "result", id: `${id}:r`, ts: "2026-10-19T10:00:00.500Z", toolUseId: id, result: { text: "", isError, truncated: false } });

describe("selection to the composer", () => {
  it("quotes prose line by line, keeping paragraph breaks inside one quote", () => {
    expect(quoteMarkdown("First line\nsecond line")).toBe("> First line\n> second line");
    expect(quoteMarkdown("\n\nOne.   \n\n\n\nTwo.\n")).toBe("> One.\n>\n> Two.");
    expect(quoteMarkdown("a\u00a0b\r\nc")).toBe("> a b\n> c");
    expect(quoteMarkdown("  \n ")).toBe("");
  });

  it("fences a selection inside a code block, with the block's language", () => {
    expect(selectionBlock("const a = 1;\n", { lang: "ts" })).toBe("```ts\nconst a = 1;\n```");
    expect(selectionBlock("x", { lang: "src/app/page.tsx" })).toBe("```tsx\nx\n```");
    expect(selectionBlock("a ``` b", { lang: null })).toBe("````\na ``` b\n````");
    expect(selectionBlock("Plain words.")).toBe("> Plain words.");
    expect(selectionBlock("   ")).toBe("");
  });

  it("reads a code card's label as a fence language", () => {
    expect(codeLang("TypeScript")).toBe("typescript");
    expect(codeLang("text")).toBe("");
    expect(codeLang("Makefile")).toBe("makefile");
    expect(codeLang("lib/foo")).toBe("");
    expect(codeLang("weird label!")).toBe("");
    expect(codeLang(undefined)).toBe("");
  });

  it("lands as its own paragraph with a blank line after it, keeping the draft", () => {
    expect(appendToDraft("", askText("> quoted"))).toBe("> quoted\n\n");
    expect(appendToDraft("What about this?\n\n", askText("> quoted"))).toBe("What about this?\n\n> quoted\n\n");
    expect(appendToDraft("Two quotes", askText("> a"))).toBe("Two quotes\n\n> a\n\n");
  });
});

const PATCH = [
  "*** Begin Patch",
  "*** Update File: src/a.ts",
  "@@ function a",
  " keep",
  "-old",
  "+new",
  "+more",
  "@@",
  "-gone",
  "*** Add File: src/b.ts",
  "+one",
  "+two",
  "*** Delete File: src/c.ts",
  "*** Update File: src/d.ts",
  "*** Move to: src/e.ts",
  "*** End Patch",
].join("\n");

describe("files a turn changed", () => {
  it("reads Claude's shapes, which the other adapters map their tools to", () => {
    const tools = [
      tool("1", "Edit", { file_path: "/p/a.ts", old_string: "a\nb", new_string: "a\nc\nd" }),
      tool("2", "MultiEdit", { file_path: "/p/b.ts", edits: [{ old_string: "x", new_string: "y" }, { old_string: "", new_string: "z" }] }),
      tool("3", "Write", { file_path: "/p/c.ts", content: "1\n2\n3" }),
      tool("4", "NotebookEdit", { notebook_path: "/p/n.ipynb", new_source: "print(1)" }),
      tool("5", "Read", { file_path: "/p/a.ts" }),
      tool("6", "Edit", { file_path: "/p/a.ts", old_string: "d", new_string: "" }),
    ];
    expect(turnFiles(tools, {})).toEqual([
      { path: "/p/a.ts", added: 2, removed: 2 },
      { path: "/p/b.ts", added: 2, removed: 1 },
      { path: "/p/c.ts", added: 3, removed: 0 },
      { path: "/p/n.ipynb", added: 1, removed: 0 },
    ]);
  });

  it("reads Codex and OpenCode patch envelopes file by file", () => {
    const files = turnFiles([tool("1", "ApplyPatch", { patch: PATCH }), tool("2", "apply_patch", { files: "update src/f.ts", patch: "*** Begin Patch\n*** Update File: src/f.ts\n@@\n-a\n+b\n*** End Patch" })], {});
    expect(files).toEqual([
      { path: "src/a.ts", added: 2, removed: 2 },
      { path: "src/b.ts", added: 2, removed: 0 },
      { path: "src/c.ts", added: 0, removed: null },
      { path: "src/e.ts", added: 0, removed: 0 },
      { path: "src/f.ts", added: 1, removed: 1 },
    ]);
  });

  it("leaves counts it can't know empty, and skips failed calls", () => {
    const tools = [
      tool("1", "Edit", { file_path: "/p/a.ts", old_string: "a", new_string: "b", replace_all: true }),
      tool("2", "Edit", { file_path: "/p/a.ts", old_string: "c", new_string: "d" }),
      tool("3", "Write", { file_path: "/p/x.ts", content: "boom" }),
    ];
    const results: Record<string, ToolResult> = { "3": { text: "denied", isError: true, truncated: false } };
    expect(turnFiles(tools, results)).toEqual([{ path: "/p/a.ts", added: null, removed: null }]);
    expect(filesSummary(turnFiles(tools, results))).toEqual({ label: "1 file changed", added: null, removed: null });
    expect(filesSummary([{ path: "a", added: 3, removed: 1 }, { path: "b", added: null, removed: null }, { path: "c", added: 1, removed: 0 }])).toEqual({ label: "3 files changed", added: 4, removed: 1 });
  });

  it("counts patch tools as file writes for the turn's fold and the Changes panel", () => {
    expect(writesFiles(tool("1", "ApplyPatch", { patch: PATCH }))).toBe(true);
    expect(writesFiles(tool("1", "ApplyPatch", { patch: "nothing here" }))).toBe(false);
    expect(writesFiles(tool("1", "Edit", {}))).toBe(false);
    expect(toolEdits(tool("1", "Bash", { command: "ls" }))).toEqual([]);
    const entries = [user("u1", "go"), tool("t1", "ApplyPatch", { patch: PATCH }), result("t1"), text("a1", "Done.")];
    expect(editsIn(entries)).toHaveLength(1);
    const fold = toBlocks(entries).find((b): b is Extract<Block, { type: "fold" }> => b.type === "fold");
    expect(fold?.edits.map((e) => e.id)).toEqual(["t1"]);
    const changes = collectChanges(entries, {});
    expect(changes.map((c) => c.path).sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/e.ts"]);
    expect(changes.find((c) => c.path === "src/a.ts")).toMatchObject({ added: 2, removed: 2 });
  });
});

describe("fork and edit: what the new session keeps", () => {
  const entries: Entry[] = [user("u1", "one"), tool("t1", "Bash", { command: "ls" }), result("t1"), text("a1:0", "first"), user("u2", "two"), text("a2:0", "second"), text("a2:1", "more")];

  it("cuts an edit before its prompt and a fork after its whole turn", () => {
    expect(cutIndex(entries, "u2", "edit")).toBe(4);
    expect(cutIndex(entries, "u1", "edit")).toBe(0);
    expect(cutIndex(entries, "a1:0", "fork")).toBe(4);
    expect(cutIndex(entries, "a2:0", "fork")).toBe(7);
    expect(cutIndex(entries, "a1:0", "edit")).toBeNull();
    expect(cutIndex(entries, "u1", "fork")).toBeNull();
    expect(cutIndex(entries, "nope", "fork")).toBeNull();
  });

  it("keeps the results of the kept tool calls only", () => {
    const src: Source = { agent: "codex", key: "codex:x", title: "T", cwd: "/p", entries, results: { t1: { text: "", isError: false, truncated: false }, gone: { text: "", isError: false, truncated: false } } };
    const cut = truncateSource(src, "a1:0", "fork")!;
    expect(cut.entries).toHaveLength(4);
    expect(Object.keys(cut.results)).toEqual(["t1"]);
    expect(truncateSource(src, "a1:0", "edit")).toBeNull();
  });

  it("walks a Claude transcript to the cut", () => {
    const rec = (r: Record<string, unknown>) => JSON.stringify({ sessionId: "old", ...r });
    const lines = [
      rec({ type: "custom-title", customTitle: "T" }),
      rec({ type: "user", uuid: "u1", timestamp: "2026-10-19T10:00:00.000Z", message: { role: "user", content: "one" } }),
      rec({ type: "assistant", uuid: "a1", timestamp: "2026-10-19T10:00:01.000Z", message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } }),
      rec({ type: "user", uuid: "r1", timestamp: "2026-10-19T10:00:02.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }),
      rec({ type: "assistant", uuid: "a2", timestamp: "2026-10-19T10:00:03.000Z", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "first" }] } }),
      rec({ type: "system", subtype: "turn_duration", uuid: "s1", timestamp: "2026-10-19T10:00:03.500Z" }),
      rec({ type: "user", uuid: "u2", timestamp: "2026-10-19T10:01:00.000Z", message: { role: "user", content: "two" } }),
      rec({ type: "assistant", uuid: "a3", timestamp: "2026-10-19T10:01:01.000Z", message: { id: "m3", role: "assistant", content: [{ type: "text", text: "second" }] } }),
    ];
    const run = (id: string, kind: "fork" | "edit") => {
      const c = claudeCutter(id, kind);
      let n = 0;
      for (const l of lines) {
        if (!c.take(l)) break;
        n++;
      }
      return { n, found: c.found, kept: c.kept, stopTs: c.stopTs };
    };
    /* the tool result line and the turn's bookkeeping go with the fork */
    expect(run("a2:0", "fork")).toEqual({ n: 6, found: true, kept: 3, stopTs: "2026-10-19T10:01:00.000Z" });
    expect(run("a3:0", "fork")).toEqual({ n: 8, found: true, kept: 5, stopTs: null });
    expect(run("u2", "edit")).toEqual({ n: 6, found: true, kept: 3, stopTs: "2026-10-19T10:01:00.000Z" });
    expect(run("u1", "edit")).toMatchObject({ n: 1, found: true, kept: 0 });
    /* a tool result record is not a prompt to edit from, and a prompt is not a reply to fork from */
    expect(run("r1", "edit").found).toBe(false);
    expect(run("u1", "fork").found).toBe(false);
    expect(run("missing", "fork").found).toBe(false);
  });

  it("moves copied records to the new session id", () => {
    expect(JSON.parse(rewriteRecord('{"type":"user","sessionId":"old","uuid":"u"}', "new")!)).toEqual({ type: "user", sessionId: "new", uuid: "u" });
    expect(rewriteRecord('{"type":"summary"}', "new")).toBe('{"type":"summary"}');
    expect(rewriteRecord("not json", "new")).toBeNull();
    expect(rewriteRecord("[1]", "new")).toBeNull();
  });

  it("names the copy after the source, once", () => {
    expect(branchTitle("Fix login", "fork")).toBe("Fix login (fork)");
    expect(branchTitle("Fix login (fork)", "fork")).toBe("Fix login (fork)");
    expect(branchTitle("Fix login (fork)", "edit")).toBe("Fix login (edited)");
    expect(branchTitle("", "edit")).toBe("Session (edited)");
  });
});

describe("fork and edit requests", () => {
  it("takes a well-formed body", () => {
    expect(parseBranchBody("edit", { entryId: "u2", text: "  try again  ", checkpoint: "1760000000000-ab12", permissionMode: "acceptEdits", model: "claude-opus-4-1[1m]", profile: "claude-work", clientId: "x" })).toEqual({
      entryId: "u2",
      text: "try again",
      checkpoint: "1760000000000-ab12",
      mode: "acceptEdits",
      model: "claude-opus-4-1[1m]",
      profile: "claude-work",
    });
    expect(parseBranchBody("fork", { entryId: "a1:0" })).toEqual({ entryId: "a1:0", text: "", checkpoint: null, mode: null, model: null, profile: null });
  });

  it("refuses anything off", () => {
    expect(parseBranchBody("fork", {})).toBe("Choose a message.");
    expect(parseBranchBody("fork", { entryId: "has space" })).toBe("Choose a message.");
    expect(parseBranchBody("fork", { entryId: "x".repeat(257) })).toBe("Choose a message.");
    expect(parseBranchBody("fork", { entryId: 3 })).toBe("Choose a message.");
    expect(parseBranchBody("edit", { entryId: "u1" })).toBe("Enter a message.");
    expect(parseBranchBody("edit", { entryId: "u1", text: "   " })).toBe("Enter a message.");
    expect(parseBranchBody("edit", { entryId: "u1", text: 5 })).toBe("The message must be text.");
    expect(parseBranchBody("edit", { entryId: "u1", text: "x".repeat(500_001) })).toBe("That message is too long.");
    expect(parseBranchBody("fork", { entryId: "a", checkpoint: "1760000000000-ab12" })).toBe("Only Edit from here puts files back.");
    expect(parseBranchBody("edit", { entryId: "u", text: "t", checkpoint: "../../etc" })).toBe("Unknown checkpoint.");
    expect(parseBranchBody("edit", { entryId: "u", text: "t", permissionMode: "yolo" })).toBe("Unknown approval mode.");
    expect(parseBranchBody("edit", { entryId: "u", text: "t", model: "a b" })).toBe("Unknown model.");
    expect(parseBranchBody("edit", { entryId: "u", text: "t", profile: "../x" })).toBe("Unknown profile.");
  });
});

describe("edit and fork from here", () => {
  const ts = (m: number) => `2026-10-19T10:${String(m).padStart(2, "0")}:00.000Z`;
  const at = (s: number) => Date.parse(ts(s));
  const convo: Entry[] = [
    user("u1", "Make a", ts(0)),
    tool("t1", "Write", { file_path: "/p/a.txt", content: "a\n" }),
    text("r1", "Done."),
    user("u2", "Explain", ts(10)),
    text("r2", "It is a file."),
    user("u3", "Change a and b", ts(20)),
    tool("t3", "Edit", { file_path: "/p/a.txt", old_string: "a", new_string: "b" }),
    tool("t4", "Write", { file_path: "/p/b.txt", content: "b\n" }),
    text("r3", "Changed."),
  ];

  it("plans a rewind to the checkpoint taken before the prompt", () => {
    const cps = [
      { id: "1-aaaa", at: at(0) - 500, label: "Make a" },
      { id: "2-bbbb", at: at(20) - 500, label: "Change a and b" },
    ];
    expect(editPlan(convo, cps, "u3")).toEqual({ files: 2, checkpoint: "2-bbbb" });
    expect(editPlan(convo, cps, "u2")).toEqual({ files: 2, checkpoint: null });
    expect(editPlan(convo, cps, "u1")).toEqual({ files: 2, checkpoint: "1-aaaa" });
    expect(editPlan(convo, cps, "missing")).toEqual({ files: 0, checkpoint: null });
  });

  it("leaves files alone when nothing since the prompt changed any", () => {
    expect(editPlan(convo.slice(0, 5), [{ id: "1-aaaa", at: at(10) - 500, label: "Explain" }], "u2")).toEqual({ files: 0, checkpoint: null });
  });

  it("picks the rows the palette acts on", () => {
    expect(lastPrompt(convo)?.id).toBe("u3");
    expect(lastPrompt([])).toBeNull();
    expect(lastReply(convo, false)?.id).toBe("r3");
    expect(lastReply(convo, true)?.id).toBe("r2");
    expect(lastReply(convo.slice(0, 1), false)).toBeNull();
    expect(lastReply([...convo, user("u4", "More", ts(30))], false)).toBeNull();
  });

  it("says how many files go back", () => {
    expect(editBody({ files: 1, checkpoint: "x" })).toMatch(/^1 file the agent changed/);
    expect(editBody({ files: 3, checkpoint: "x" })).toMatch(/^3 files /);
  });
});
