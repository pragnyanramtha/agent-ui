import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Entry } from "@/lib/types";
import { fakes, init } from "./fake-claude-sdk";

/* What a web run said outside the transcript (slash command output) sits where it happened on a reload. */

vi.mock("@anthropic-ai/claude-agent-sdk", async () => ({ query: (await import("./fake-claude-sdk")).query }));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentu-extras-"));
process.env.CLAUDE_HOME = home;
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

const { placeByTime } = await import("@/lib/server/transcript");
const { startRun } = await import("@/lib/server/runner");
const { GET } = await import("@/app/api/sessions/[id]/route");

const note = (id: string, ts: string): Entry => ({ kind: "notice", id, ts, tone: "info", text: id });

describe("placeByTime", () => {
  it("puts each extra after the entries before it", () => {
    const page = [note("a", "2026-10-19T10:00:00Z"), note("b", "2026-10-19T10:05:00Z"), note("c", "2026-10-19T10:10:00Z")];
    const extras = [note("x", "2026-10-19T09:00:00Z"), note("y", "2026-10-19T10:06:00Z"), note("z", "2026-10-19T11:00:00Z")];
    expect(placeByTime(page, extras).map((e) => e.id)).toEqual(["x", "a", "b", "y", "c", "z"]);
  });

  it("entries without a time don't move anything; extras without one go last", () => {
    const page = [note("a", "2026-10-19T10:00:00Z"), note("t", ""), note("c", "2026-10-19T10:10:00Z")];
    expect(placeByTime(page, [note("y", "2026-10-19T10:06:00Z"), note("n", "")]).map((e) => e.id)).toEqual(["a", "t", "y", "c", "n"]);
    expect(placeByTime(page, [])).toBe(page);
  });
});

describe("GET /api/sessions/[id]", () => {
  it("returns slash command output between the turns around it, not at the bottom", async () => {
    const id = "bbbbbbbb-0000-4000-8000-000000000001";
    const dir = path.join(home, "projects", "-w");
    fs.mkdirSync(dir, { recursive: true });
    const rec = (uuid: string, text: string, ts: string) => JSON.stringify({ type: "user", uuid, timestamp: ts, cwd: "/w", sessionId: id, message: { role: "user", content: text } });
    const file = path.join(dir, `${id}.jsonl`);
    const past = (s: number) => new Date(Date.now() - s * 1000).toISOString();
    fs.writeFileSync(file, `${rec("u1", "first", past(60))}\n`);
    const run = startRun({ resume: id, cwd: "/w", permissionMode: "default" });
    run.send("/context");
    const f = fakes.at(-1)!;
    f.push(init(id));
    f.push({ type: "system", subtype: "local_command_output", uuid: "out1", content: "Context: 12k tokens", session_id: id });
    await new Promise((r) => setTimeout(r, 20));
    fs.appendFileSync(file, `${rec("u2", "later", new Date(Date.now() + 60_000).toISOString())}\n`);
    const res = await GET(new NextRequest(`http://x/api/sessions/${id}`), { params: Promise.resolve({ id }) });
    const body = (await res.json()) as { entries: Entry[] };
    expect(body.entries.map((e) => e.id)).toEqual(["u1", "out1", "u2"]);
    run.close();
  });
});
