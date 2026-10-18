import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/profiles", () => ({ activeProfile: () => null }));

const { emitDelta, onDelta, onTurn, rekeyTurn, runningTurns, startTurn, stopTurn, turnState } = await import("@/lib/server/agents/cli-run");
import type { CliRunState } from "@/lib/server/agents/types";

const ended = (key: string) =>
  new Promise<CliRunState>((resolve) => {
    const off = onTurn(key, (s) => s.status !== "running" && (off(), resolve(s)));
  });
const sh = (script: string) => ({ cmd: "sh", args: ["-c", script], cwd: process.cwd() });
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("cli turns", () => {
  it("go idle on exit 0 and deliver every stdout line, including an unterminated last one", async () => {
    const lines: string[] = [];
    const done = ended("t:ok");
    startTurn("t:ok", sh("echo one; echo; printf 'two\\nthree'"), (l) => lines.push(l));
    expect(runningTurns()).toContain("t:ok");
    expect((await done).status).toBe("idle");
    expect(lines).toEqual(["one", "two", "three"]);
    expect(runningTurns()).not.toContain("t:ok");
  });

  it("report the last stderr line when the CLI fails", async () => {
    const done = ended("t:err");
    startTurn("t:err", sh("echo noise >&2; echo 'Error: model not available' >&2; exit 3"));
    const s = await done;
    expect(s.status).toBe("error");
    expect(s.error).toBe("Error: model not available");
  });

  it("fall back to the exit code when stderr is empty", async () => {
    const done = ended("t:code");
    startTurn("t:code", sh("exit 7"));
    expect((await done).error).toBe("Exited with code 7");
  });

  it("report a missing binary as an error, not a crash", async () => {
    const done = ended("t:missing");
    startTurn("t:missing", { cmd: "/nonexistent/agent-cli", args: [], cwd: process.cwd() });
    const s = await done;
    expect(s.status).toBe("error");
    expect(s.error).toMatch(/ENOENT/);
  });

  it("refuse a second turn for the same session while one runs", async () => {
    const done = ended("t:dup");
    startTurn("t:dup", sh("sleep 0.3"));
    expect(() => startTurn("t:dup", sh("true"))).toThrow(/already running/);
    await done;
    const again = ended("t:dup");
    startTurn("t:dup", sh("true"));
    expect((await again).status).toBe("idle");
  });

  it("feed stdin and close it", async () => {
    const lines: string[] = [];
    const done = ended("t:stdin");
    startTurn("t:stdin", { ...sh("cat | tr a-z A-Z"), stdin: "hello stdin\n" }, (l) => lines.push(l));
    await done;
    expect(lines).toEqual(["HELLO STDIN"]);
  });

  it("Stop ends the whole process group, grandchildren included, and counts as idle", async () => {
    const lines: string[] = [];
    const done = ended("t:stop");
    startTurn("t:stop", sh("sleep 30 & echo $!; wait"), (l) => lines.push(l));
    await vi.waitFor(() => expect(lines.length).toBe(1), { timeout: 3000 });
    const grandchild = Number(lines[0]);
    expect(alive(grandchild)).toBe(true);
    stopTurn("t:stop");
    expect((await done).status).toBe("idle");
    await vi.waitFor(() => expect(alive(grandchild)).toBe(false), { timeout: 3000 });
  });

  it("finish even when an orphaned helper keeps stdout open", async () => {
    const start = Date.now();
    const lines: string[] = [];
    const done = ended("t:orphan");
    startTurn("t:orphan", sh("sleep 20 & echo $!"), (l) => lines.push(l));
    expect((await done).status).toBe("idle");
    expect(Date.now() - start).toBeLessThan(5000);
    process.kill(Number(lines[0]));
  });

  it("replay live text to late subscribers, follow a rekey, and drop it when the turn ends", async () => {
    const done = ended("t:new");
    startTurn("t:new", sh("sleep 0.4"));
    emitDelta("t:new", { msgId: "live:a", index: 0, kind: "text", text: "Hel" });
    emitDelta("t:new", { msgId: "live:a", index: 0, kind: "text", text: "lo" });
    const late: string[] = [];
    const off = onDelta("t:new", (d) => late.push(d.text));
    expect(late).toEqual(["Hello"]);
    off();

    const moved: string[] = [];
    onDelta("t:real", (d) => moved.push(d.text));
    rekeyTurn("t:new", "t:real");
    expect(moved).toEqual(["Hello"]);
    expect(turnState("t:real")?.status).toBe("running");
    const realDone = ended("t:real");
    await Promise.race([done, realDone]);

    const after: string[] = [];
    onDelta("t:real", (d) => after.push(d.text));
    emitDelta("t:real", { msgId: "live:a", index: 0, kind: "text", text: "late" });
    expect(after).toEqual([]);
  });

  it("refuse an argument too long for the kernel with a readable error, before spawning", () => {
    expect(() => startTurn("t:e2big", sh(`echo ${"x".repeat(200 * 1024)}`))).toThrow(/Message too long \(200 KB\)/);
    expect(turnState("t:e2big")).toBeNull();
  });

  it("survive a huge single stdout line without running away", async () => {
    let longest = 0;
    const done = ended("t:big");
    startTurn("t:big", sh("head -c 3000000 /dev/zero | tr '\\0' x; echo; echo tail"), (l) => (longest = Math.max(longest, l.length)));
    expect((await done).status).toBe("idle");
    expect(longest).toBe(3_000_000);
  });
});
