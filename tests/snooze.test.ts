import { describe, expect, it } from "vitest";
import { snoozePresets, wakeLabel } from "@/lib/client/snooze";

/* local times: the presets follow the device's own clock */
const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min);
const ids = (now: Date) => snoozePresets(now).map((p) => p.id);
const preset = (now: Date, id: string) => snoozePresets(now).find((p) => p.id === id);

describe("snoozePresets", () => {
  it("offers an hour, tonight, tomorrow and next Monday on a weekday morning", () => {
    const now = at(2026, 10, 20, 10, 15); /* a Tuesday */
    expect(ids(now)).toEqual(["hour", "tonight", "tomorrow", "next-week"]);
    expect(preset(now, "hour")!.at).toBe(now.getTime() + 3_600_000);
    expect(preset(now, "tonight")!.at).toBe(at(2026, 10, 20, 18).getTime());
    expect(preset(now, "tomorrow")!.at).toBe(at(2026, 10, 21, 9).getTime());
    expect(preset(now, "next-week")!.at).toBe(at(2026, 10, 26, 9).getTime());
  });

  it("drops tonight once 18:00 is less than an hour away", () => {
    expect(ids(at(2026, 10, 20, 17, 0))).not.toContain("tonight");
    expect(ids(at(2026, 10, 20, 16, 59))).toContain("tonight");
    expect(ids(at(2026, 10, 20, 22))).not.toContain("tonight");
  });

  it("goes to the Monday after on a Monday, and skips next week on a Sunday", () => {
    expect(preset(at(2026, 10, 19, 8), "next-week")!.at).toBe(at(2026, 10, 26, 9).getTime());
    expect(ids(at(2026, 10, 25, 12))).toEqual(["hour", "tonight", "tomorrow"]);
    expect(preset(at(2026, 10, 25, 12), "tomorrow")!.at).toBe(at(2026, 10, 26, 9).getTime());
  });

  it("shows each preset's resolved time", () => {
    for (const p of snoozePresets(at(2026, 10, 20, 10))) expect(p.when).toMatch(/\d/);
    expect(preset(at(2026, 10, 20, 10), "next-week")!.when).toContain(at(2026, 10, 26, 9).toLocaleDateString(undefined, { weekday: "short" }));
  });
});

describe("wakeLabel", () => {
  const now = at(2026, 10, 20, 10).getTime();
  it("is a time today, a weekday and time this week, a date after that", () => {
    expect(wakeLabel(at(2026, 10, 20, 18).getTime(), now)).toBe(at(2026, 10, 20, 18).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
    expect(wakeLabel(at(2026, 10, 21, 9).getTime(), now)).toMatch(new RegExp(`^${at(2026, 10, 21, 9).toLocaleDateString(undefined, { weekday: "short" })} `));
    expect(wakeLabel(at(2026, 11, 2, 9).getTime(), now)).toBe(at(2026, 11, 2, 9).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
  });
});
