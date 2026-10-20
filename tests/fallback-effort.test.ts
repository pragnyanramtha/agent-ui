import { describe, expect, it, vi } from "vitest";
import type { ResolvedProfile } from "@/lib/server/profiles";

const sends: { text: string; o: Record<string, unknown> }[] = [];
const turns: ((s: { status: string; error?: string | null }) => void)[] = [];

vi.mock("@/lib/server/agents/cli-run", () => ({ onTurn: (_key: string, fn: (typeof turns)[number]) => (turns.push(fn), () => undefined) }));
vi.mock("@/lib/server/agents", () => ({
  adapterFor: async () => ({
    runState: () => ({ status: "failed", error: "You've hit your usage limit." }),
    history: async () => ({ entries: [], cursor: null, end: "0" }),
    send: async (_native: string, text: string, o: Record<string, unknown>) => void sends.push({ text, o }),
  }),
  parseSessionKey: (k: string) => ({ agent: k.slice(0, k.indexOf(":")), native: k.slice(k.indexOf(":") + 1) }),
  sessionKey: (agent: string, native: string) => `${agent}:${native}`,
}));

const profile = (id: string, extra: Partial<ResolvedProfile> = {}) =>
  ({ id, label: id, agent: "codex", bin: "", args: [], env: {}, models: [], fallback: [], binPath: "/bin/true", builtin: false, ...extra }) as unknown as ResolvedProfile;
const backup = profile("codex-backup", { defaultEffort: "low" } as Partial<ResolvedProfile>);

vi.mock("@/lib/server/profiles", async (orig) => ({ ...(await orig<typeof import("@/lib/server/profiles")>()), getProfile: (id: string) => (id === backup.id ? backup : null) }));

const { guardTurn } = await import("@/lib/server/fallback");

async function failOnce(effort: string | null | undefined) {
  sends.length = 0;
  turns.length = 0;
  guardTurn({ key: `codex:t-${String(effort)}`, text: "do it", mode: "default", effort, profile: profile("codex-main", { fallback: [backup.id] }) });
  turns[0]({ status: "failed", error: "usage limit" });
  await vi.waitFor(() => expect(sends).toHaveLength(1));
  return sends[0].o.effort;
}

describe("failing over on a usage limit", () => {
  it("keeps the effort the turn was sent with", async () => {
    expect(await failOnce("high")).toBe("high");
  });

  it("uses the fallback profile's default when the turn had none, and the model's when Default was picked", async () => {
    expect(await failOnce(undefined)).toBe("low");
    expect(await failOnce(null)).toBeUndefined();
  });
});
