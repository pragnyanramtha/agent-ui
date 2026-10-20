import { describe, expect, it, vi } from "vitest";
import { effortArgs, effortFromCommand, effortLabel, effortOptions, parseEffort } from "@/lib/agent-traits";
import { interactiveArgs } from "@/lib/server/terminals";
import { turnParams } from "@/lib/server/agents/codex-app";
import { parseProfile } from "@/lib/server/profiles";
import { AGENT_IDS } from "@/lib/types";

const calls: { options: Record<string, unknown>; flags: unknown[] }[] = [];
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ options }: { options: Record<string, unknown> }) => {
    const call = { options, flags: [] as unknown[] };
    calls.push(call);
    return {
      applyFlagSettings: async (s: unknown) => void call.flags.push(s),
      close() {},
      async *[Symbol.asyncIterator]() {
        await new Promise(() => undefined);
      },
    };
  },
}));

describe("effort descriptors", () => {
  it("offers levels only for drivers that pass them through", () => {
    expect(effortOptions("claude").map((o) => o.key)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortOptions("codex").map((o) => o.key)).toEqual(["low", "medium", "high", "xhigh"]);
    for (const a of AGENT_IDS.filter((x) => x !== "claude" && x !== "codex")) expect(effortOptions(a)).toEqual([]);
  });

  it("reads client and profile values strictly per agent", () => {
    expect(parseEffort("claude", "High ")).toBe("high");
    expect(parseEffort("claude", "max")).toBe("max");
    expect(parseEffort("codex", "max")).toBeUndefined();
    expect(parseEffort("codex", "")).toBeNull();
    expect(parseEffort("codex", null)).toBeNull();
    expect(parseEffort("gemini", "high")).toBeUndefined();
    expect(parseEffort("claude", 3)).toBeUndefined();
    expect(parseEffort("claude", undefined)).toBeUndefined();
  });

  it("names levels", () => {
    expect(effortLabel("codex", "xhigh")).toBe("Extra high");
    expect(effortLabel("codex", "")).toBeNull();
    expect(effortLabel("gemini", "high")).toBeNull();
  });

  it("builds each CLI's flag, and nothing for unknown levels or agents", () => {
    expect(effortArgs("claude", "high")).toEqual(["--effort", "high"]);
    expect(effortArgs("codex", "low")).toEqual(["-c", 'model_reasoning_effort="low"']);
    expect(effortArgs("codex", "max")).toEqual([]);
    expect(effortArgs("claude", "")).toEqual([]);
    expect(effortArgs("claude", null)).toEqual([]);
    expect(effortArgs("opencode", "high")).toEqual([]);
  });

  it("understands /effort words", () => {
    expect(effortFromCommand("claude", "HIGH")).toBe("high");
    expect(effortFromCommand("claude", "extra high")).toBe("xhigh");
    expect(effortFromCommand("codex", "med")).toBe("medium");
    expect(effortFromCommand("codex", "default")).toBe("");
    expect(effortFromCommand("codex", "max")).toBeNull();
    expect(effortFromCommand("gemini", "high")).toBeNull();
  });
});

describe("effort in launches and turns", () => {
  it("adds the flag to interactive launches", () => {
    expect(interactiveArgs("claude", { session: "s1", model: "opus", effort: "high", cwd: "/w" })).toEqual(["--resume", "s1", "--model", "opus", "--effort", "high"]);
    expect(interactiveArgs("codex", { session: null, effort: "xhigh", cwd: "/w" })).toEqual(["-c", 'model_reasoning_effort="xhigh"']);
    expect(interactiveArgs("gemini", { session: "g", effort: "high", cwd: "/w" })).toEqual(["--resume", "g"]);
    expect(interactiveArgs("claude", { cwd: "/w" })).toEqual([]);
  });

  it("puts effort on Codex's turn/start only when set", () => {
    expect(turnParams("t1", "hi", "high")).toEqual({ threadId: "t1", input: [{ type: "text", text: "hi", text_elements: [] }], effort: "high" });
    expect(turnParams("t1", "hi")).not.toHaveProperty("effort");
  });
});

describe("profile defaultEffort", () => {
  it("accepts the agent's levels and rejects others", () => {
    expect(parseProfile({ id: "c", agent: "codex", defaultEffort: "High" })).toMatchObject({ defaultEffort: "high" });
    expect(parseProfile({ id: "c", agent: "codex", defaultEffort: "" })).not.toHaveProperty("defaultEffort");
    expect(parseProfile({ id: "c", agent: "codex", defaultEffort: "max" })).toMatch(/defaultEffort must be one of low, medium, high, xhigh/);
    expect(parseProfile({ id: "g", agent: "gemini", defaultEffort: "high" })).toMatch(/has no effort levels/);
  });
});

describe("Claude web runs", () => {
  it("start at the asked effort, else the profile's, and switch mid-run", async () => {
    const { Run } = await import("@/lib/server/runner");
    const profile = { id: "claude-x", label: "x", agent: "claude" as const, binPath: null, env: {}, args: [], builtin: false, defaultEffort: "low" };
    calls.length = 0;
    const a = new Run({ cwd: "/tmp", permissionMode: "default", profile });
    expect(calls[0].options.effort).toBe("low");
    const b = new Run({ cwd: "/tmp", permissionMode: "default", profile, effort: null });
    expect(calls[1].options).not.toHaveProperty("effort");
    const c = new Run({ cwd: "/tmp", permissionMode: "default", effort: "xhigh" });
    expect(calls[2].options.effort).toBe("xhigh");

    await c.setEffort("xhigh");
    expect(calls[2].flags).toEqual([]);
    await c.setEffort("high");
    await c.setEffort(null);
    await c.setEffort("bogus");
    expect(calls[2].flags).toEqual([{ effortLevel: "high" }, { effortLevel: null }]);
    expect(c.effort).toBeNull();
    [a, b, c].forEach((r) => r.close());
  });
});
