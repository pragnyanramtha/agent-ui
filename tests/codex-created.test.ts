import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-u-codex-created-"));
process.env.CODEX_HOME = home;
const { fileMeta } = await import("@/lib/server/agents/codex-files");

afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

const ID = "0199f0a1-1111-7222-8333-944455556666";

describe("codex rollouts", () => {
  it("read when the session started from session_meta", async () => {
    const dir = path.join(home, "sessions", "2026", "10", "19");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-2026-10-19T03-00-00-${ID}.jsonl`);
    const lines = [
      { timestamp: "2026-10-19T03:00:01.000Z", type: "session_meta", payload: { id: ID, cwd: "/w", timestamp: "2026-10-19T03:00:00.500Z" } },
      { timestamp: "2026-10-19T03:05:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the login" }] } },
    ];
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const meta = await fileMeta(file);
    expect(meta?.created).toBe(Date.parse("2026-10-19T03:00:00.500Z"));
    expect(meta?.cwd).toBe("/w");
  });
});
