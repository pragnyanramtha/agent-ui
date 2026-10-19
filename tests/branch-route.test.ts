import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { fakes, init } from "./fake-claude-sdk";

/* POST /api/sessions/[id]/fork and /edit over a real Claude transcript in a temp home and a real git repository. */

vi.mock("@anthropic-ai/claude-agent-sdk", async () => ({ query: (await import("./fake-claude-sdk")).query }));

const SID = "c0ffee00-1111-4222-8333-444455556666";
const env = ["CLAUDE_HOME", "AGENT_U_HOME", "AGENT_U_CONFIG"] as const;
const prev = Object.fromEntries(env.map((k) => [k, process.env[k]]));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "branch-home-"));
const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "branch-repo-")));
process.env.CLAUDE_HOME = path.join(home, ".claude");
process.env.AGENT_U_HOME = path.join(home, "agent-u");
process.env.AGENT_U_CONFIG = path.join(home, "agent-u", "config.json");

const dir = path.join(home, ".claude", "projects", "-branch-repo");
const file = path.join(dir, `${SID}.jsonl`);
const at = (s: number) => new Date(Date.now() + s * 1000).toISOString();
let cpId = "";
let original = "";

const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString();

const { POST: fork } = await import("@/app/api/sessions/[id]/fork/route");
const { POST: edit } = await import("@/app/api/sessions/[id]/edit/route");
const { checkpoint, listCheckpoints } = await import("@/lib/server/git");
const { getRun } = await import("@/lib/server/runner");

const call = (route: typeof fork, id: string, body: unknown) =>
  route(new NextRequest(`http://localhost/api/sessions/${id}/x`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ id }) });

const records = (p: string) =>
  fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

beforeAll(async () => {
  git("init", "-q");
  fs.writeFileSync(path.join(repo, "a.txt"), "v1\n");
  git("add", ".");
  git("commit", "-qm", "init");
  const base = { cwd: repo, sessionId: SID, isSidechain: false };
  const recs = [
    { type: "custom-title", customTitle: "Pick a color", sessionId: SID },
    { ...base, type: "user", uuid: "u1", parentUuid: null, timestamp: at(-120), message: { role: "user", content: "one" }, origin: { kind: "human" } },
    { ...base, type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: at(-110), message: { id: "m1", role: "assistant", model: "x", content: [{ type: "text", text: "first" }] } },
    { ...base, type: "user", uuid: "u2", parentUuid: "a1", timestamp: at(60), message: { role: "user", content: "two" }, origin: { kind: "human" } },
    { ...base, type: "assistant", uuid: "a2", parentUuid: "u2", timestamp: at(61), message: { id: "m2", role: "assistant", model: "x", content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: path.join(repo, "a.txt"), old_string: "v1", new_string: "v2" } }] } },
    { ...base, type: "user", uuid: "r1", parentUuid: "a2", timestamp: at(62), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
    { ...base, type: "assistant", uuid: "a3", parentUuid: "r1", timestamp: at(63), message: { id: "m3", role: "assistant", model: "x", content: [{ type: "text", text: "second" }] } },
  ];
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  original = fs.readFileSync(file, "utf8");
  cpId = (await checkpoint(repo, SID, "two"))!.id;
  fs.writeFileSync(path.join(repo, "a.txt"), "v2\n");
});

afterAll(() => {
  for (const k of env) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("POST /api/sessions/[id]/fork", () => {
  it("copies the conversation through the reply's turn into a new Claude session, original untouched", async () => {
    const res = await call(fork, SID, { entryId: "a1:0" });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    expect(id).not.toBe(SID);
    const recs = records(path.join(dir, `${id}.jsonl`));
    expect(recs.map((r) => r.uuid ?? r.type)).toEqual(["custom-title", "u1", "a1", "custom-title"]);
    expect(recs.every((r) => r.sessionId === id)).toBe(true);
    expect(recs.at(-1)).toMatchObject({ customTitle: "Pick a color (fork)" });
    expect(fs.readFileSync(file, "utf8")).toBe(original);
    expect((await listCheckpoints(repo, id)).map((c) => c.id)).toEqual([cpId]);
    expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("v2\n");
  });

  it("forks from the last reply with every record of its turn", async () => {
    const { id } = (await (await call(fork, SID, { entryId: "a3:0" })).json()) as { id: string };
    expect(records(path.join(dir, `${id}.jsonl`)).map((r) => r.uuid ?? r.type)).toEqual(["custom-title", "u1", "a1", "u2", "a2", "r1", "a3", "custom-title"]);
  });

  it("refuses a prompt, an unknown message, a bad body and an unknown session", async () => {
    expect((await call(fork, SID, { entryId: "u1" })).status).toBe(404);
    expect((await call(fork, SID, { entryId: "zz:0" })).status).toBe(404);
    expect((await call(fork, SID, { entryId: "a1:0", checkpoint: cpId })).status).toBe(400);
    expect((await call(fork, SID, {})).status).toBe(400);
    expect((await call(fork, "c0ffee00-1111-4222-8333-000000000000", { entryId: "a1:0" })).status).toBe(404);
  });
});

describe("POST /api/sessions/[id]/edit", () => {
  it("validates before touching anything", async () => {
    expect((await call(edit, SID, { entryId: "u2" })).status).toBe(400);
    expect((await call(edit, SID, { entryId: "u2", text: "x", checkpoint: "nope" })).status).toBe(400);
    expect((await call(edit, SID, { entryId: "a1:0", text: "x", checkpoint: cpId })).status).toBe(404);
    expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("v2\n");
  });

  it("leaves the files alone when the checkpoint is gone", async () => {
    const before = fs.readdirSync(dir).length;
    const res = await call(edit, SID, { entryId: "u2", text: "two, but blue", checkpoint: "1700000000000-dead" });
    expect(res.status).toBe(404);
    expect(fs.readdirSync(dir).length).toBe(before);
    expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("v2\n");
  });

  it("puts the files back, then resumes a copy cut before the prompt with the new text", async () => {
    const n = fakes.length;
    const res = await call(edit, SID, { entryId: "u2", text: "two, but blue", checkpoint: cpId, permissionMode: "acceptEdits" });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("v1\n");
    expect(records(path.join(dir, `${id}.jsonl`)).map((r) => r.uuid ?? r.type)).toEqual(["custom-title", "u1", "a1", "custom-title"]);
    expect(fakes.length).toBe(n + 1);
    expect(fakes.at(-1)!.opts).toMatchObject({ resume: id, cwd: repo, permissionMode: "acceptEdits" });
    expect(fs.readFileSync(file, "utf8")).toBe(original);
    getRun(id)?.close();
  });

  it("starts a new session in the folder when the first prompt is edited", async () => {
    const n = fakes.length;
    const pending = call(edit, SID, { entryId: "u1", text: "one, again" });
    for (let i = 0; i < 100 && fakes.length === n; i++) await new Promise((r) => setTimeout(r, 10));
    const f = fakes.at(-1)!;
    expect(f.opts.resume).toBeUndefined();
    f.push(init("d00d0000-1111-4222-8333-444455556666"));
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "d00d0000-1111-4222-8333-444455556666" });
    getRun("d00d0000-1111-4222-8333-444455556666")?.close();
  });
});
