import { describe, expect, it } from "vitest";
import { onTurn, startTurn, turnState } from "@/lib/server/agents/cli-run";
import type { CliRunState } from "@/lib/server/agents/types";

const ended = (key: string) =>
  new Promise<CliRunState>((resolve) => {
    const off = onTurn(key, (s) => s.status !== "running" && (off(), resolve(s)));
  });

describe("finished CLI turns", () => {
  it("a clean turn is forgotten once nobody listens; a failed one keeps its error", async () => {
    const ok = "test:release-ok";
    const bad = "test:release-bad";
    startTurn(ok, { cmd: "sh", args: ["-c", "exit 0"], cwd: "/" });
    startTurn(bad, { cmd: "sh", args: ["-c", "echo broke >&2; exit 3"], cwd: "/" });
    const [a, b] = await Promise.all([ended(ok), ended(bad)]);
    expect(a.status).toBe("idle");
    expect(b).toMatchObject({ status: "error", error: "broke" });
    await new Promise((r) => setTimeout(r, 5300));
    expect(turnState(ok)).toBeNull();
    expect(turnState(bad)).toMatchObject({ status: "error", error: "broke" });
  });
});
