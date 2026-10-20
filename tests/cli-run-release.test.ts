import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { failTurn, onTurn, startTurn, stopTurn, turnState } from "@/lib/server/agents/cli-run";
import type { CliRunState } from "@/lib/server/agents/types";

const ended = (key: string) =>
  new Promise<CliRunState>((resolve) => {
    const off = onTurn(key, (s) => s.status !== "running" && (off(), resolve(s)));
  });

const alive = (pid: number) => {
  try {
    /* a zombie still has a /proc entry */
    return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
};

describe("finished CLI turns", () => {
  it("a clean turn is forgotten once nobody listens; a failed one keeps its error", async () => {
    const ok = "test:release-ok";
    const bad = "test:release-bad";
    const reported = "test:release-reported";
    const late = "test:release-late";
    startTurn(ok, { cmd: "sh", args: ["-c", "exit 0"], cwd: "/" });
    startTurn(bad, { cmd: "sh", args: ["-c", "echo broke >&2; exit 3"], cwd: "/" });
    /* the agent said the turn failed but exited cleanly (or was stopped after saying so) */
    failTurn(startTurn(reported, { cmd: "sh", args: ["-c", "sleep 0.2; exit 0"], cwd: "/" }), "model exploded");
    const lateRun = startTurn(late, { cmd: "sh", args: ["-c", "exit 0"], cwd: "/" });
    const [a, b, c, d] = await Promise.all([ended(ok), ended(bad), ended(reported), ended(late)]);
    expect(a.status).toBe("idle");
    expect(b).toMatchObject({ status: "error", error: "broke" });
    expect(c).toMatchObject({ status: "error", error: "model exploded" });
    expect(d.status).toBe("idle");
    /* a report read after the process ended still counts */
    failTurn(lateRun, "late report");
    expect(turnState(late)).toMatchObject({ status: "error", error: "late report" });
    await new Promise((r) => setTimeout(r, 5300));
    expect(turnState(ok)).toBeNull();
    expect(turnState(bad)).toMatchObject({ status: "error", error: "broke" });
    expect(turnState(reported)).toMatchObject({ status: "error", error: "model exploded" });
    expect(turnState(late)).toMatchObject({ status: "error", error: "late report" });
  });
});

describe.skipIf(process.platform !== "linux")("stopping a turn", () => {
  it("also ends commands the agent started in their own process group", async () => {
    const key = "test:stop-tree";
    let out = "";
    /* setsid puts the sleep in a new session and group, as Gemini does with each shell command */
    startTurn(key, { cmd: "sh", args: ["-c", "setsid sleep 30 & echo $!; wait"], cwd: "/" }, (l) => (out = l));
    for (let i = 0; i < 50 && !out; i++) await new Promise((r) => setTimeout(r, 20));
    const pid = Number(out);
    expect(alive(pid)).toBe(true);
    const done = ended(key);
    stopTurn(key);
    await done;
    for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 20));
    expect(alive(pid)).toBe(false);
  });
});
