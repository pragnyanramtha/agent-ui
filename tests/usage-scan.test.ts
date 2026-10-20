import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { usageReport as ReportFn, resetUsageCache as ResetFn } from "@/lib/server/usage";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentu-usage-"));
const CLAUDE_HOME = path.join(root, "claude");
const CODEX_HOME = path.join(root, "codex");
const NOW = Date.UTC(2026, 9, 19, 12, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const jsonl = (...recs: unknown[]) => recs.map((r) => JSON.stringify(r)).join("\n") + "\n";

const ids = {
  alpha: "11111111-1111-4111-8111-111111111111",
  hidden: "22222222-2222-4222-8222-222222222222",
  stale: "33333333-3333-4333-8333-333333333333",
  codex: "44444444-4444-4444-8444-444444444444",
  sub: "55555555-5555-4555-8555-555555555555",
};

const user = (uuid: string, ts: number, text: string) => ({ type: "user", uuid, timestamp: iso(ts), cwd: "/work/alpha", message: { role: "user", content: text } });
const assistant = (uuid: string, ts: number, msg: string, output: number, extra: Record<string, unknown> = {}) => ({
  type: "assistant",
  uuid,
  timestamp: iso(ts),
  cwd: "/work/alpha",
  message: { id: msg, role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: output } },
  ...extra,
});

function write(file: string, text: string, mtime = NOW) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.utimesSync(file, new Date(mtime), new Date(mtime));
}

const alphaFile = path.join(CLAUDE_HOME, "projects", "-work-alpha", `${ids.alpha}.jsonl`);
const codexFile = path.join(CODEX_HOME, "sessions", "2026", "10", "19", `rollout-2026-10-19T10-00-00-${ids.codex}.jsonl`);

let usageReport: typeof ReportFn;
let resetUsageCache: typeof ResetFn;

beforeAll(async () => {
  write(
    alphaFile,
    jsonl(
      { type: "ai-title", aiTitle: "Alpha refactor" },
      user("u1", NOW - 3_600_000, "refactor the widget"),
      /* one API message written once per content block: counted once, with the last copy's numbers */
      assistant("a1", NOW - 3_500_000, "msg_1", 10),
      assistant("a2", NOW - 3_500_000, "msg_1", 1000),
      assistant("a3", NOW - 3_400_000, "msg_2", 500, { isSidechain: true }),
      { ...assistant("a4", NOW - 3_300_000, "msg_3", 99), message: { ...assistant("a4", 0, "msg_3", 99).message, model: "<synthetic>" } },
      assistant("a5", NOW - 2 * 86_400_000, "msg_4", 2000),
    ),
  );
  write(path.join(CLAUDE_HOME, "projects", "-work-secret-stuff", `${ids.hidden}.jsonl`), jsonl(user("u1", NOW - 1000, "hi"), assistant("a1", NOW - 900, "msg_h", 5000)));
  /* untouched for longer than the widest range: never opened */
  write(path.join(CLAUDE_HOME, "projects", "-work-alpha", `${ids.stale}.jsonl`), jsonl(assistant("a1", NOW - 200 * 86_400_000, "msg_s", 7000)), NOW - 200 * 86_400_000);
  write(
    codexFile,
    jsonl(
      { timestamp: iso(NOW - 7_200_000), type: "session_meta", payload: { id: ids.codex, cwd: "/work/beta", timestamp: iso(NOW - 7_200_000) } },
      { timestamp: iso(NOW - 7_100_000), type: "turn_context", payload: { model: "gpt-5.4" } },
      { timestamp: iso(NOW - 7_000_000), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "add a test" }] } },
      { timestamp: iso(NOW - 6_900_000), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 3000, cached_input_tokens: 1000, output_tokens: 400 }, total_token_usage: { total_tokens: 3400 } } } },
      /* the same running total again (turn end): not a new request */
      { timestamp: iso(NOW - 6_800_000), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 3000, cached_input_tokens: 1000, output_tokens: 400 }, total_token_usage: { total_tokens: 3400 } } } },
    ),
  );
  write(
    path.join(CODEX_HOME, "sessions", "2026", "10", "19", `rollout-2026-10-19T11-00-00-${ids.sub}.jsonl`),
    jsonl(
      { timestamp: iso(NOW - 600_000), type: "session_meta", payload: { id: ids.sub, cwd: "/work/beta", thread_source: "subagent" } },
      { timestamp: iso(NOW - 500_000), type: "turn_context", payload: { model: "gpt-5.4" } },
      { timestamp: iso(NOW - 400_000), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 9000, output_tokens: 9 }, total_token_usage: { total_tokens: 9009 } } } },
    ),
  );
  process.env.CLAUDE_HOME = CLAUDE_HOME;
  process.env.CODEX_HOME = CODEX_HOME;
  process.env.HIDE_PROJECTS = "secret-stuff";
  process.env.XDG_DATA_HOME = path.join(root, "data");
  process.env.CURSOR_CONFIG_DIR = path.join(root, "cursor");
  process.env.KIMI_CODE_HOME = path.join(root, "kimi");
  process.env.GEMINI_CLI_HOME = path.join(root, "gemini");
  process.env.AGENT_U_HOME = path.join(root, "agent-u");
  process.env.AGENT_U_CONFIG = path.join(root, "agent-u", "config.json");
  fs.mkdirSync(process.env.AGENT_U_HOME, { recursive: true });
  fs.writeFileSync(path.join(process.env.AGENT_U_HOME, "state.json"), JSON.stringify({ sessionProfiles: { [`codex:${ids.codex}`]: "codx" }, sessionMeta: {} }));
  ({ usageReport, resetUsageCache } = await import("@/lib/server/usage"));
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("usage across sessions", () => {
  it("reads Claude and Codex usage, deduped, skipping sidechains, subagents, hidden and stale sessions", async () => {
    const r = await usageReport({ tz: "UTC", days: 30, now: NOW });
    expect(r.partial).toBe(false);
    const alpha = r.sessions.find((s) => s.key === ids.alpha)!;
    expect(alpha.title).toBe("Alpha refactor");
    expect(alpha.cwd).toBe("/work/alpha");
    expect(alpha.sum.calls).toBe(2);
    expect(alpha.sum.output).toBe(3000);
    const codex = r.sessions.find((s) => s.key === `codex:${ids.codex}`)!;
    expect(codex.agent).toBe("codex");
    expect(codex.profile).toBe("codx");
    expect(codex.title).toBe("add a test");
    expect(codex.sum).toMatchObject({ input: 2000, cacheRead: 1000, output: 400, calls: 1 });
    expect(r.sessions.map((s) => s.key).sort()).toEqual([ids.alpha, `codex:${ids.codex}`].sort());
    expect(r.totals.today.calls).toBe(2);
    expect(r.totals.week.calls).toBe(3);
  });

  it("reads only what was appended since the last time", async () => {
    const before = fs.statSync(alphaFile).size;
    fs.appendFileSync(alphaFile, jsonl(user("u9", NOW - 60_000, "more"), assistant("a9", NOW - 50_000, "msg_9", 7)));
    fs.utimesSync(alphaFile, new Date(NOW + 1000), new Date(NOW + 1000));
    const r = await usageReport({ tz: "UTC", days: 30, now: NOW });
    const alpha = r.sessions.find((s) => s.key === ids.alpha)!;
    expect(alpha.sum.calls).toBe(3);
    expect(alpha.sum.output).toBe(3007);
    /* rewriting what was already read would double it if the whole file were read again */
    expect(fs.statSync(alphaFile).size).toBeGreaterThan(before);
  });

  it("picks up a half-written last line once it is finished", async () => {
    const line = JSON.stringify(assistant("a10", NOW - 40_000, "msg_10", 1));
    fs.appendFileSync(alphaFile, line.slice(0, 40));
    fs.utimesSync(alphaFile, new Date(NOW + 2000), new Date(NOW + 2000));
    expect((await usageReport({ tz: "UTC", days: 30, now: NOW })).sessions.find((s) => s.key === ids.alpha)!.sum.calls).toBe(3);
    fs.appendFileSync(alphaFile, `${line.slice(40)}\n`);
    fs.utimesSync(alphaFile, new Date(NOW + 3000), new Date(NOW + 3000));
    expect((await usageReport({ tz: "UTC", days: 30, now: NOW })).sessions.find((s) => s.key === ids.alpha)!.sum.calls).toBe(4);
  });

  it("starts over when a file was rewritten shorter", async () => {
    write(alphaFile, jsonl({ type: "ai-title", aiTitle: "Alpha refactor" }, assistant("a1", NOW - 1000, "msg_x", 1)), NOW + 4000);
    const alpha = (await usageReport({ tz: "UTC", days: 30, now: NOW })).sessions.find((s) => s.key === ids.alpha)!;
    expect(alpha.sum.calls).toBe(1);
  });

  it("stops at the time budget and continues on the next ask", async () => {
    resetUsageCache();
    const cut = await usageReport({ tz: "UTC", days: 30, now: NOW, budgetMs: 0 });
    expect(cut.partial).toBe(true);
    expect(cut.pending).toBeGreaterThan(0);
    const full = await usageReport({ tz: "UTC", days: 30, now: NOW });
    expect(full.partial).toBe(false);
    expect(full.sessions).toHaveLength(2);
  });

  it("filters by agent, profile and project", async () => {
    expect((await usageReport({ tz: "UTC", days: 30, now: NOW, filters: { agent: "codex" } })).sessions.map((s) => s.agent)).toEqual(["codex"]);
    expect((await usageReport({ tz: "UTC", days: 30, now: NOW, filters: { profile: "claude" } })).sessions.map((s) => s.key)).toEqual([ids.alpha]);
    expect((await usageReport({ tz: "UTC", days: 30, now: NOW, filters: { project: "/work/beta" } })).sessions.map((s) => s.key)).toEqual([`codex:${ids.codex}`]);
  });
});
