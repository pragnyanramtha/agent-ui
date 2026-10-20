import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/* The per-transcript metadata cache behind the session list must not grow with every transcript ever seen. */
const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentu-metacache-"));
process.env.CLAUDE_HOME = home;
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));
const { listSessions, sessionMeta } = await import("@/lib/server/sessions");
const cache = () => (globalThis as { __claudeUiMeta?: Map<string, unknown> }).__claudeUiMeta!;

const dir = path.join(home, "projects", "-w");
fs.mkdirSync(dir, { recursive: true });
let n = 0;
function transcript(name = `cccccccc-0000-4000-8000-${String(++n).padStart(12, "0")}`) {
  const file = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: "user", uuid: `u${n}`, timestamp: new Date().toISOString(), cwd: "/w", message: { role: "user", content: `task ${n}` } })}\n`);
  return file;
}
const meta = (file: string) => {
  const s = fs.statSync(file);
  return sessionMeta(file, s.mtimeMs, s.size);
};

describe("session metadata cache", () => {
  it("forgets transcripts that were deleted", async () => {
    const a = transcript();
    const b = transcript();
    await listSessions();
    expect(cache().has(a) && cache().has(b)).toBe(true);
    fs.rmSync(a);
    await listSessions();
    expect(cache().has(a)).toBe(false);
    expect(cache().has(b)).toBe(true);
  });

  it("keeps at most 2000 entries, dropping the least recently used", async () => {
    const files = Array.from({ length: 2100 }, () => transcript());
    const first = files[0];
    await meta(first);
    for (const f of files.slice(1, 1500)) await meta(f);
    /* used again, so it's the newest */
    await meta(first);
    for (const f of files.slice(1500)) await meta(f);
    expect(cache().size).toBe(2000);
    expect(cache().has(first)).toBe(true);
    expect(cache().has(files[1])).toBe(false);
    expect(cache().has(files.at(-1)!)).toBe(true);
  });
});
