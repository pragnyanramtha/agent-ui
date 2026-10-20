import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import type { Entry } from "@/lib/types";

/* GET /api/sessions/[id]/export over real stores in temp homes: a Gemini chat long enough to need several
 * history pages, and a Claude transcript that spans more than one readHistory window. */

const SID = "3f2a9c1e-1111-4222-8333-444455556666";
const CLAUDE_ID = "7b1c2d3e-aaaa-4bbb-8ccc-ddddeeeeffff";
const jsonl = (recs: unknown[]) => recs.map((r) => JSON.stringify(r)).join("\n") + "\n";
const TURNS = 300;

const env = ["GEMINI_CLI_HOME", "CLAUDE_HOME", "AGENT_U_HOME", "AGENT_U_CONFIG"] as const;
const prev = Object.fromEntries(env.map((k) => [k, process.env[k]]));
let home: string;
let proj: string;
let GET: typeof import("@/app/api/sessions/[id]/export/route").GET;

const call = (id: string, query = "") =>
  GET(new NextRequest(`http://localhost/api/sessions/${id}/export${query}`), { params: Promise.resolve({ id }) });

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "export-home-"));
  proj = fs.mkdtempSync(path.join(os.tmpdir(), "export-proj-"));
  process.env.GEMINI_CLI_HOME = home;
  process.env.CLAUDE_HOME = path.join(home, ".claude");
  process.env.AGENT_U_HOME = path.join(home, "agent-u");
  process.env.AGENT_U_CONFIG = path.join(home, "agent-u", "config.json");

  const root = path.join(home, ".gemini");
  const chats = path.join(root, "tmp", "my-proj", "chats");
  fs.mkdirSync(chats, { recursive: true });
  fs.writeFileSync(path.join(root, "projects.json"), JSON.stringify({ projects: { [proj]: "my-proj" } }));
  fs.writeFileSync(path.join(root, "tmp", "my-proj", ".project_root"), proj);
  const recs: unknown[] = [{ sessionId: SID, projectHash: "abc", startTime: "2026-10-18T10:00:00.000Z", lastUpdated: "2026-10-18T10:05:00.000Z", kind: "main" }];
  for (let i = 0; i < TURNS; i++) {
    const t = new Date(Date.UTC(2026, 9, 18, 10, 0, i)).toISOString();
    recs.push({ id: `u${i}`, timestamp: t, type: "user", content: `question ${i}` });
    recs.push({
      id: `g${i}`,
      timestamp: t,
      type: "gemini",
      content: `answer ${i}`,
      toolCalls: i === 0 ? [{ id: "call-1", name: "run_shell_command", args: { command: "ls -la", dir_path: proj }, status: "success", resultDisplay: "a.txt" }] : [],
    });
  }
  recs.push({ $set: { summary: "Long chat: 300 turns" } });
  fs.writeFileSync(path.join(chats, `session-2026-10-18T10-00-${SID.slice(0, 8)}.jsonl`), jsonl(recs));

  /* ~4 MB: more than one 2.5 MB history window */
  const dir = path.join(home, ".claude", "projects", "-tmp-proj");
  fs.mkdirSync(dir, { recursive: true });
  const filler = "x".repeat(20_000);
  const claude: unknown[] = [{ type: "custom-title", customTitle: "Big Claude run", sessionId: CLAUDE_ID }];
  let parent: string | null = null;
  for (let i = 0; i < 100; i++) {
    const t = new Date(Date.UTC(2026, 9, 17, 9, 0, i)).toISOString();
    const u = `user-${i}`;
    const a = `asst-${i}`;
    claude.push({ type: "user", uuid: u, parentUuid: parent, timestamp: t, cwd: "/tmp/proj", sessionId: CLAUDE_ID, message: { role: "user", content: `turn ${i}` }, origin: { kind: "human" } });
    claude.push({ type: "assistant", uuid: a, parentUuid: u, timestamp: t, cwd: "/tmp/proj", sessionId: CLAUDE_ID, message: { id: `msg_${i}`, role: "assistant", model: "claude-x", content: [{ type: "text", text: `reply ${i} ${filler}` }], usage: { input_tokens: 1, output_tokens: 1 } } });
    parent = a;
  }
  fs.writeFileSync(path.join(dir, `${CLAUDE_ID}.jsonl`), jsonl(claude));

  ({ GET } = await import("@/app/api/sessions/[id]/export/route"));
});

afterAll(() => {
  for (const k of env) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
});

describe("session export route", () => {
  it("downloads every page of a Gemini chat as Markdown", async () => {
    const { default: gemini } = await import("@/lib/server/agents/gemini");
    /* the latest page alone doesn't reach the start */
    expect((await gemini.history(SID, null)).cursor).not.toBeNull();

    const res = await call(`gemini:${SID}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="long-chat-300-turns-2026-10-18.md"');
    const md = await res.text();
    expect(md.startsWith(`# Long chat: 300 turns\n\n- Agent: Gemini CLI\n- Folder: \`${proj}\`\n`)).toBe(true);
    expect(md).toContain("## User\n\nquestion 0\n\n## Gemini CLI\n\nanswer 0\n\n- Ran `ls -la`\n\n## User\n\nquestion 1");
    expect(md).toContain(`question ${TURNS - 1}`);
    expect(md.match(/^## User$/gm)).toHaveLength(TURNS);
    expect(md.indexOf("question 0\n")).toBeLessThan(md.indexOf("question 1\n"));
  });

  it("downloads JSON with all entries in order", async () => {
    const res = await call(`gemini:${SID}`, "?format=json");
    expect(res.headers.get("content-disposition")).toMatch(/filename="long-chat-300-turns-2026-10-18\.json"/);
    const body = (await res.json()) as { format: string; agent: string; title: string; cwd: string; entries: Entry[] };
    expect(body).toMatchObject({ format: "agent-u-session", agent: "gemini", title: "Long chat: 300 turns", cwd: proj });
    const users = body.entries.filter((e) => e.kind === "user").map((e) => (e as { text: string }).text);
    expect(users).toEqual(Array.from({ length: TURNS }, (_, i) => `question ${i}`));
    expect(new Set(body.entries.map((e) => e.id)).size).toBe(body.entries.length);
  });

  it("walks a Claude transcript back past its first history page", async () => {
    const res = await call(CLAUDE_ID, "?format=json");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string; cwd: string; entries: Entry[] };
    expect(body).toMatchObject({ title: "Big Claude run", cwd: "/tmp/proj" });
    expect(body.entries.filter((e) => e.kind === "user")).toHaveLength(100);
    /* one usage entry per message, not per page */
    expect(body.entries.filter((e) => e.kind === "usage")).toHaveLength(100);
    const md = await (await call(CLAUDE_ID, "?tools=none")).text();
    expect(md).toContain("## User\n\nturn 0\n\n## Claude\n\nreply 0 ");
  });

  it("rejects bad options and unknown sessions", async () => {
    expect((await call(`gemini:${SID}`, "?format=pdf")).status).toBe(400);
    expect((await call(`gemini:${SID}`, "?tools=some")).status).toBe(400);
    expect((await call("gemini:00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await call("nope:abc")).status).toBe(404);
    expect((await call("../../etc")).status).toBe(404);
    expect((await call("00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });
});
