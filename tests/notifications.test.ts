import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alertFor, attentionCount, nextFailedSeen, pushWanted, type NotifyPrefs } from "@/lib/notify-prefs";
import { wanted } from "@/lib/server/notify";
import { badgeMark, titleFor } from "@/lib/client/attention";
import { gainFor, tonePlan } from "@/lib/client/sounds";
import { MAX_TOASTS, addToast, durationFor, expiredToasts, markLeaving, nextDeadline, pauseToasts, removeToasts, resumeToasts, type Toast } from "@/lib/client/toast-queue";
import { DEFAULTS, searchSettings, settingsIn } from "@/lib/settings-schema";
import type { PushMessage } from "@/lib/server/push";
import type { PendingAsk, RunState, SessionSummary } from "@/lib/types";

const prefs = (p: Partial<NotifyPrefs> = {}): NotifyPrefs => ({ ...DEFAULTS, ...p });

const run = (status: RunState["status"], pending: PendingAsk[] = [], error: string | null = null): RunState => ({
  status,
  model: null,
  permissionMode: "default",
  slashCommands: [],
  pending,
  error,
  costUsd: null,
  sessionId: "x",
});
const ask: PendingAsk = { kind: "permission", requestId: "r", toolName: "Bash", title: "Run it", description: null, input: {}, canAlwaysAllow: false };
const row = (id: string, web: RunState | null): SessionSummary => ({ id, agent: "gemini", title: id, cwd: "/w", project: "w", mtime: 0, size: 0, terminal: null, web });

describe("event choices", () => {
  it("pushes only the events that are on, nothing during do not disturb, and always a test", () => {
    expect(pushWanted("done", prefs())).toBe(true);
    expect(pushWanted("done", prefs({ notifyDone: false }))).toBe(false);
    expect(pushWanted("needs", prefs({ notifyDone: false }))).toBe(true);
    expect(pushWanted("failed", prefs({ notifyFailed: false }))).toBe(false);
    expect(pushWanted("needs", prefs({ notifyDnd: true }))).toBe(false);
    expect(pushWanted("test", prefs({ notifyDnd: true, notifyDone: false }))).toBe(true);
  });

  it("filters the server's pushes with the synced settings", () => {
    const m = (kind: PushMessage["kind"]): PushMessage => ({ kind, title: kind, body: "", tag: kind, url: "/" });
    const all = [m("done"), m("needs"), m("failed")];
    expect(wanted(all, {}).map((x) => x.kind)).toEqual(["done", "needs", "failed"]);
    expect(wanted(all, { notifyDone: false, notifyFailed: false }).map((x) => x.kind)).toEqual(["needs"]);
    expect(wanted(all, { notifyDnd: true })).toEqual([]);
  });

  it("never alerts for the session on screen, and waits for the background in away mode", () => {
    const here = { onScreen: false, away: false };
    expect(alertFor("done", prefs(), here)).toEqual({ toast: true, sound: false });
    expect(alertFor("done", prefs({ notifySound: true }), here)).toEqual({ toast: true, sound: true });
    expect(alertFor("done", prefs({ notifySound: true }), { onScreen: true, away: false })).toEqual({ toast: false, sound: false });
    expect(alertFor("needs", prefs({ notifyWhen: "away" }), here)).toEqual({ toast: false, sound: false });
    expect(alertFor("needs", prefs({ notifyWhen: "away" }), { onScreen: false, away: true })).toEqual({ toast: true, sound: false });
    expect(alertFor("failed", prefs({ notifyFailed: false }), here).toast).toBe(false);
    expect(alertFor("failed", prefs({ notifyDnd: true, notifySound: true }), here)).toEqual({ toast: false, sound: false });
    expect(alertFor("done", prefs({ notifyToasts: false, notifySound: true }), here)).toEqual({ toast: false, sound: true });
  });
});

describe("tab attention", () => {
  const sessions = [row("a", run("idle", [ask])), row("b", run("idle")), row("c", run("error", [], "boom")), row("d", run("running"))];
  const base = { finished: { b: 1 }, failedSeen: {}, onScreen: null, prefs: prefs() };

  it("counts approvals, unread finishes and unseen failures", () => {
    expect(attentionCount(sessions, base)).toBe(3);
  });

  it("leaves out the session on screen and events that are off", () => {
    expect(attentionCount(sessions, { ...base, onScreen: "a" })).toBe(2);
    expect(attentionCount(sessions, { ...base, prefs: prefs({ notifyNeeds: false, notifyDone: false }) })).toBe(1);
  });

  it("stops counting a failure once it was looked at, and counts the next one", () => {
    let seen = nextFailedSeen({}, sessions, null);
    expect(seen).toEqual({});
    seen = nextFailedSeen(seen, sessions, "c");
    expect(seen).toEqual({ c: "boom" });
    expect(nextFailedSeen(seen, sessions, "c")).toBe(seen);
    expect(attentionCount(sessions, { ...base, failedSeen: seen })).toBe(2);
    /* a new turn clears it; failing again counts again */
    const working = sessions.map((s) => (s.id === "c" ? row("c", run("running")) : s));
    seen = nextFailedSeen(seen, working, null);
    expect(seen).toEqual({});
    expect(attentionCount(sessions, { ...base, failedSeen: seen })).toBe(3);
  });

  it("writes the count into the title and the icon", () => {
    expect(titleFor("agent-u", 0, "count")).toBe("agent-u");
    expect(titleFor("agent-u", 2, "count")).toBe("(2) agent-u");
    expect(titleFor("Fix login · agent-u", 3, "dot")).toBe("(3) Fix login · agent-u");
    expect(titleFor("agent-u", 2, "off")).toBe("agent-u");
    expect(titleFor("agent-u", 250, "count")).toBe("(99+) agent-u");
    expect(badgeMark(0, "count")).toEqual({ kind: "none" });
    expect(badgeMark(4, "off")).toEqual({ kind: "none" });
    expect(badgeMark(4, "dot")).toEqual({ kind: "dot" });
    expect(badgeMark(4, "count")).toEqual({ kind: "count", text: "4" });
    expect(badgeMark(12, "count")).toEqual({ kind: "count", text: "9+" });
  });
});

describe("toast queue", () => {
  const add = (list: Toast[], title: string, extra: Partial<Parameters<typeof addToast>[1]> = {}, id = list.length + 1, now = 0, running = true) => addToast(list, { title, ...extra }, id, now, running);

  it("picks a time by tone, longer with an action, and none when asked", () => {
    expect(durationFor({ title: "x" })).toBe(4000);
    expect(durationFor({ title: "x", tone: "error" })).toBe(8000);
    expect(durationFor({ title: "x", action: { label: "Undo", run: () => undefined } })).toBe(6000);
    expect(durationFor({ title: "x", duration: 0 })).toBe(0);
  });

  it("stacks newest last, replaces one with the same key, and keeps a few at most", () => {
    let list: Toast[] = [];
    list = add(list, "one", { key: "a" }, 1);
    list = add(list, "two", {}, 2);
    list = add(list, "one again", { key: "a" }, 3);
    expect(list.map((t) => t.title)).toEqual(["two", "one again"]);
    for (let i = 4; i < 10; i++) list = add(list, `n${i}`, {}, i);
    expect(list).toHaveLength(MAX_TOASTS);
    expect(list.at(-1)?.title).toBe("n9");
    expect(list[0].title).toBe("n6");
  });

  it("keeps the time left across pauses", () => {
    let list = add([], "x", { duration: 1000 }, 1, 0);
    expect(nextDeadline(list, 0)).toBe(1000);
    list = pauseToasts(list, 400);
    expect(list[0].remaining).toBe(600);
    expect(nextDeadline(list, 5000)).toBeNull();
    expect(expiredToasts(list, 99_999)).toEqual([]);
    list = resumeToasts(list, 10_000);
    expect(nextDeadline(list, 10_000)).toBe(10_600);
    expect(expiredToasts(list, 10_599)).toEqual([]);
    expect(expiredToasts(list, 10_600)).toEqual([1]);
  });

  it("starts paused when added in the background, and never expires a toast with no limit", () => {
    let list = add([], "away", {}, 1, 0, false);
    list = add(list, "sticky", { duration: 0 }, 2, 0, true);
    expect(nextDeadline(list, 0)).toBeNull();
    expect(expiredToasts(list, 1e9)).toEqual([]);
  });

  it("lets a closing toast finish leaving without counting it", () => {
    let list = add([], "a", {}, 1);
    list = markLeaving(list, [1]);
    expect(expiredToasts(list, 1e9)).toEqual([]);
    list = add(list, "b", {}, 2);
    expect(list.map((t) => [t.title, Boolean(t.leaving)])).toEqual([
      ["a", true],
      ["b", false],
    ]);
    expect(removeToasts(list, [1]).map((t) => t.title)).toEqual(["b"]);
  });
});

describe("toast store", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("dismisses on time, and holds while hovered or in the background", async () => {
    vi.resetModules();
    const store = await import("@/lib/client/toast");
    const titles = () => current(store);
    store.toast({ title: "hello", duration: 1000 });
    store.holdToasts(true);
    vi.advanceTimersByTime(5000);
    expect(titles()).toEqual(["hello"]);
    store.holdToasts(false);
    store.setToastsAway(true);
    vi.advanceTimersByTime(5000);
    expect(titles()).toEqual(["hello"]);
    store.setToastsAway(false);
    vi.advanceTimersByTime(1000 + 200);
    expect(titles()).toEqual([]);
  });

  it("forgets the hover when the last toast closes under the pointer", async () => {
    vi.resetModules();
    const store = await import("@/lib/client/toast");
    const id = store.toast({ title: "a", duration: 1000 });
    store.holdToasts(true);
    store.dismissToast(id);
    vi.advanceTimersByTime(300);
    store.toast({ title: "b", duration: 1000 });
    vi.advanceTimersByTime(1300);
    expect(current(store)).toEqual([]);
  });
});

const current = (store: typeof import("@/lib/client/toast")) => store.peekToasts().filter((t) => !t.leaving).map((t) => t.title);

describe("sounds", () => {
  it("has a short distinct tone for each event", () => {
    const plans = (["done", "needs", "failed"] as const).map(tonePlan);
    for (const p of plans) {
      expect(p.length).toBeGreaterThan(0);
      expect(Math.max(...p.map((n) => n.at + n.dur))).toBeLessThan(0.6);
    }
    expect(new Set(plans.map((p) => JSON.stringify(p))).size).toBe(3);
  });

  it("maps volume to a gain that stays well under clipping", () => {
    expect(gainFor(0)).toBe(0);
    expect(gainFor(100)).toBeCloseTo(0.3);
    expect(gainFor(50)).toBeLessThan(gainFor(100) / 2);
    expect(gainFor(500)).toBeCloseTo(0.3);
  });
});

describe("settings", () => {
  it("lists the notification settings in their section, with push events synced and delivery per device", () => {
    const defs = settingsIn("notifications");
    const scope = Object.fromEntries(defs.map((d) => [d.key, d.scope]));
    expect(scope).toMatchObject({ notifyDnd: "synced", notifyDone: "synced", notifyNeeds: "synced", notifyFailed: "synced", notifyToasts: "device", notifySound: "device", notifyVolume: "device", notifyWhen: "device", notifyBadge: "device" });
    expect(searchSettings("favicon")[0]?.settings).toContain("notifyBadge");
    expect(searchSettings("test notification")[0]?.items).toContain("test");
  });
});
