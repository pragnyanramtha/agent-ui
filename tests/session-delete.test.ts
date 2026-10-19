import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";

/* every store lives in a temp home: paths are read when the server modules load, so this runs before importing them */
const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentu-delete-"));
const claudeHome = path.join(home, "claude");
const codexHome = path.join(home, "codex");
const geminiHome = path.join(home, "gemini-home");
process.env.HOME = home;
process.env.AGENT_U_HOME = path.join(home, "agent-u");
process.env.AGENT_U_CONFIG = path.join(home, "agent-u", "config.json");
process.env.CLAUDE_HOME = claudeHome;
process.env.CODEX_HOME = codexHome;
process.env.GEMINI_CLI_HOME = geminiHome;
const statePath = path.join(home, "agent-u", "state.json");

const { deleteSession, removeInside } = await import("@/lib/server/delete-session");
const profiles = await import("@/lib/server/profiles");
const { DELETE } = await import("@/app/api/sessions/[id]/route");
const { listSessions } = await import("@/lib/server/sessions");
const { sessionRows } = await import("@/lib/server/rows");

const UUID = "0b9c3d8e-1f2a-4b5c-8d7e-6f5a4b3c2d1e";
const CODEX_ID = "019a1b2c-3d4e-7f50-8a9b-0c1d2e3f4a5b";
const projects = path.join(claudeHome, "projects");

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};
const claudeLine = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text }, origin: { kind: "human" }, cwd: "/w", sessionId: UUID }) + "\n";
const claudeFile = (project = "-w") => write(path.join(projects, project, `${UUID}.jsonl`), claudeLine("Fix the login"));
const codexFile = () =>
  write(path.join(codexHome, "sessions", "2026", "10", "19", `rollout-2026-10-19T03-00-00-${CODEX_ID}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id: CODEX_ID, cwd: "/w" } }) + "\n");
const geminiFile = (name = "session-2026-10-19T03-00-gem1.jsonl") =>
  write(path.join(geminiHome, ".gemini", "tmp", "w", "chats", name), JSON.stringify({ sessionId: "gem-1", projectHash: "x", startTime: "2026-10-19T03:00:00Z", kind: "main" }) + "\n");
const state = () => (fs.existsSync(statePath) ? (JSON.parse(fs.readFileSync(statePath, "utf8")) as { sessionMeta?: Record<string, unknown> }) : {});

const del = async (id: string, body?: unknown) => {
  const req = new Request(`http://127.0.0.1:3311/api/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const res = await DELETE(req as unknown as NextRequest, { params: Promise.resolve({ id: encodeURIComponent(id) }) });
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
};

/* a stand-in for a live web run of a Claude session (lib/server/runner.ts keeps them on globalThis) */
const runs = () => ((globalThis as { __claudeUiRuns?: Map<string, unknown> }).__claudeUiRuns ??= new Map());
const fakeRun = (status: string, pending: unknown[] = []) => {
  const run = { live: true, closed: false, state: { status, pending }, close() { this.closed = true; this.live = false; } };
  runs().set(UUID, run);
  return run;
};

beforeEach(() => {
  for (const d of [claudeHome, codexHome, geminiHome, path.dirname(statePath)]) fs.rmSync(d, { recursive: true, force: true });
  runs().clear();
});
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

describe("deleteSession", () => {
  it("hides a Claude session and keeps its transcript unless asked", async () => {
    const file = claudeFile();
    expect((await listSessions()).map((s) => s.id)).toEqual([UUID]);
    expect((await sessionRows()).map((s) => s.id)).toEqual([UUID]);
    profiles.setSessionMeta(UUID, { pinned: true, title: "Mine" });
    expect(await deleteSession(UUID, { transcript: false })).toEqual({ ok: true, removed: null });
    expect(fs.existsSync(file)).toBe(true);
    expect(state().sessionMeta).toEqual({ [UUID]: { deleted: true } });
    expect(profiles.getSessionMeta(UUID)).toEqual({ deleted: true });
    expect(await sessionRows()).toEqual([]);
    /* only DELETE marks a session deleted */
    expect(profiles.parseSessionMetaPatch({ deleted: false })).toMatch(/Unknown field "deleted"/);
  });

  it("removes the one Claude transcript when asked", async () => {
    const file = claudeFile();
    const other = write(path.join(projects, "-w", "11111111-2222-4333-8444-555555555555.jsonl"), claudeLine("Other"));
    expect(await deleteSession(`claude:${UUID}`, { transcript: true })).toEqual({ ok: true, removed: file });
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
    expect(state().sessionMeta).toEqual({ [UUID]: { deleted: true } });
  });

  it("deletes nothing when the id is in two projects", async () => {
    const a = claudeFile("-w");
    const b = claudeFile("-x");
    const res = await deleteSession(UUID, { transcript: true });
    expect(res).toMatchObject({ ok: false, status: 409 });
    expect(fs.existsSync(a) && fs.existsSync(b)).toBe(true);
    expect(state().sessionMeta).toBeUndefined();
  });

  it("won't follow a link out of the session store", async () => {
    const outside = write(path.join(home, "outside", "precious.txt"), "keep me");
    fs.mkdirSync(path.join(projects, "-w"), { recursive: true });
    fs.symlinkSync(outside, path.join(projects, "-w", `${UUID}.jsonl`));
    expect(await deleteSession(UUID, { transcript: true })).toMatchObject({ ok: false, status: 409 });
    expect(fs.readFileSync(outside, "utf8")).toBe("keep me");
    /* a linked project folder resolves outside too */
    fs.rmSync(path.join(projects, "-w"), { recursive: true });
    const elsewhere = write(path.join(home, "elsewhere", `${UUID}.jsonl`), claudeLine("x"));
    fs.symlinkSync(path.dirname(elsewhere), path.join(projects, "-w"));
    expect(await deleteSession(UUID, { transcript: true })).toMatchObject({ ok: false, status: 409 });
    expect(fs.existsSync(elsewhere)).toBe(true);
    expect(state().sessionMeta).toBeUndefined();
  });

  it("refuses a running session, and a transcript an open terminal or web run still holds", async () => {
    const file = claudeFile();
    fakeRun("running");
    expect(await deleteSession(UUID, { transcript: false })).toEqual({ ok: false, status: 409, error: "Stop the session first." });
    fakeRun("idle", [{ kind: "permission" }]);
    expect(await deleteSession(UUID, { transcript: true })).toMatchObject({ ok: false, status: 409 });
    expect(fs.existsSync(file)).toBe(true);
    /* an idle web run is closed first, so it can't write the file back */
    const idle = fakeRun("idle");
    expect(await deleteSession(UUID, { transcript: true })).toEqual({ ok: true, removed: file });
    expect(idle.closed).toBe(true);
  });

  it("removes a Codex rollout and a Gemini chat from their own stores", async () => {
    const rollout = codexFile();
    expect(await deleteSession(`codex:${CODEX_ID}`, { transcript: true })).toEqual({ ok: true, removed: rollout });
    expect(fs.existsSync(rollout)).toBe(false);
    const chat = geminiFile();
    const otherChat = write(path.join(geminiHome, ".gemini", "tmp", "w", "chats", "session-2026-10-19T03-01-gem2.jsonl"), JSON.stringify({ sessionId: "gem-2", kind: "main" }) + "\n");
    expect(await deleteSession("gemini:gem-1", { transcript: true })).toEqual({ ok: true, removed: chat });
    expect(fs.existsSync(chat)).toBe(false);
    expect(fs.existsSync(otherChat)).toBe(true);
    expect(state().sessionMeta).toEqual({ [`codex:${CODEX_ID}`]: { deleted: true }, "gemini:gem-1": { deleted: true } });
  });

  it("says when there is no file or the agent can't name one", async () => {
    expect(await deleteSession("gemini:nope", { transcript: true })).toEqual({ ok: false, status: 409, error: "Couldn't find the transcript file." });
    expect(await deleteSession("opencode:ses_1", { transcript: true })).toMatchObject({ ok: false, status: 400 });
    expect(await deleteSession("opencode:ses_1", { transcript: false })).toEqual({ ok: true, removed: null });
    expect(await deleteSession("../etc", { transcript: false })).toMatchObject({ ok: false, status: 404 });
  });
});

describe("removeInside", () => {
  it("only removes plain files under a root", async () => {
    const root = path.join(home, "root");
    const inside = write(path.join(root, "a", "f.jsonl"), "x");
    const outside = write(path.join(home, "not-root", "f.jsonl"), "x");
    expect(await removeInside(outside, [root])).toBe(false);
    expect(await removeInside(path.join(root, "a", "..", "..", "not-root", "f.jsonl"), [root])).toBe(false);
    expect(await removeInside(path.join(root, "a"), [root])).toBe(false);
    expect(await removeInside(root, [root])).toBe(false);
    expect(await removeInside("a/f.jsonl", [root])).toBe(false);
    expect(fs.existsSync(outside)).toBe(true);
    expect(await removeInside(inside, [path.join(home, "missing"), root])).toBe(true);
    expect(fs.existsSync(inside)).toBe(false);
  });
});

describe("DELETE /api/sessions/[id]", () => {
  it("hides the session, and removes the transcript only when ticked", async () => {
    const file = claudeFile();
    expect(await del(UUID)).toEqual({ status: 200, data: { ok: true, transcriptDeleted: false } });
    expect(fs.existsSync(file)).toBe(true);
    expect(await del(UUID, { transcript: true })).toEqual({ status: 200, data: { ok: true, transcriptDeleted: true } });
    expect(fs.existsSync(file)).toBe(false);
  });

  it("rejects bad ids, bad bodies and running sessions", async () => {
    claudeFile();
    expect((await del("-rf")).status).toBe(404);
    expect((await del("codex:../x")).status).toBe(404);
    expect((await del(UUID, { transcript: "yes" })).status).toBe(400);
    expect((await del(UUID, [true])).status).toBe(400);
    fakeRun("starting");
    expect(await del(UUID, { transcript: true })).toEqual({ status: 409, data: { error: "Stop the session first." } });
    expect(state().sessionMeta).toBeUndefined();
  });
});
