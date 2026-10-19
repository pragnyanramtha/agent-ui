import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agyRow, agyTranscriptEntries, decodeArgs, mapAgyTool, readSummaries, summaryEntries, toMs, userRequest } from "@/lib/server/agents/antigravity-store";
import { agyArgs, agySessionOf, agyStreamParser, friendlyAgyError } from "@/lib/server/agents/antigravity";

const CID = "0b6c2f6e-7a1d-4f0e-9a51-2c7d1e9f3a10";
const jsonl = (...recs: unknown[]) => recs.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n";

describe("agy stream-json", () => {
  it("learns the conversation, streams text per step and reports the result", () => {
    const ids: string[] = [];
    const text: [string | number, string][] = [];
    const results: { ok: boolean; status: string; error: string | null }[] = [];
    const p = agyStreamParser({ init: (id) => ids.push(id), text: (s, t) => text.push([s, t]), result: (r) => results.push(r) });
    const step = (step_index: number, step_type: string, extra: Record<string, unknown> = {}) => ({ event: "step_update", step_update: { conversation_id: CID, step_index, state: "ACTIVE", step_type, ...extra } });
    for (const ev of [
      { event: "init", conversation_id: CID, init: { cwd: "/proj", tools: [], permission_mode: "default" } },
      step(0, "user_input"),
      step(1, "agent_response", { text_delta: "Looking " }),
      step(1, "agent_response", { text_delta: "now." }),
      step(2, "tool", { tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "ls" }, output: "a" } }),
      step(3, "agent_response", { text_delta: "Done." }),
      { event: "result", result: { conversation_id: CID, status: "SUCCESS", response: "Done.", usage: { input_tokens: 10 } } },
    ])
      p(JSON.stringify(ev));
    p("garbage");
    expect(ids).toEqual([CID]);
    expect(text).toEqual([
      [1, "Looking "],
      [1, "now."],
      [3, "Done."],
    ]);
    expect(results).toEqual([expect.objectContaining({ ok: true, status: "SUCCESS", error: null })]);
  });

  it("turns an ERROR result into an error message", () => {
    const results: { ok: boolean; error: string | null }[] = [];
    const p = agyStreamParser({ text: () => {}, result: (r) => results.push(r) });
    p(JSON.stringify({ event: "result", result: { status: "ERROR", error: { message: "model overloaded" } } }));
    p(JSON.stringify({ event: "result", result: { status: "ERROR" } }));
    p(JSON.stringify({ event: "result", result: { status: "CANCELED" } }));
    expect(results.map((r) => [r.ok, r.error])).toEqual([
      [false, "model overloaded"],
      [false, "Antigravity ended the turn (error)."],
      [true, null],
    ]);
    expect(friendlyAgyError("Authentication required. Open the link to sign in.")).toBe("Antigravity isn't signed in. Run agy on the server once to sign in.");
  });

  it("builds turn arguments for each mode", () => {
    expect(agyArgs("hi", { mode: "bypassPermissions" })).toEqual(["--output-format", "stream-json", "--dangerously-skip-permissions", "-p", "hi"]);
    expect(agyArgs("hi", { mode: "acceptEdits", conversation: CID, model: "gemini-3.5-pro" })).toEqual(["--output-format", "stream-json", "--conversation", CID, "--model", "gemini-3.5-pro", "--mode", "accept-edits", "-p", "hi"]);
    expect(agyArgs("hi", { mode: "plan" })).toContain("plan");
    expect(agyArgs("hi", { mode: "default" })).toEqual(["--output-format", "stream-json", "-p", "hi"]);
    /* never mistaken for a flag */
    expect(agyArgs("--help me", { mode: "default" }).at(-1)).toBe(" --help me");
    const long = agyArgs("x".repeat(70 * 1024), { mode: "default" }).at(-1)!;
    expect(long.length).toBeLessThan(500);
    const file = /Read it from (\S+)/.exec(long)?.[1];
    expect(file && fs.readFileSync(file, "utf8").length).toBe(70 * 1024);
  });

  it("finds interactive conversations from the process command line", () => {
    expect(agySessionOf(["/home/u/.local/bin/agy", "--conversation", CID])).toBe(CID);
    expect(agySessionOf(["agy", `--conversation=${CID}`, "--model", "x"])).toBe(CID);
    expect(agySessionOf(["agy", "--conversation", CID, "-p", "hi"])).toBeNull();
    expect(agySessionOf(["agy"])).toBeNull();
    expect(agySessionOf(["/usr/bin/vim", "--conversation", CID])).toBeNull();
  });
});

describe("agy transcript", () => {
  const raw = jsonl(
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-10-18T10:00:00Z", content: "<USER_REQUEST>\nfix the tests\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is ...\n</ADDITIONAL_METADATA>" },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: 1792317601, thinking: "Run them first.", content: "I'll run the tests.", tool_calls: [
      { name: "run_command", args: { CommandLine: '"pnpm test"', Cwd: '"/proj"' } },
      { name: "view_file", args: JSON.stringify({ AbsolutePath: "/proj/a.ts", StartLine: 10, EndLine: 19 }) },
    ] },
    "{ broken line",
    { step_index: 2, source: "MODEL", type: "CHECKPOINT", status: "DONE" },
    { step_index: 3, source: "SYSTEM", type: "RUN_COMMAND", status: "DONE", content: { output: "1 failed" } },
    { step_index: 4, source: "SYSTEM", type: "VIEW_FILE", status: "ERROR", content: "no such file" },
    { step_index: 5, source: "MODEL", type: "PLANNER_RESPONSE", content: "Editing.", tool_calls: [
      { name: "multi_replace_file_content", args: { TargetFile: "/proj/a.ts", ReplacementChunks: JSON.stringify([{ TargetContent: "a", ReplacementContent: "b" }]) } },
    ] },
    { step_index: 6, type: "CODE_ACTION", status: "DONE", content: "applied" },
    { step_index: 7, type: "ERROR_MESSAGE", content: "Rate limited, retrying" },
    { step_index: 8, type: "SOMETHING_NEW", content: { weird: true } },
    { step_index: 9, type: "USER_INPUT", content: "plain follow-up" },
    [1, 2, 3],
  );
  const entries = agyTranscriptEntries(raw);
  const byId = (id: string) => entries.find((e) => e.id === id);

  it("extracts the user's request without the metadata", () => {
    expect(byId("s0:u")).toMatchObject({ kind: "user", text: "fix the tests" });
    expect(byId("s9:u")).toMatchObject({ kind: "user", text: "plain follow-up" });
    expect(userRequest("<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>\nhello")).toBe("hello");
  });

  it("maps planner steps to thinking, text and tool calls, and later steps to their results in order", () => {
    expect(byId("s1:t")).toMatchObject({ kind: "thinking", text: "Run them first." });
    expect(byId("s1:x")).toMatchObject({ kind: "text", text: "I'll run the tests." });
    expect(byId("s1:x")?.ts).toBe(new Date(1792317601 * 1000).toISOString());
    expect(byId("s1:c0")).toMatchObject({ kind: "tool", name: "Bash", input: { command: "pnpm test", cwd: "/proj" } });
    expect(byId("s1:c1")).toMatchObject({ name: "Read", input: { file_path: "/proj/a.ts", offset: 10, limit: 10 } });
    expect(byId("s1:c0:r")).toMatchObject({ kind: "result", toolUseId: "s1:c0", result: { text: "1 failed", isError: false } });
    expect(byId("s1:c1:r")).toMatchObject({ result: { text: "no such file", isError: true } });
    expect(byId("s5:c0")).toMatchObject({ name: "MultiEdit", input: { file_path: "/proj/a.ts", edits: [{ old_string: "a", new_string: "b" }] } });
    expect(byId("s5:c0:r")).toMatchObject({ result: { text: "applied" } });
    expect(byId("s7:x")).toMatchObject({ kind: "notice", tone: "warn", text: "Rate limited, retrying" });
    expect(entries.some((e) => e.id.startsWith("s8"))).toBe(false);
  });

  it("never pairs a result with a call from an earlier step or turn", () => {
    const out = agyTranscriptEntries(
      jsonl(
        { step_index: 0, type: "CORTEX_STEP_TYPE_USER_INPUT", content: "<USER_REQUEST>run ls</USER_REQUEST>" },
        { step_index: 1, type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE", content: "ok", tool_calls: [{ name: "run_command", args: { CommandLine: "ls" } }] },
        { step_index: 2, type: "CORTEX_STEP_TYPE_USER_INPUT", content: "<USER_REQUEST>never mind, run pwd</USER_REQUEST>" },
        { step_index: 3, type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE", content: "", tool_calls: [{ name: "run_command", args: { CommandLine: "pwd" } }] },
        { step_index: 4, type: "CORTEX_STEP_TYPE_SOMETHING_NEW", content: { output: "not a result" } },
        { step_index: 5, type: "CORTEX_STEP_TYPE_RUN_COMMAND", status: "DONE", content: { output: "/home/u" } },
        { step_index: 6, type: "PLANNER_RESPONSE", content: "", tool_calls: [{ name: "view_file", args: {} }] },
        { step_index: 7, type: "PLANNER_RESPONSE", content: "", tool_calls: [{ name: "custom_tool", args: {} }] },
        { step_index: 8, type: "CUSTOM_TOOL", content: "custom output" },
      ),
    );
    const results = out.filter((e) => e.kind === "result").map((e) => e.kind === "result" && [e.toolUseId, e.result.text]);
    expect(results).toEqual([
      ["s3:c0", "/home/u"],
      ["s7:c0", "custom output"],
    ]);
  });

  it("never throws on junk", () => {
    expect(agyTranscriptEntries("")).toEqual([]);
    expect(agyTranscriptEntries("null\n[]\n{}\n{\"type\":5}\n")).toEqual([]);
    expect(agyTranscriptEntries(jsonl({ type: "PLANNER_RESPONSE", tool_calls: "nope", content: { text: "hi" } }))).toHaveLength(1);
  });

  it("maps tools with tolerant keys", () => {
    expect(mapAgyTool("write_to_file", { TargetFile: "/a", CodeContent: "x" })).toEqual({ name: "Write", input: { file_path: "/a", content: "x" } });
    expect(mapAgyTool("replace_file_content", { target_file: "/a", targetContent: "x", ReplacementContent: "y" })).toEqual({ name: "Edit", input: { file_path: "/a", old_string: "x", new_string: "y" } });
    expect(mapAgyTool("list_dir", { DirectoryPath: "/p" })).toEqual({ name: "LS", input: { path: "/p" } });
    expect(mapAgyTool("grep_search", { Query: "TODO", SearchPath: "/p", Includes: ["*.ts", "*.tsx"] })).toEqual({ name: "Grep", input: { pattern: "TODO", path: "/p", glob: "*.ts,*.tsx" } });
    expect(mapAgyTool("search_web", { query: "q" })).toEqual({ name: "WebSearch", input: { query: "q" } });
    expect(mapAgyTool("read_url_content", { Url: "https://x" })).toEqual({ name: "WebFetch", input: { url: "https://x" } });
    expect(mapAgyTool("browser_open", { a: 1 })).toEqual({ name: "browser_open", input: { a: 1 } });
    expect(decodeArgs("not json")).toEqual({ value: "not json" });
    expect(decodeArgs({ a: "{oops", b: "[1]" })).toEqual({ a: "{oops", b: [1] });
  });
});

describe("agy summaries", () => {
  it("normalizes timestamps", () => {
    const ms = Date.parse("2026-10-18T10:00:00Z");
    expect(toMs(ms / 1000)).toBe(ms);
    expect(toMs(ms)).toBe(ms);
    expect(toMs(ms * 1000)).toBe(ms);
    expect(toMs(String(ms))).toBe(ms);
    expect(toMs("2026-10-18T10:00:00Z")).toBe(ms);
    expect(toMs({ seconds: ms / 1000, nanos: 5e6 })).toBe(ms + 5);
    expect(toMs(null)).toBe(0);
  });

  it("keeps top-level CLI rows only", () => {
    const base = { conversation_id: CID, title: "T", workspace_uris: JSON.stringify(["file:///home/u/my%20proj"]), nesting_depth: 0, app_data_dir: "antigravity-cli", last_modified_time: 1792317600 };
    expect(agyRow(base)).toMatchObject({ id: CID, cwd: "/home/u/my proj", mtime: 1792317600000 });
    expect(agyRow({ ...base, nesting_depth: 1 })).toBeNull();
    expect(agyRow({ ...base, app_data_dir: "antigravity" })).toBeNull();
    expect(agyRow({ ...base, app_data_dir: null, workspace_uris: "not json" })).toMatchObject({ cwd: "not json" });
    expect(agyRow({ title: "no id" })).toBeNull();
    expect(summaryEntries(agyRow({ ...base, preview: "P" })!)[0]).toMatchObject({ kind: "notice", text: "Transcript not available. T: P" });
  });

  const sqlite = process.getBuiltinModule?.("node:sqlite") as typeof import("node:sqlite") | undefined;

  describe.skipIf(!sqlite)("from a real SQLite file", () => {
    let home: string;
    const prevHome = process.env.HOME;
    const prevAgentU = process.env.AGENT_U_HOME;

    beforeAll(() => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-home-"));
      process.env.HOME = home;
      process.env.AGENT_U_HOME = path.join(home, "agent-u");
      const dir = path.join(home, ".gemini", "antigravity-cli");
      fs.mkdirSync(path.join(dir, "brain", CID, ".system_generated", "logs"), { recursive: true });
      const db = new sqlite!.DatabaseSync(path.join(dir, "conversation_summaries.db"));
      db.exec(
        "CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT, step_count INTEGER, last_modified_time INTEGER, workspace_uris TEXT, status TEXT, nesting_depth INTEGER, app_data_dir TEXT, extra TEXT)",
      );
      const ins = db.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      ins.run(CID, "Fix tests", "fix the tests", 5, 1792317600000, JSON.stringify([`file://${home}/proj`]), "IDLE", 0, "antigravity-cli", null);
      ins.run("older-1", "", "an older preview\nsecond line", 2, 1792231200, "[]", "IDLE", 0, "antigravity-cli", null);
      ins.run("sub-1", "Subagent", "", 1, 1792317700000, "[]", "IDLE", 1, "antigravity-cli", null);
      ins.run("ide-1", "From the IDE", "", 1, 1792317800000, "[]", "IDLE", 0, "antigravity", null);
      db.close();
      fs.writeFileSync(
        path.join(dir, "brain", CID, ".system_generated", "logs", "transcript_full.jsonl"),
        jsonl({ step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>fix the tests</USER_REQUEST>" }, { step_index: 1, type: "PLANNER_RESPONSE", content: "On it." }),
      );
      const t = new Date(1792317600000);
      fs.utimesSync(path.join(dir, "brain", CID, ".system_generated", "logs", "transcript_full.jsonl"), t, t);
    });

    afterAll(() => {
      process.env.HOME = prevHome;
      if (prevAgentU === undefined) delete process.env.AGENT_U_HOME;
      else process.env.AGENT_U_HOME = prevAgentU;
      fs.rmSync(home, { recursive: true, force: true });
    });

    it("reads rows read-only, filtered and newest first", () => {
      const rows = readSummaries(path.join(home, ".gemini", "antigravity-cli", "conversation_summaries.db"));
      expect(rows.map((r) => r.id)).toEqual([CID, "older-1"]);
      expect(rows[0]).toMatchObject({ title: "Fix tests", cwd: path.join(home, "proj"), steps: 5 });
      expect(rows[1].mtime).toBe(1792231200000);
      expect(readSummaries(path.join(home, "missing.db"))).toEqual([]);
    });

    it("lists sessions and reads history, with the summary standing in for a missing transcript", async () => {
      const { default: agy } = await import("@/lib/server/agents/antigravity");
      const list = await agy.list();
      expect(list.map((s) => [s.id, s.title])).toEqual([
        [CID, "Fix tests"],
        ["older-1", "an older preview"],
      ]);
      expect((await agy.history(CID, null)).entries.map((e) => e.kind)).toEqual(["user", "text"]);
      expect((await agy.history("older-1", null)).entries).toEqual([expect.objectContaining({ kind: "notice", text: "Transcript not available. an older preview\nsecond line" })]);
      expect(await agy.get("sub-1")).toBeNull();
    });

    it("won't resume a conversation whose folder is unknown or gone", async () => {
      const prevBin = process.env.AGY_BIN;
      process.env.AGY_BIN = "/bin/sh";
      try {
        const { default: agy } = await import("@/lib/server/agents/antigravity");
        await expect(agy.send(CID, "hi", { mode: "bypassPermissions" })).rejects.toThrow(`This session's folder is gone: ${path.join(home, "proj")}`);
        await expect(agy.send("older-1", "hi", { mode: "bypassPermissions" })).rejects.toThrow("Can't find this session's folder.");
        await expect(agy.send("nope", "hi", { mode: "bypassPermissions" })).rejects.toThrow(/not found/);
      } finally {
        if (prevBin === undefined) delete process.env.AGY_BIN;
        else process.env.AGY_BIN = prevBin;
      }
    });
  });
});
