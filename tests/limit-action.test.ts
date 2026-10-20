import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedProfile } from "@/lib/server/profiles";
import type { ServerEvent } from "@/lib/types";

/* a fake agent: turns end when the test says, failing with whatever `agent.error` holds */
const sends: { text: string; profile: string }[] = [];
const turns: ((s: { status: string; error?: string | null }) => void)[] = [];
const agent = { error: "You've hit your usage limit.", status: "failed" };
const settings: Record<string, unknown> = {};
let activeProfile = "";

vi.mock("@/lib/server/agents/cli-run", () => ({ onTurn: (_key: string, fn: (typeof turns)[number]) => (turns.push(fn), () => undefined) }));
vi.mock("@/lib/server/agents", () => ({
  adapterFor: async () => ({
    runState: () => ({ status: agent.status, error: agent.error }),
    history: async () => ({ entries: [], cursor: null, end: "0" }),
    send: async (_native: string, text: string) => void sends.push({ text, profile: activeProfile }),
  }),
  parseSessionKey: (k: string) => ({ agent: k.slice(0, k.indexOf(":")), native: k.slice(k.indexOf(":") + 1) }),
  sessionKey: (a: string, native: string) => `${a}:${native}`,
}));
vi.mock("@/lib/server/settings", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/settings")>()),
  syncedSetting: (key: string) => settings[key] ?? (key === "limitAction" ? "fallback" : undefined),
}));

const profile = (id: string, extra: Partial<ResolvedProfile> = {}) =>
  ({ id, label: id, agent: "codex", bin: "", args: [], env: {}, models: [], fallback: [], binPath: "/bin/true", builtin: false, ...extra }) as unknown as ResolvedProfile;
const backup = profile("codex-backup");
const main = profile("codex-main", { fallback: [backup.id] });
const lone = profile("codex-lone");

vi.mock("@/lib/server/profiles", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/profiles")>()),
  getProfile: (id: string) => (id === backup.id ? backup : null),
  setSessionProfile: () => undefined,
  withProfile: async (p: ResolvedProfile, fn: () => unknown) => {
    activeProfile = p.id;
    return fn();
  },
}));

const { guardTurn, onSessionEvent, RESEND_SLACK_MS } = await import("@/lib/server/fallback");

let n = 0;
function start(p: ResolvedProfile, error: string) {
  const key = `codex:t${++n}`;
  const notices: string[] = [];
  onSessionEvent(key, (e: ServerEvent) => {
    if (e.type === "entries") for (const x of e.entries) if (x.kind === "notice") notices.push(x.text);
  });
  agent.error = error;
  agent.status = "failed";
  const before = turns.length;
  guardTurn({ key, text: "do it", mode: "default", profile: p });
  return { key, notices, watched: turns.length > before, end: () => turns[turns.length - 1]({ status: "failed", error }) };
}

beforeEach(() => {
  sends.length = 0;
  turns.length = 0;
  for (const k of Object.keys(settings)) delete settings[k];
});
afterEach(() => vi.useRealTimers());

describe("what a usage limit does", () => {
  it("switches to the fallback profile by default", async () => {
    const t = start(main, "You've hit your usage limit.");
    t.end();
    await vi.waitFor(() => expect(sends).toEqual([{ text: "do it", profile: "codex-backup" }]));
    expect(t.notices[0]).toMatch(/Switching to codex-backup/);
  });

  it("stops there when set to Stop, fallbacks or not", () => {
    settings.limitAction = "stop";
    expect(start(main, "usage limit").watched).toBe(false);
    expect(sends).toEqual([]);
  });

  it("waits for the reset and sends the message again under the same profile", async () => {
    vi.useFakeTimers();
    settings.limitAction = "wait";
    const t = start(lone, "You've hit your usage limit. Try again in 5 minutes.");
    expect(t.watched).toBe(true);
    t.end();
    await vi.waitFor(() => expect(t.notices[0]).toMatch(/Sending your message again when it resets, in 6 min\./));
    await vi.advanceTimersByTimeAsync(5 * 60_000 + RESEND_SLACK_MS - 2000);
    expect(sends).toEqual([]);
    /* the agent is free again by then */
    agent.status = "idle";
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(sends).toEqual([{ text: "do it", profile: "codex-lone" }]));
    /* and the resent turn is watched in turn */
    expect(turns.length).toBe(2);
  });

  it("falls back when the limit doesn't say when it resets", async () => {
    settings.limitAction = "wait";
    const t = start(main, "rate limit exceeded");
    t.end();
    await vi.waitFor(() => expect(sends).toEqual([{ text: "do it", profile: "codex-backup" }]));
  });

  it("says so when there's neither a reset time nor a fallback", async () => {
    settings.limitAction = "wait";
    const t = start(lone, "rate limit exceeded");
    t.end();
    await vi.waitFor(() => expect(t.notices[0]).toMatch(/didn't say when the limit resets, and this profile has no fallback/));
    expect(sends).toEqual([]);
  });

  it("gives up waiting when a new message is sent meanwhile", async () => {
    vi.useFakeTimers();
    settings.limitAction = "wait";
    const t = start(lone, "usage limit reached, retry in 30s");
    t.end();
    await vi.waitFor(() => expect(t.notices).toHaveLength(1));
    agent.status = "running";
    guardTurn({ key: t.key, text: "something else", mode: "default", profile: lone });
    agent.status = "idle";
    await vi.advanceTimersByTimeAsync(30_000 + RESEND_SLACK_MS + 1000);
    expect(sends).toEqual([]);
  });

  it("doesn't send again over a turn that's already running", async () => {
    vi.useFakeTimers();
    settings.limitAction = "wait";
    const t = start(lone, "usage limit reached, retry in 30s");
    t.end();
    await vi.waitFor(() => expect(t.notices).toHaveLength(1));
    agent.status = "running";
    await vi.advanceTimersByTimeAsync(30_000 + RESEND_SLACK_MS + 1000);
    expect(sends).toEqual([]);
  });
});
