import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Entry } from "@/lib/types";
import { chatTitle, foldChat, geminiEntries, mapGeminiTool } from "@/lib/server/agents/gemini-store";
import { geminiArgs, geminiSessionOf, geminiStreamParser, friendlyGeminiError } from "@/lib/server/agents/gemini";
import { GEMINI_MODELS, spacedRows } from "@/lib/server/agents/models";

const SID = "3f2a9c1e-1111-4222-8333-444455556666";
const jsonl = (...recs: unknown[]) => recs.map((r) => JSON.stringify(r)).join("\n") + "\n";
const header = { sessionId: SID, projectHash: "abc", startTime: "2026-10-18T10:00:00.000Z", lastUpdated: "2026-10-18T10:05:00.000Z", kind: "main" };

const user = (id: string, content: unknown, ts = "2026-10-18T10:00:01.000Z") => ({ id, timestamp: ts, type: "user", content });
const shellCall = (status: string, extra: Record<string, unknown> = {}) => ({
  id: "call-1",
  name: "run_shell_command",
  args: { command: "ls -la", description: "List files", dir_path: "/proj" },
  status,
  ...extra,
});

describe("gemini chat folding", () => {
  it("replaces a record that reuses an id, in place", () => {
    const f = foldChat(
      jsonl(
        header,
        user("u1", "list the files"),
        { id: "g1", timestamp: "2026-10-18T10:00:02.000Z", type: "gemini", content: "", toolCalls: [shellCall("executing")] },
        { id: "g1", timestamp: "2026-10-18T10:00:02.000Z", type: "gemini", content: "Here they are.", toolCalls: [shellCall("success", { resultDisplay: "a.txt\nb.txt" })] },
        user("u2", "thanks"),
      ),
    );
    expect(f.meta.sessionId).toBe(SID);
    expect(f.messages.map((m) => m.id)).toEqual(["u1", "g1", "u2"]);
    expect(f.messages[1].content).toBe("Here they are.");
  });

  it("merges $set metadata and uses the summary as the title", () => {
    const f = foldChat(jsonl(header, user("u1", "first question"), { $set: { summary: "Listing files" } }, { $set: { lastUpdated: "x" } }));
    expect(f.meta.summary).toBe("Listing files");
    expect(chatTitle(f)).toBe("Listing files");
    expect(chatTitle(foldChat(jsonl(header, user("u0", "/help"), user("u1", "  what   is\nthis "))))).toBe("what is this");
  });

  it("applies $patch updates, removals and reordering", () => {
    const f = foldChat(
      jsonl(
        header,
        user("u1", "a"),
        { id: "g1", type: "gemini", content: "old" },
        user("u2", "b"),
        { id: "g2", type: "gemini", content: "two" },
        { $patch: { updates: [{ id: "g1", content: "new" }, { id: "missing", content: "x" }], removeIds: ["u2"] } },
        { $patch: { orderIds: ["g2", "g1"] } },
      ),
    );
    expect(f.messages.map((m) => m.id)).toEqual(["u1", "g2", "g1"]);
    expect(f.messages.find((m) => m.id === "g1")?.content).toBe("new");
  });

  it("$rewindTo drops that message and everything after it", () => {
    const f = foldChat(jsonl(header, user("u1", "a"), { id: "g1", type: "gemini", content: "x" }, user("u2", "b"), { id: "g2", type: "gemini", content: "y" }, { $rewindTo: "u2" }, user("u3", "c")));
    expect(f.messages.map((m) => m.id)).toEqual(["u1", "g1", "u3"]);
    /* an unknown id changes nothing */
    expect(foldChat(jsonl(header, user("u1", "a"), { $rewindTo: "nope" })).messages).toHaveLength(1);
  });

  it("survives a partial last line and junk", () => {
    const f = foldChat(jsonl(header, user("u1", "a")) + "not json\n" + '{"id":"g1","type":"gem');
    expect(f.messages.map((m) => m.id)).toEqual(["u1"]);
  });

  it("reads legacy .json chats", () => {
    const legacy = JSON.stringify({ ...header, messages: [user("u1", "hi"), { id: "g1", type: "gemini", content: "hello" }] }, null, 2);
    const f = foldChat(legacy);
    expect(f.meta.sessionId).toBe(SID);
    expect(geminiEntries(f).map((e) => e.kind)).toEqual(["user", "text"]);
  });
});

describe("gemini chat entries", () => {
  const fold = foldChat(
    jsonl(
      header,
      user("u0", [{ text: "<session_context>\ncwd: /proj\n</session_context>" }]),
      user("u1", [{ text: "<session_context>x</session_context>" }, { text: "list the files" }, { inlineData: { mimeType: "image/png", data: "" } }]),
      user("u2", "/stats"),
      user("u3", [{ functionResponse: { id: "call-0", name: "x", response: { output: "y" } } }]),
      {
        id: "g1",
        timestamp: "2026-10-18T10:00:03.000Z",
        type: "gemini",
        model: "gemini-3.5-flash",
        content: [{ text: "pondering", thought: true }, { text: "Here " }, { text: "they are." }],
        thoughts: [{ subject: "Planning", description: "List the folder first." }],
        tokens: { input: 1200, output: 80, cached: 1000, thoughts: 30, tool: 0, total: 1310 },
        toolCalls: [
          shellCall("success", { resultDisplay: "a.txt\nb.txt" }),
          { id: "call-2", name: "read_file", args: { file_path: "/proj/a.txt" }, status: "success", resultDisplay: "", result: [{ functionResponse: { id: "call-2", name: "read_file", response: { output: "contents of a" } } }] },
          { id: "call-3", name: "replace", args: { file_path: "/proj/a.txt", old_string: "a", new_string: "b" }, status: "error", result: [{ functionResponse: { id: "call-3", name: "replace", response: { error: "no match" } } }] },
          { id: "call-4", name: "write_todos", args: { todos: [{ description: "Read", status: "completed" }, { description: "Edit", status: "in_progress" }] }, status: "executing" },
        ],
      },
      { id: "i1", type: "info", content: "Switched model." },
      { id: "e1", type: "error", content: "Quota exceeded." },
    ),
  );
  const entries = geminiEntries(fold);
  const byId = (id: string) => entries.find((e) => e.id === id);

  it("keeps only what the user typed", () => {
    const users = entries.filter((e) => e.kind === "user");
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ id: "u1:x", text: "list the files", images: 1 });
  });

  it("maps thoughts, text, tool calls, results and usage with stable ids", () => {
    expect(byId("g1:t0")).toMatchObject({ kind: "thinking", msgId: "g1", text: "**Planning**\n\nList the folder first." });
    expect(byId("g1:tp")).toMatchObject({ kind: "thinking", text: "pondering" });
    expect(byId("g1:x")).toMatchObject({ kind: "text", msgId: "g1", text: "Here they are." });
    expect(byId("g1:call-1")).toMatchObject({ kind: "tool", toolUseId: "call-1", name: "Bash", input: { command: "ls -la", description: "List files", cwd: "/proj" } });
    expect(byId("g1:call-1:r")).toMatchObject({ kind: "result", toolUseId: "call-1", result: { text: "a.txt\nb.txt", isError: false } });
    expect(byId("g1:call-2:r")).toMatchObject({ result: { text: "contents of a", isError: false } });
    expect(byId("g1:call-3")).toMatchObject({ name: "Edit", input: { file_path: "/proj/a.txt", old_string: "a", new_string: "b" } });
    expect(byId("g1:call-3:r")).toMatchObject({ result: { text: "no match", isError: true } });
    expect(byId("g1:call-4")).toMatchObject({ name: "TodoWrite", input: { todos: [{ content: "Read", status: "completed" }, { content: "Edit", status: "in_progress" }] } });
    /* still running: no result yet */
    expect(byId("g1:call-4:r")).toBeUndefined();
    expect(byId("g1:u")).toMatchObject({ kind: "usage", model: "gemini-3.5-flash", input: 200, cacheRead: 1000, output: 80 });
  });

  it("turns info and errors into notices", () => {
    expect(byId("i1:x")).toMatchObject({ kind: "notice", tone: "info", text: "Switched model." });
    expect(byId("e1:x")).toMatchObject({ kind: "notice", tone: "warn" });
  });

  it("gives the same ids on a re-fold", () => {
    expect(geminiEntries(fold).map((e) => e.id)).toEqual(entries.map((e) => e.id));
  });
});

describe("gemini tool names", () => {
  it.each([
    ["glob", { pattern: "**/*.ts", dir_path: "src" }, "Glob", { pattern: "**/*.ts", path: "src" }],
    ["grep_search", { pattern: "TODO", dir_path: "src", include_pattern: "*.ts" }, "Grep", { pattern: "TODO", path: "src", glob: "*.ts" }],
    ["list_directory", { dir_path: "/proj" }, "LS", { path: "/proj" }],
    ["google_web_search", { query: "vitest" }, "WebSearch", { query: "vitest" }],
    ["web_fetch", { prompt: "Summarize https://example.com/a please" }, "WebFetch", { url: "https://example.com/a" }],
    ["write_file", { file_path: "/a", content: "x" }, "Write", { file_path: "/a", content: "x" }],
    ["invoke_agent", { agent_name: "codebase_investigator", prompt: "look" }, "Task", { prompt: "look" }],
    ["exit_plan_mode", { plan: "do it" }, "ExitPlanMode", { plan: "do it" }],
    ["mcp_thing", { a: 1 }, "mcp_thing", { a: 1 }],
  ])("%s", (name, args, want, input) => {
    const m = mapGeminiTool(name, args);
    expect(m.name).toBe(want);
    expect(m.input).toMatchObject(input);
  });
});

describe("gemini stream-json", () => {
  const lines = [
    { type: "init", timestamp: "t", session_id: SID, model: "auto" },
    { type: "message", timestamp: "t", role: "user", content: "hi" },
    { type: "message", timestamp: "t", role: "assistant", content: "Let me ", delta: true },
    { type: "message", timestamp: "t", role: "assistant", content: "look.", delta: true },
    { type: "tool_use", timestamp: "t", tool_name: "run_shell_command", tool_id: "c1", parameters: { command: "ls" } },
    { type: "tool_result", timestamp: "t", tool_id: "c1", status: "success", output: "" },
    { type: "message", timestamp: "t", role: "assistant", content: "Done.", delta: true },
    { type: "error", timestamp: "t", severity: "warning", message: "retrying" },
  ];

  it("streams assistant deltas, a new segment after each tool call", () => {
    const text: [number, string][] = [];
    let init: string | null = null;
    const warnings: string[] = [];
    const p = geminiStreamParser({ text: (s, t) => text.push([s, t]), init: (id) => (init = id), error: (m) => warnings.push(m) });
    for (const l of lines) p(JSON.stringify(l));
    p("not json");
    expect(init).toBe(SID);
    expect(text).toEqual([
      [0, "Let me "],
      [0, "look."],
      [1, "Done."],
    ]);
    expect(warnings).toEqual([]);
  });

  it("reports the turn result and its error message", () => {
    const results: { ok: boolean; error: string | null }[] = [];
    const p = geminiStreamParser({ text: () => {}, result: (r) => results.push(r) });
    p(JSON.stringify({ type: "result", status: "success", stats: { total_tokens: 10 } }));
    p(JSON.stringify({ type: "result", status: "error", error: { type: "FatalAuthenticationError", message: "Please set an Auth method" }, stats: {} }));
    expect(results.map((r) => [r.ok, r.error])).toEqual([
      [true, null],
      [false, "Please set an Auth method"],
    ]);
    expect(friendlyGeminiError("Exited with code 41")).toMatch(/GEMINI_API_KEY/);
    expect(friendlyGeminiError("model not found")).toBe("model not found");
  });

  it("ignores a whole message that repeats its deltas", () => {
    const text: string[] = [];
    const p = geminiStreamParser({ text: (_s, t) => text.push(t) });
    p(JSON.stringify({ type: "message", role: "assistant", content: "Hi", delta: true }));
    p(JSON.stringify({ type: "message", role: "assistant", content: "Hi" }));
    expect(text).toEqual(["Hi"]);
  });
});

describe("gemini argv", () => {
  it("builds new-session and resume turns", () => {
    expect(geminiArgs({ mode: "bypassPermissions", id: SID, resume: false, model: "flash" })).toEqual(["-p", "", "--output-format", "stream-json", "--skip-trust", "--approval-mode", "yolo", "--session-id", SID, "-m", "flash"]);
    expect(geminiArgs({ mode: "acceptEdits", id: SID, resume: true })).toEqual(["-p", "", "--output-format", "stream-json", "--skip-trust", "--approval-mode", "auto_edit", "--resume", SID]);
    expect(geminiArgs({ mode: "plan", id: SID, resume: true })).toContain("plan");
  });

  it("finds interactive sessions from the process command line", () => {
    expect(geminiSessionOf(["node", "/usr/lib/node_modules/@google/gemini-cli/dist/index.js", "--resume", SID])).toBe(SID);
    expect(geminiSessionOf(["/usr/bin/node", "/home/u/.local/bin/gemini", `--resume=${SID}`])).toBe(SID);
    expect(geminiSessionOf(["node", "/home/u/.local/bin/gemini", "-p", "", "--resume", SID])).toBeNull();
    expect(geminiSessionOf(["node", "/home/u/.local/bin/gemini", "--resume", "latest"])).toBeNull();
    expect(geminiSessionOf(["node", "/srv/other.js", "--resume", SID])).toBeNull();
  });

  it("offers the fixed model list", () => {
    expect(GEMINI_MODELS.map((m) => m.key).slice(0, 4)).toEqual(["auto", "pro", "flash", "flash-lite"]);
  });
});

describe("gemini session listing", () => {
  let home: string;
  let proj: string;
  const prevHome = process.env.GEMINI_CLI_HOME;
  const prevAgentU = process.env.AGENT_U_HOME;

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-home-"));
    proj = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-proj-"));
    process.env.GEMINI_CLI_HOME = home;
    process.env.AGENT_U_HOME = path.join(home, "agent-u");
    const root = path.join(home, ".gemini");
    fs.mkdirSync(path.join(root, "tmp", "my-proj", "chats", SID), { recursive: true });
    fs.writeFileSync(path.join(root, "projects.json"), JSON.stringify({ projects: { [proj]: "my-proj" } }));
    fs.writeFileSync(path.join(root, "tmp", "my-proj", ".project_root"), proj);
    const chats = path.join(root, "tmp", "my-proj", "chats");
    fs.writeFileSync(path.join(chats, `session-2026-10-18T10-00-${SID.slice(0, 8)}.jsonl`), jsonl(header, user("u1", "fix the build"), { id: "g1", type: "gemini", content: "Fixed.", model: "gemini-3.5-flash" }));
    /* a subagent's chat, nested under its parent: not a session of its own */
    fs.writeFileSync(path.join(chats, SID, "session-2026-10-18T10-01-aaaaaaaa.jsonl"), jsonl({ ...header, sessionId: "aaaaaaaa-0000-4000-8000-000000000000", kind: "subagent" }, user("s1", "sub")));
    /* a folder without .project_root falls back to projects.json */
    fs.mkdirSync(path.join(root, "tmp", "other", "chats"), { recursive: true });
    const other = "bbbbbbbb-0000-4000-8000-000000000000";
    fs.writeFileSync(path.join(root, "projects.json"), JSON.stringify({ projects: { [proj]: "my-proj", "/srv/other": "other" } }));
    fs.writeFileSync(path.join(root, "tmp", "other", "chats", "session-2026-10-17T09-00-bbbbbbbb.jsonl"), jsonl({ ...header, sessionId: other }, user("u1", "old one"), { $set: { summary: "Older chat" } }));
    fs.utimesSync(path.join(root, "tmp", "other", "chats", "session-2026-10-17T09-00-bbbbbbbb.jsonl"), new Date("2026-10-17"), new Date("2026-10-17"));
  });

  afterAll(() => {
    if (prevHome === undefined) delete process.env.GEMINI_CLI_HOME;
    else process.env.GEMINI_CLI_HOME = prevHome;
    if (prevAgentU === undefined) delete process.env.AGENT_U_HOME;
    else process.env.AGENT_U_HOME = prevAgentU;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  });

  it("lists main chats with their project folder and title, newest first", async () => {
    const { default: gemini } = await import("@/lib/server/agents/gemini");
    const list = await gemini.list();
    expect(list.map((s) => s.id)).toEqual([SID, "bbbbbbbb-0000-4000-8000-000000000000"]);
    expect(list[0]).toMatchObject({ title: "fix the build", cwd: proj, model: "gemini-3.5-flash" });
    expect(list[1]).toMatchObject({ title: "Older chat", cwd: "/srv/other" });
    expect(await gemini.get("aaaaaaaa-0000-4000-8000-000000000000")).toBeNull();
  });

  it("pages history and watches for changes", async () => {
    const { default: gemini } = await import("@/lib/server/agents/gemini");
    const page = await gemini.history(SID, null);
    expect(page.entries.map((e) => e.kind)).toEqual(["user", "text"]);
    expect(page.end).toBe("2");
    const file = path.join(home, ".gemini", "tmp", "my-proj", "chats", `session-2026-10-18T10-00-${SID.slice(0, 8)}.jsonl`);
    const got: Entry[] = [];
    const stop = gemini.watch(SID, page.end, (e) => got.push(...e));
    await new Promise((r) => setTimeout(r, 100));
    fs.appendFileSync(file, jsonl(user("u2", "and the tests"), { id: "g2", type: "gemini", content: "", toolCalls: [shellCall("executing")] }));
    await new Promise((r) => setTimeout(r, 1300));
    fs.appendFileSync(file, jsonl({ id: "g2", type: "gemini", content: "", toolCalls: [shellCall("success", { resultDisplay: "ok" })] }));
    await new Promise((r) => setTimeout(r, 1300));
    stop();
    expect(got.map((e) => e.id)).toEqual(["u2:x", "g2:call-1", "g2:call-1:r"]);
  });
});

describe("agy models output", () => {
  it("parses slug and name columns separated by two or more spaces", () => {
    const out = ["\x1b[1mAvailable models\x1b[0m", "SLUG                NAME", "gemini-3.5-pro      Gemini 3.5 Pro", "claude-sonnet-5  Claude Sonnet 5 (Thinking)", "Error: something odd"].join("\n");
    expect(spacedRows(out)).toEqual([
      { key: "gemini-3.5-pro", name: "Gemini 3.5 Pro" },
      { key: "claude-sonnet-5", name: "Claude Sonnet 5 (Thinking)" },
    ]);
    expect(spacedRows("Authentication required. Please sign in.")).toEqual([]);
  });
});
