import { describe, expect, it } from "vitest";
import { absoluteTime, capCount, capRows, groupByProject, groupRows, relativeTime, rovingTarget, sortSessions, tabStop, timeBucket } from "@/lib/client/sidebar";
import type { AgentId } from "@/lib/types";

/* local times: row times follow the device's own clock */
const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();

type S = { id: string; title: string; mtime: number; created?: number; cwd: string; project: string; agent: AgentId };
const s = (id: string, over: Partial<S> = {}): S => ({ id, title: id, mtime: 0, cwd: "/w/a", project: "a", agent: "claude", ...over });
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("sortSessions", () => {
  const rows = [
    s("b", { title: "Fix tests", mtime: 300, created: 100 }),
    s("a", { title: "add auth", mtime: 100, created: 300 }),
    s("c", { title: "Item 10", mtime: 200 }),
    s("d", { title: "Item 9", mtime: 200 }),
  ];

  it("puts the latest activity first and breaks ties by id", () => {
    expect(ids(sortSessions(rows, "activity"))).toEqual(["b", "c", "d", "a"]);
  });

  it("sorts by start time, falling back to last activity where the agent keeps none", () => {
    expect(ids(sortSessions(rows, "created"))).toEqual(["a", "c", "d", "b"]);
  });

  it("sorts titles A to Z, ignoring case and reading numbers as numbers", () => {
    expect(ids(sortSessions(rows, "title"))).toEqual(["a", "b", "d", "c"]);
  });

  it("leaves its input alone", () => {
    const copy = [...rows];
    sortSessions(rows, "title");
    expect(rows).toEqual(copy);
  });
});

describe("groupByProject", () => {
  const rows = [
    s("1", { cwd: "/w/web", project: "web", mtime: 50, title: "z" }),
    s("2", { cwd: "/w/api", project: "api", mtime: 90, title: "y" }),
    s("3", { cwd: "/w/web", project: "web", mtime: 70, title: "a" }),
    s("4", { cwd: "", project: "", mtime: 100, title: "b" }),
  ];

  it("orders folders by their newest session and sorts inside each", () => {
    const g = groupByProject(rows, "activity");
    expect(g.map((p) => p.name)).toEqual(["No folder", "api", "web"]);
    expect(ids(g[2].rows)).toEqual(["3", "1"]);
  });

  it("lists folders A to Z when sorting by title, with No folder last", () => {
    const g = groupByProject(rows, "title");
    expect(g.map((p) => p.name)).toEqual(["api", "web", "No folder"]);
    expect(ids(g[1].rows)).toEqual(["3", "1"]);
  });
});

describe("capRows", () => {
  const rows = ["a", "b", "c", "d", "e", "f"].map((id) => ({ id }));

  it("keeps the first rows and counts the rest", () => {
    expect(capRows(rows, 4)).toEqual({ shown: rows.slice(0, 4), hidden: 2 });
    expect(capRows(rows, null)).toEqual({ shown: rows, hidden: 0 });
    expect(capRows(rows, 10).hidden).toBe(0);
  });

  it("keeps the open session visible when it's past the cap", () => {
    const { shown, hidden } = capRows(rows, 3, "f");
    expect(ids(shown)).toEqual(["a", "b", "c", "f"]);
    expect(hidden).toBe(2);
    expect(ids(capRows(rows, 3, "b").shown)).toEqual(["a", "b", "c"]);
  });

  it("reads the setting's choices", () => {
    expect(capCount("5")).toBe(5);
    expect(capCount("20")).toBe(20);
    expect(capCount("all")).toBeNull();
  });
});

describe("groupRows", () => {
  const now = at(2026, 10, 21, 15);
  const rows = [
    s("old", { mtime: at(2026, 8, 1), agent: "codex" }),
    s("today", { mtime: at(2026, 10, 21, 9) }),
    s("yday", { mtime: at(2026, 10, 20, 9), agent: "codex" }),
  ];

  it("keeps day groups in calendar order whatever the sort", () => {
    expect(groupRows(rows, "time", now).map(([k, v]) => [k, ids(v)])).toEqual([
      ["Today", ["today"]],
      ["Yesterday", ["yday"]],
      ["Older", ["old"]],
    ]);
  });

  it("groups by agent in order of first appearance, or not at all", () => {
    expect(groupRows(rows, "agent", now).map(([k]) => k)).toEqual(["Codex", "Claude"]);
    expect(groupRows(rows, "none", now)).toEqual([["", rows]]);
  });

  it("buckets by calendar day", () => {
    expect(timeBucket(at(2026, 10, 21, 0, 5), now)).toBe("Today");
    expect(timeBucket(at(2026, 10, 16), now)).toBe("This week");
    expect(timeBucket(at(2026, 10, 1), now)).toBe("This month");
  });
});

describe("relativeTime", () => {
  const now = at(2026, 10, 21, 15, 30); /* a Wednesday */
  const r = (ms: number) => relativeTime(ms, now, "en-US");

  it("counts minutes and hours", () => {
    expect(r(now - 20_000)).toBe("now");
    expect(r(now + 5_000)).toBe("now");
    expect(r(now - 2 * 60_000)).toBe("2m");
    expect(r(now - 59 * 60_000)).toBe("59m");
    expect(r(now - 3 * 3_600_000)).toBe("3h");
    expect(r(now - 23 * 3_600_000)).toBe("23h");
  });

  it("names yesterday and the weekday within a week", () => {
    expect(r(at(2026, 10, 20, 9))).toBe("Yesterday");
    expect(r(at(2026, 10, 19, 9))).toBe("Mon");
    expect(r(at(2026, 10, 15, 9))).toBe("Thu");
  });

  it("falls back to the date, with the year only for earlier years", () => {
    expect(r(at(2026, 3, 4))).toBe("Mar 4");
    expect(r(at(2025, 3, 4))).toBe("Mar 2025");
  });
});

describe("absoluteTime", () => {
  const now = at(2026, 10, 21, 15, 30);

  it("shows the clock today and the date before", () => {
    expect(absoluteTime(at(2026, 10, 21, 14, 5), now, "en-GB")).toBe("14:05");
    expect(absoluteTime(at(2026, 10, 21, 14, 5), now, "en-US")).toBe("2:05 PM");
    expect(absoluteTime(at(2026, 10, 20, 23, 59), now, "en-US")).toBe("Oct 20");
    expect(absoluteTime(at(2025, 3, 4), now, "en-US")).toBe("3/4/25");
    expect(absoluteTime(at(2026, 10, 21, 14, 5), now, "en-US", "24h")).toBe("14:05");
    expect(absoluteTime(at(2026, 10, 21, 14, 5), now, "en-GB", "12h")).toMatch(/^2:05\s?pm$/i);
  });
});

describe("rovingTarget", () => {
  it("moves one step without wrapping", () => {
    expect(rovingTarget("ArrowDown", 0, 3)).toBe(1);
    expect(rovingTarget("ArrowDown", 2, 3)).toBe(2);
    expect(rovingTarget("ArrowUp", 1, 3)).toBe(0);
    expect(rovingTarget("ArrowUp", 0, 3)).toBe(0);
  });

  it("jumps to the ends", () => {
    expect(rovingTarget("Home", 2, 5)).toBe(0);
    expect(rovingTarget("End", 0, 5)).toBe(4);
  });

  it("starts from an edge when nothing is focused, and ignores other keys", () => {
    expect(rovingTarget("ArrowDown", -1, 3)).toBe(0);
    expect(rovingTarget("ArrowUp", -1, 3)).toBe(2);
    expect(rovingTarget("Enter", 1, 3)).toBeNull();
    expect(rovingTarget("ArrowDown", 0, 0)).toBeNull();
  });
});

describe("tabStop", () => {
  const keys = ["section:Pinned", "row:a", "project:/w", "row:b", "row:c"];

  it("stays on the item focused last", () => {
    expect(tabStop(keys, "row:b", "row:a")).toBe(3);
  });

  it("falls back to the open session's row, then near where the last one was", () => {
    expect(tabStop(keys, null, "row:c")).toBe(4);
    expect(tabStop(keys, "row:gone", "row:also-gone", 3)).toBe(3);
    expect(tabStop(keys, "row:gone", null, 9)).toBe(4);
    expect(tabStop(keys, null, null)).toBe(0);
  });

  it("has none in an empty list", () => {
    expect(tabStop([], "row:a", null)).toBe(-1);
  });
});
