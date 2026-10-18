import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";
import type { SessionSummary } from "@/lib/types";

/* CONFIG_DIR is read when profiles.ts loads, so the temp home is set before any import of it */
const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentu-meta-"));
process.env.AGENT_U_HOME = home;
process.env.CLAUDE_HOME = path.join(home, "claude");
const statePath = path.join(home, "state.json");

const profiles = await import("@/lib/server/profiles");
const { withMeta } = await import("@/lib/server/rows");
const { PATCH } = await import("@/app/api/sessions/[id]/route");

const readState = () => JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;

const patch = async (id: string, body: unknown) => {
  const req = new Request(`http://127.0.0.1:3311/api/sessions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const res = await PATCH(req as unknown as NextRequest, { params: Promise.resolve({ id: encodeURIComponent(id) }) });
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
};

const UUID = "0b9c3d8e-1f2a-4b5c-8d7e-6f5a4b3c2d1e";

beforeEach(() => fs.rmSync(statePath, { force: true }));
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

describe("parseSessionMetaPatch", () => {
  const parse = profiles.parseSessionMetaPatch;

  it("accepts pinned, archived and title", () => {
    expect(parse({ pinned: true })).toEqual({ pinned: true });
    expect(parse({ archived: false, pinned: false })).toEqual({ archived: false, pinned: false });
    expect(parse({ title: "  Fix   the\nlogin  " })).toEqual({ title: "Fix the login" });
  });

  it("treats an empty or null title as clearing it", () => {
    expect(parse({ title: "" })).toEqual({ title: null });
    expect(parse({ title: "   " })).toEqual({ title: null });
    expect(parse({ title: null })).toEqual({ title: null });
  });

  it("rejects anything else", () => {
    expect(parse(null)).toBeTypeOf("string");
    expect(parse([])).toBeTypeOf("string");
    expect(parse("pinned")).toBeTypeOf("string");
    expect(parse({})).toBe("Nothing to change.");
    expect(parse({ pinned: "yes" })).toBeTypeOf("string");
    expect(parse({ archived: 1 })).toBeTypeOf("string");
    expect(parse({ title: 42 })).toBeTypeOf("string");
    expect(parse({ pinned: true, color: "red" })).toMatch(/Unknown field "color"/);
    expect(parse({ title: "x".repeat(201) })).toBeTypeOf("string");
    expect(parse({ title: "x".repeat(200) })).toEqual({ title: "x".repeat(200) });
  });
});

describe("session meta in state.json", () => {
  it("keeps the session profile map next to it", () => {
    fs.writeFileSync(statePath, JSON.stringify({ sessionProfiles: { [UUID]: "claude-work" }, other: 1 }));
    profiles.setSessionMeta(UUID, { pinned: true, title: "Login bug" });
    expect(readState()).toEqual({ sessionProfiles: { [UUID]: "claude-work" }, other: 1, sessionMeta: { [UUID]: { pinned: true, title: "Login bug" } } });
    expect(profiles.sessionProfile(UUID)).toBe("claude-work");
    profiles.setSessionProfile("codex:abc", "codex");
    expect(profiles.getSessionMeta(UUID)).toEqual({ pinned: true, title: "Login bug" });
  });

  it("reads old files and broken content as nothing set", () => {
    fs.writeFileSync(statePath, JSON.stringify({ sessionProfiles: { a: "claude" } }));
    expect(profiles.allSessionMeta()).toEqual({});
    fs.writeFileSync(statePath, "not json");
    expect(profiles.getSessionMeta(UUID)).toEqual({});
    fs.writeFileSync(statePath, JSON.stringify({ sessionMeta: { a: { pinned: "yes", archived: true, title: 5 }, b: null } }));
    expect(profiles.allSessionMeta()).toEqual({ a: { archived: true } });
  });

  it("archiving unpins, pinning unarchives, and clearing everything drops the entry", () => {
    profiles.setSessionMeta("codex:abc", { pinned: true });
    expect(profiles.setSessionMeta("codex:abc", { archived: true })).toEqual({ archived: true });
    expect(profiles.setSessionMeta("codex:abc", { pinned: true })).toEqual({ pinned: true });
    expect(profiles.setSessionMeta("codex:abc", { archived: true, pinned: true })).toEqual({ pinned: true, archived: true });
    profiles.setSessionMeta("codex:abc", { archived: false, pinned: false });
    expect(readState().sessionMeta).toEqual({});
  });

  it("sets and clears a custom title", () => {
    profiles.setSessionMeta(UUID, { title: "Mine" });
    expect(profiles.getSessionMeta(UUID).title).toBe("Mine");
    profiles.setSessionMeta(UUID, { title: null });
    expect(profiles.getSessionMeta(UUID)).toEqual({});
  });
});

describe("withMeta", () => {
  const row: SessionSummary = { id: UUID, agent: "claude", title: "From the transcript", cwd: "/w", project: "w", mtime: 0, size: 0, terminal: null, web: null };

  it("applies the custom title and flags", () => {
    expect(withMeta(row, undefined)).toBe(row);
    expect(withMeta(row, { title: "Mine", pinned: true })).toEqual({ ...row, title: "Mine", pinned: true });
    expect(withMeta(row, { archived: true })).toEqual({ ...row, archived: true });
  });
});

describe("PATCH /api/sessions/[id]", () => {
  it("saves under the session key, plain Claude ids and agent ids alike", async () => {
    expect(await patch(UUID, { pinned: true })).toEqual({ status: 200, data: { ok: true, pinned: true, archived: false, title: null } });
    expect(await patch("codex:019a-thread", { title: "  Ship it " })).toEqual({ status: 200, data: { ok: true, pinned: false, archived: false, title: "Ship it" } });
    /* "claude:<id>" is the same session as the bare id */
    expect((await patch(`claude:${UUID}`, { archived: true })).data).toMatchObject({ archived: true, pinned: false });
    expect(readState().sessionMeta).toEqual({ [UUID]: { archived: true }, "codex:019a-thread": { title: "Ship it" } });
  });

  it("clears the title with an empty string or null", async () => {
    await patch(UUID, { title: "Mine" });
    expect((await patch(UUID, { title: "" })).data.title).toBeNull();
    await patch(UUID, { title: "Mine" });
    expect((await patch(UUID, { title: null })).data.title).toBeNull();
  });

  it("rejects bad ids and bad bodies", async () => {
    expect((await patch("-rf", { pinned: true })).status).toBe(404);
    expect((await patch("nope:abc", { pinned: true })).status).toBe(404);
    expect((await patch("codex:../x", { pinned: true })).status).toBe(404);
    expect((await patch(UUID, "{oops")).status).toBe(400);
    expect((await patch(UUID, {})).status).toBe(400);
    expect((await patch(UUID, { pinned: "true" })).status).toBe(400);
    expect((await patch(UUID, { title: "x".repeat(201) })).status).toBe(400);
    expect((await patch(UUID, { hidden: true })).status).toBe(400);
    expect(fs.existsSync(statePath)).toBe(false);
  });
});
