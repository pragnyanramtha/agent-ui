import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { searchMessages as SearchFn, snippetAround as SnippetFn, hasRipgrep as HasRgFn } from "@/lib/server/search";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentu-search-"));
const CLAUDE_HOME = path.join(root, "claude");
const CODEX_HOME = path.join(root, "codex");
const GEMINI_HOME = path.join(root, "gemini-home");

const jsonl = (...recs: unknown[]) => recs.map((r) => JSON.stringify(r)).join("\n") + "\n";
const ids = {
  claudeOld: "11111111-1111-4111-8111-111111111111",
  claudeNew: "22222222-2222-4222-8222-222222222222",
  claudeTools: "33333333-3333-4333-8333-333333333333",
  claudeHidden: "44444444-4444-4444-8444-444444444444",
  claudeSpecial: "55555555-5555-4555-8555-555555555555",
  codex: "66666666-6666-4666-8666-666666666666",
  gemini: "77777777-7777-4777-8777-777777777777",
};
const T = (min: number) => new Date(Date.UTC(2026, 9, 18, 10, min)).toISOString();

function write(file: string, text: string, mtimeMin: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  const at = new Date(Date.UTC(2026, 9, 18, 10, mtimeMin));
  fs.utimesSync(file, at, at);
}

const claudeUser = (uuid: string, content: unknown, extra: Record<string, unknown> = {}) => ({ type: "user", uuid, timestamp: T(1), cwd: "/proj/alpha", message: { role: "user", content }, ...extra });
const claudeAssistant = (uuid: string, content: unknown[]) => ({ type: "assistant", uuid, timestamp: T(2), message: { id: `m-${uuid}`, role: "assistant", content } });

beforeAll(() => {
  const proj = path.join(CLAUDE_HOME, "projects", "-proj-alpha");
  write(
    path.join(proj, `${ids.claudeOld}.jsonl`),
    jsonl({ type: "ai-title", aiTitle: "Old widget chat" }, claudeUser("u1", "How do I frobnicate the widget?"), claudeAssistant("a1", [{ type: "text", text: "You frobnicate it gently." }])),
    1,
  );
  write(
    path.join(proj, `${ids.claudeNew}.jsonl`),
    jsonl(
      { type: "ai-title", aiTitle: "New widget chat" },
      claudeUser("u1", "unrelated opener"),
      claudeAssistant("a1", [{ type: "thinking", thinking: "thinking about it" }, { type: "text", text: `${"lead ".repeat(40)}the Frobnicate step is next${" tail".repeat(40)}` }]),
    ),
    5,
  );
  /* every occurrence of "zebracorn" is outside user or assistant text */
  write(
    path.join(proj, `${ids.claudeTools}.jsonl`),
    jsonl(
      { type: "ai-title", aiTitle: "Tools only" },
      claudeUser("u1", "run the thing"),
      claudeAssistant("a1", [{ type: "thinking", thinking: "zebracorn in my head" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "echo zebracorn" } }]),
      claudeUser("u2", [{ type: "tool_result", tool_use_id: "t1", content: "zebracorn printed" }]),
      claudeUser("u3", "zebracorn meta context", { isMeta: true }),
      claudeUser("u4", "hello <system-reminder>zebracorn reminder</system-reminder>"),
      { type: "system", subtype: "informational", uuid: "s1", content: "zebracorn notice" },
      { type: "assistant", uuid: "a3", isSidechain: true, timestamp: T(3), message: { id: "m3", role: "assistant", content: [{ type: "text", text: "zebracorn from a subagent" }] } },
    ),
    3,
  );
  write(path.join(CLAUDE_HOME, "projects", "-proj-secret-stuff", `${ids.claudeHidden}.jsonl`), jsonl({ type: "ai-title", aiTitle: "Hidden" }, claudeUser("u1", "frobnicate in a hidden project")), 9);
  write(
    path.join(proj, `${ids.claudeSpecial}.jsonl`),
    jsonl(
      { type: "ai-title", aiTitle: "Specials" },
      claudeUser("u1", 'Please run it with --files and say "hi" \\o/ then $(whoami) and a.b* literally'),
      claudeAssistant("a1", [{ type: "text", text: "Ünïcode Straße works; axbbb is not a.b-star" }]),
    ),
    2,
  );
  /* an unrelated file next to the sessions */
  write(path.join(proj, "not-a-session.jsonl"), jsonl(claudeUser("u1", "frobnicate")), 8);

  write(
    path.join(CODEX_HOME, "sessions", "2026", "10", "18", `rollout-2026-10-18T10-04-00-${ids.codex}.jsonl`),
    jsonl(
      { timestamp: T(4), type: "session_meta", payload: { id: ids.codex, cwd: "/proj/codex" } },
      { timestamp: T(4), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>frobnicate env</environment_context>" }] } },
      { timestamp: T(4), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "codex please frobnicate" }] } },
      { timestamp: T(4), type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "zebracorn from a shell" } },
      { timestamp: T(4), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] } },
    ),
    4,
  );

  const gemRoot = path.join(GEMINI_HOME, ".gemini");
  fs.mkdirSync(path.join(gemRoot, "tmp", "proj-gem"), { recursive: true });
  fs.writeFileSync(path.join(gemRoot, "tmp", "proj-gem", ".project_root"), "/proj/gem");
  write(
    path.join(gemRoot, "tmp", "proj-gem", "chats", "session-2026-10-18T10-06-77777777.jsonl"),
    jsonl(
      { sessionId: ids.gemini, projectHash: "x", startTime: T(6), lastUpdated: T(6), kind: "main" },
      { id: "g-u1", timestamp: T(6), type: "user", content: [{ text: "gemini, look at this" }] },
      {
        id: "g-m1",
        timestamp: T(6),
        type: "gemini",
        content: "Sure, I will frobnicate.",
        toolCalls: [{ id: "call-1", name: "run_shell_command", args: { command: "echo zebracorn" }, status: "success", resultDisplay: "zebracorn" }],
      },
      { $set: { summary: "Gemini frob" } },
    ),
    6,
  );

  process.env.CLAUDE_HOME = CLAUDE_HOME;
  process.env.CODEX_HOME = CODEX_HOME;
  process.env.GEMINI_CLI_HOME = GEMINI_HOME;
  process.env.HIDE_PROJECTS = "secret-stuff";
  process.env.AGENT_U_HOME = path.join(root, "agent-u");
  process.env.AGENT_U_CONFIG = path.join(root, "agent-u", "config.json");
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

let searchMessages: typeof SearchFn;
let snippetAround: typeof SnippetFn;
let hasRipgrep: typeof HasRgFn;
let rg = false;
beforeAll(async () => {
  ({ searchMessages, snippetAround, hasRipgrep } = await import("@/lib/server/search"));
  rg = await hasRipgrep();
});

const engines = ["auto", "node"] as const;

describe.each(engines)("searchMessages (%s)", (engine) => {
  const search = (q: string, o: Parameters<typeof SearchFn>[1] = {}) => searchMessages(q, { engine, ...o });

  it("uses ripgrep when it is on PATH", () => {
    if (engine === "auto") expect(rg).toBe(spawnSync("rg", ["--version"]).status === 0);
  });

  it("finds user and assistant text in every agent, newest session first", async () => {
    const { hits, partial } = await search("frobnicate");
    expect(partial).toBe(false);
    expect(hits.map((h) => h.key)).toEqual([`gemini:${ids.gemini}`, ids.claudeNew, `codex:${ids.codex}`, ids.claudeOld]);
    const [gem, newer, codex, older] = hits;
    expect(gem).toMatchObject({ agent: "gemini", title: "Gemini frob", cwd: "/proj/gem", role: "assistant", snippet: "Sure, I will frobnicate." });
    expect(codex).toMatchObject({ agent: "codex", title: "codex please frobnicate", cwd: "/proj/codex", role: "user" });
    expect(older).toMatchObject({ agent: "claude", title: "Old widget chat", cwd: "/proj/alpha", role: "user", ts: T(1) });
    expect(newer.title).toBe("New widget chat");
    expect(newer.snippet.startsWith("…")).toBe(true);
    expect(newer.snippet.endsWith("…")).toBe(true);
    expect(newer.snippet.length).toBeLessThanOrEqual(122);
    expect(newer.snippet.slice(...newer.match)).toBe("Frobnicate");
    for (const h of hits) expect(h.snippet.slice(...h.match).toLowerCase()).toBe("frobnicate");
  });

  it("leaves out deleted sessions", async () => {
    const { CONFIG_DIR, markSessionDeleted } = await import("@/lib/server/profiles");
    const state = path.join(CONFIG_DIR, "state.json");
    const before = fs.existsSync(state) ? fs.readFileSync(state) : null;
    markSessionDeleted(ids.claudeOld);
    try {
      expect((await search("frobnicate")).hits.map((h) => h.key)).toEqual([`gemini:${ids.gemini}`, ids.claudeNew, `codex:${ids.codex}`]);
    } finally {
      if (before) fs.writeFileSync(state, before);
      else fs.rmSync(state, { force: true });
    }
  });

  it("ignores tool calls, tool output, thinking, injected context, notices and subagents", async () => {
    expect((await search("zebracorn")).hits).toEqual([]);
    expect((await search("frobnicate env")).hits).toEqual([]);
  });

  it("skips hidden projects", async () => {
    const { hits } = await search("hidden project");
    expect(hits).toEqual([]);
  });

  it("honors the limit", async () => {
    const { hits } = await search("frobnicate", { limit: 2 });
    expect(hits.map((h) => h.key)).toEqual([`gemini:${ids.gemini}`, ids.claudeNew]);
  });

  it("stops at the time budget", async () => {
    expect(await search("frobnicate", { budgetMs: 0 })).toEqual({ hits: [], partial: true });
  });

  it("stops when cancelled", async () => {
    const ctl = new AbortController();
    ctl.abort();
    expect(await search("frobnicate", { signal: ctl.signal })).toEqual({ hits: [], partial: true });
  });

  it("treats the query literally, flags and quotes included", async () => {
    for (const q of ["--files", '"hi" \\o/', "$(whoami)", "a.b*", "-e frob", "ünïcode straße"]) {
      const { hits } = await search(q);
      const want = q === "-e frob" ? [] : [ids.claudeSpecial];
      expect(hits.map((h) => h.key), q).toEqual(want);
      for (const h of hits) expect(h.snippet.slice(...h.match).toLowerCase(), q).toBe(q.toLowerCase());
    }
  });

  it("needs at least two characters", async () => {
    expect(await search(" f ")).toEqual({ hits: [], partial: false });
  });
});

describe("snippetAround", () => {
  it("keeps short text whole", () => {
    expect(snippetAround("  find   me here ", 9, 2)).toEqual({ snippet: "find me here", match: [5, 7] });
  });

  it("centers long text on the match with ellipses", () => {
    const text = `${"a".repeat(300)}NEEDLE${"b".repeat(300)}`;
    const { snippet, match } = snippetAround(text, 300, 6);
    expect(snippet.slice(...match)).toBe("NEEDLE");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.length).toBe(122);
  });

  it("never leaves half a surrogate pair at the edges", () => {
    const text = `${"😀".repeat(100)}hit${"😀".repeat(100)}`;
    const { snippet, match } = snippetAround(text, 200, 3);
    expect(snippet.slice(...match)).toBe("hit");
    expect(/^…?[\uDC00-\uDFFF]|[\uD800-\uDBFF]…?$/.test(snippet)).toBe(false);
  });
});
