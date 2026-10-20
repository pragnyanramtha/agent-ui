import { describe, expect, it } from "vitest";
import { addCall, buildReport, chartSeries, dayKey, dayStack, lastDays, modelPrice, niceMax, safeZone, SLOT_MS, tokSum, type SessionUsage, type Slots } from "@/lib/usage-report";

const NOW = Date.UTC(2026, 9, 19, 12, 0); // Mon 19 Oct 2026, 12:00 UTC
const H = 3_600_000;
const D = 24 * H;

function session(key: string, calls: [number, string, number, number?][], extra: Partial<SessionUsage> = {}): SessionUsage {
  const slots: Slots = new Map();
  let last = 0;
  for (const [ts, model, output, input = 0] of calls) {
    addCall(slots, ts, model, { input, output, cacheRead: 0, cacheWrite: 0 });
    last = Math.max(last, ts);
  }
  return { key, agent: "claude", cwd: "/work/alpha", profile: "claude", slots, last, ...extra };
}

describe("days in a time zone", () => {
  it("buckets by the reader's calendar day", () => {
    const late = Date.UTC(2026, 9, 18, 22, 30);
    expect(dayKey(late, "UTC")).toBe("2026-10-18");
    expect(dayKey(late, "Asia/Kolkata")).toBe("2026-10-19");
    expect(dayKey(late, "America/Los_Angeles")).toBe("2026-10-18");
    expect(dayKey(Date.UTC(2026, 9, 19, 6, 59), "America/Los_Angeles")).toBe("2026-10-18");
  });

  it("lists calendar days across a daylight saving change", () => {
    /* Europe/Berlin falls back on 25 Oct 2026; a 25-hour day must not skip or repeat a date */
    const days = lastDays(Date.UTC(2026, 9, 27, 9), "Europe/Berlin", 5);
    expect(days).toEqual(["2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27"]);
  });

  it("keeps 15-minute slots on half and quarter hour zones", () => {
    /* 18:15 UTC is 00:00 in Nepal (UTC+5:45): the slot that starts then is the new day */
    const slotStart = Date.UTC(2026, 9, 18, 18, 15);
    expect(slotStart % SLOT_MS).toBe(0);
    expect(dayKey(slotStart, "Asia/Kathmandu")).toBe("2026-10-19");
    expect(dayKey(slotStart - SLOT_MS, "Asia/Kathmandu")).toBe("2026-10-18");
  });

  it("falls back to UTC for a zone it doesn't know", () => {
    expect(safeZone("Mars/Olympus")).toBe("UTC");
    expect(safeZone(42)).toBe("UTC");
    expect(safeZone("Asia/Tokyo")).toBe("Asia/Tokyo");
  });
});

describe("slots", () => {
  it("adds and takes back calls", () => {
    const slots: Slots = new Map();
    const k = addCall(slots, NOW, "claude-sonnet-4-5", { input: 10, output: 5 });
    addCall(slots, NOW + 60_000, "claude-sonnet-4-5", { input: 1, output: 1 });
    expect(slots.get(k!)).toEqual({ input: 11, cacheRead: 0, cacheWrite: 0, output: 6, calls: 2 });
    addCall(slots, NOW, "claude-sonnet-4-5", { input: 10, output: 5 }, -1);
    addCall(slots, NOW, "claude-sonnet-4-5", { input: 1, output: 1 }, -1);
    expect(slots.size).toBe(0);
  });

  it("ignores calls without a usable time and bad numbers", () => {
    const slots: Slots = new Map();
    expect(addCall(slots, NaN, "m", { input: 1 })).toBeNull();
    addCall(slots, NOW, "m", { input: -5, output: Number.NaN, cacheRead: 3 });
    expect([...slots.values()][0]).toEqual({ input: 0, cacheRead: 3, cacheWrite: 0, output: 0, calls: 1 });
  });
});

describe("prices", () => {
  it("prices known models and leaves unknown ones out", () => {
    expect(modelPrice("claude-opus-4-5-20251101").label).toBe("Opus 4.5+");
    expect(modelPrice("gpt-5.4").label).toBe("GPT-5.4");
    expect(modelPrice("cursor").rate).toBeNull();
    expect(modelPrice("").rate).toBeNull();
  });
});

describe("buildReport", () => {
  const sonnet = "claude-sonnet-4-5";
  const sessions = [
    session("a", [
      [NOW - H, sonnet, 1_000_000],
      [NOW - 3 * D, sonnet, 1_000_000],
      [NOW - 20 * D, sonnet, 1_000_000],
      [NOW - 60 * D, sonnet, 1_000_000],
    ]),
    session("codex:b", [[NOW - 2 * H, "gpt-5.4", 0, 2_000_000]], { agent: "codex", cwd: "/work/beta", profile: "codx" }),
    session("cursor:c", [[NOW - 2 * H, "cursor", 0, 500_000]], { agent: "cursor", cwd: "/work/beta", profile: "cursor" }),
    session("old", [[NOW - 200 * D, sonnet, 1_000_000]]),
  ];

  it("totals today, 7 days and 30 days, with unknown models as tokens only", () => {
    const r = buildReport({ sessions, now: NOW, tz: "UTC", days: 30 });
    /* sonnet output is $15 per million, gpt-5.4 input $2.50 per million */
    expect(r.totals.today.usd).toBeCloseTo(15 + 5, 6);
    expect(r.totals.today.unpriced).toBe(500_000);
    expect(r.totals.week.usd).toBeCloseTo(35, 6);
    expect(r.totals.month.usd).toBeCloseTo(50, 6);
    expect(r.daily).toHaveLength(30);
    expect(r.daily.at(-1)!.day).toBe("2026-10-19");
    expect(r.daily.at(-1)!.byAgent.claude.usd).toBeCloseTo(15, 6);
    expect(r.daily.at(-1)!.byModel["gpt-5.4"].usd).toBeCloseTo(5, 6);
  });

  it("ranks top sessions and projects by spend, then tokens", () => {
    const r = buildReport({ sessions, now: NOW, tz: "UTC", days: 30, titleOf: (s) => `T ${s.key}` });
    expect(r.sessions.map((s) => s.key)).toEqual(["a", "codex:b", "cursor:c"]);
    expect(r.sessions[0].title).toBe("T a");
    expect(r.projects.map((p) => [p.project, p.sessions])).toEqual([
      ["alpha", 1],
      ["beta", 2],
    ]);
    expect(r.models.find((m) => m.model === "cursor")?.price).toBeNull();
  });

  it("widens to 90 days and never reads past it", () => {
    const r = buildReport({ sessions, now: NOW, tz: "UTC", days: 90 });
    expect(r.daily).toHaveLength(90);
    expect(r.sessions.find((s) => s.key === "a")!.sum.usd).toBeCloseTo(60, 6);
    expect(r.sessions.some((s) => s.key === "old")).toBe(false);
    expect(r.totals.month.usd).toBeCloseTo(50, 6);
  });

  it("filters by agent, profile and project, and offers every choice regardless", () => {
    const byAgent = buildReport({ sessions, now: NOW, tz: "UTC", days: 30, filters: { agent: "codex" } });
    expect(byAgent.sessions.map((s) => s.key)).toEqual(["codex:b"]);
    expect(byAgent.totals.today.usd).toBeCloseTo(5, 6);
    expect(byAgent.options.agents).toEqual(["claude", "codex", "cursor"]);
    const byProfile = buildReport({ sessions, now: NOW, tz: "UTC", days: 30, filters: { profile: "cursor" }, profileLabel: (id) => id.toUpperCase() });
    expect(byProfile.sessions.map((s) => s.key)).toEqual(["cursor:c"]);
    expect(byProfile.options.profiles).toContainEqual({ id: "codx", label: "CODX" });
    const byProject = buildReport({ sessions, now: NOW, tz: "UTC", days: 30, filters: { project: "/work/beta" } });
    expect(byProject.sessions.map((s) => s.key).sort()).toEqual(["codex:b", "cursor:c"]);
    expect(byProject.options.projects.map((p) => p.cwd).sort()).toEqual(["/work/alpha", "/work/beta"]);
  });

  it("counts deleted sessions but never lists them", () => {
    const r = buildReport({ sessions, now: NOW, tz: "UTC", days: 30, hidden: (k) => k === "a" });
    expect(r.sessions.some((s) => s.key === "a")).toBe(false);
    expect(r.totals.today.usd).toBeCloseTo(20, 6);
  });

  it("moves a late call to the next day in a zone ahead of UTC", () => {
    const late = session("late", [[Date.UTC(2026, 9, 18, 20, 0), sonnet, 1_000_000]]);
    expect(buildReport({ sessions: [late], now: NOW, tz: "UTC", days: 7 }).totals.today.calls).toBe(0);
    expect(buildReport({ sessions: [late], now: NOW, tz: "Asia/Tokyo", days: 7 }).totals.today.calls).toBe(1);
  });
});

describe("chart", () => {
  const sessions = ["m1", "m2", "m3", "m4"].map((m, i) => session(`s${i}`, [[NOW - H, `gpt-5.${i}`, 1_000_000 * (i + 1)]], { agent: i % 2 ? "codex" : "claude" }));
  const r = buildReport({ sessions, now: NOW, tz: "UTC", days: 7 });

  it("keeps the biggest groups and puts the rest in Other", () => {
    const { series, other } = chartSeries(r.daily, "model", (id) => id, 3);
    expect(series.map((s) => s.id)).toEqual(["gpt-5.3", "gpt-5.2"]);
    expect(other).toBe(true);
    const stack = dayStack(r.daily.at(-1)!, "model", series, other, "tokens");
    expect(stack).toEqual([4_000_000, 3_000_000, 3_000_000]);
    expect(stack.reduce((a, b) => a + b, 0)).toBe(tokSum(r.daily.at(-1)!.total));
  });

  it("groups by agent", () => {
    const { series, other } = chartSeries(r.daily, "agent", (id) => id);
    expect(series.map((s) => s.id).sort()).toEqual(["claude", "codex"]);
    expect(other).toBe(false);
  });

  it("rounds the axis up", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(3.2)).toBe(5);
    expect(niceMax(12)).toBe(20);
    expect(niceMax(100)).toBe(100);
  });
});
