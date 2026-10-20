import { afterEach, describe, expect, it, vi } from "vitest";
import { fakes, init } from "./fake-claude-sdk";

/* The idle reaper, with a short interval: runs nobody watches, and approvals nobody answers. */

vi.mock("@anthropic-ai/claude-agent-sdk", async () => ({ query: (await import("./fake-claude-sdk")).query }));
process.env.IDLE_REAP_MS = "40";
const { startRun, getRun, lastFailure } = await import("@/lib/server/runner");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DAY = 24 * 60 * 60_000;

afterEach(() => vi.restoreAllMocks());

async function asking(id: string) {
  const run = startRun({ resume: id, cwd: "/", permissionMode: "default" });
  run.send("hi");
  const f = fakes.at(-1)!;
  f.push(init(id));
  await sleep(5);
  const answer = f.opts.canUseTool("Bash", { command: "ls" }, { signal: new AbortController().signal, suggestions: [] }) as Promise<{ behavior: string; message?: string }>;
  await sleep(5);
  return { run, f, answer };
}

describe("approvals nobody answers", () => {
  it("keep the run while they wait less than a day", async () => {
    const id = "aaaaaaaa-0000-4000-8000-000000000001";
    const { run } = await asking(id);
    await sleep(150);
    expect(getRun(id)).toBe(run);
    expect(run.state.pending).toHaveLength(1);
    run.close();
  });

  it("are declined and the run closed after a day with nobody watching", async () => {
    const id = "aaaaaaaa-0000-4000-8000-000000000002";
    const { run, f, answer } = await asking(id);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + DAY + 1);
    await sleep(150);
    expect(await answer).toMatchObject({ behavior: "deny", message: "Nobody answered this in time." });
    expect(run.live).toBe(false);
    expect(f.closed).toBe(1);
    expect(getRun(id)).toBeNull();
    expect(lastFailure(id)?.error).toBe("Stopped after a day waiting for your answer.");
  });

  it("wait as long as someone is watching", async () => {
    const id = "aaaaaaaa-0000-4000-8000-000000000003";
    const { run } = await asking(id);
    const off = run.subscribe(() => undefined);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + DAY + 1);
    await sleep(150);
    expect(run.live).toBe(true);
    off();
    await sleep(150);
    expect(run.live).toBe(false);
  });
});
