import { describe, expect, it } from "vitest";
import { clockTime, dayStamp, fullDateTime, timeOptions, upcomingTime } from "@/lib/time-format";

const now = new Date(2026, 9, 19, 12, 0);
const at = (y: number, m: number, d: number, h = 14, min = 2) => new Date(y, m, d, h, min).getTime();
/* ICU puts a narrow no-break space before AM/PM */
const plain = (s: string) => s.replace(/[\u202f\u00a0]/g, " ");

describe("clockTime", () => {
  it("follows the locale's hour cycle on System", () => {
    expect(plain(clockTime(at(2026, 9, 19), "system", "en-US"))).toBe("2:02 PM");
    expect(clockTime(at(2026, 9, 19), "system", "en-GB")).toBe("14:02");
    expect(clockTime(at(2026, 9, 19), "system", "de-DE")).toBe("14:02");
  });

  it("forces 12-hour, whatever the locale", () => {
    expect(plain(clockTime(at(2026, 9, 19), "12h", "en-US"))).toBe("2:02 PM");
    expect(plain(clockTime(at(2026, 9, 19), "12h", "en-GB"))).toMatch(/^2:02 pm$/i);
    expect(plain(clockTime(at(2026, 9, 19, 0, 5), "12h", "en-US"))).toBe("12:05 AM");
  });

  it("forces 24-hour with two-digit hours, whatever the locale", () => {
    expect(clockTime(at(2026, 9, 19), "24h", "en-US")).toBe("14:02");
    expect(clockTime(at(2026, 9, 19, 9, 5), "24h", "en-US")).toBe("09:05");
    expect(clockTime(at(2026, 9, 19, 0, 5), "24h", "en-US")).toBe("00:05");
  });

  it("takes ms, ISO strings and dates, and is empty for nothing readable", () => {
    const d = new Date(2026, 9, 19, 14, 2);
    expect(clockTime(d.toISOString(), "24h", "en-US")).toBe("14:02");
    expect(clockTime(d, "24h", "en-US")).toBe("14:02");
    expect(clockTime("", "24h")).toBe("");
    expect(clockTime("not a date", "24h")).toBe("");
  });

  it("only System leaves the hour cycle to the locale", () => {
    expect(timeOptions("system").hourCycle).toBeUndefined();
    expect(timeOptions("12h").hourCycle).toBe("h12");
    expect(timeOptions("24h").hourCycle).toBe("h23");
  });
});

describe("thread time dividers", () => {
  it("say Today and Yesterday for the last two days", () => {
    expect(dayStamp(at(2026, 9, 19), "system", now, "en-US")).toMatch(/^Today /);
    expect(dayStamp(at(2026, 9, 18), "system", now, "en-US")).toMatch(/^Yesterday /);
  });

  it("leave the year out within this year", () => {
    expect(dayStamp(at(2026, 9, 6), "system", now, "en-US")).toMatch(/^Tue, Oct 6 · /);
  });

  it("add the year for messages from another year", () => {
    expect(dayStamp(at(2025, 9, 6), "system", now, "en-US")).toMatch(/^Mon, Oct 6, 2025 · /);
    /* yesterday across New Year still reads as Yesterday */
    expect(dayStamp(at(2025, 11, 31), "system", new Date(2026, 0, 1, 9, 0), "en-US")).toMatch(/^Yesterday /);
  });

  it("read the same time as the message stamp in every format", () => {
    const t = at(2026, 9, 18);
    for (const fmt of ["system", "12h", "24h"] as const) {
      expect(dayStamp(t, fmt, now, "en-US")).toBe(`Yesterday ${clockTime(t, fmt, "en-US")}`);
    }
    expect(dayStamp(t, "24h", now, "en-US")).toBe("Yesterday 14:02");
    expect(plain(dayStamp(t, "12h", now, "en-US"))).toBe("Yesterday 2:02 PM");
    expect(plain(dayStamp(at(2026, 9, 6, 9, 30), "12h", now, "en-US"))).toBe("Tue, Oct 6 · 9:30 AM");
    expect(dayStamp(at(2026, 9, 6, 9, 30), "24h", now, "en-US")).toBe("Tue, Oct 6 · 09:30");
  });
});

describe("fullDateTime", () => {
  it("spells out the date and uses the chosen hour cycle", () => {
    expect(plain(fullDateTime(at(2026, 9, 19), "12h", "en-US"))).toBe("Mon, Oct 19, 2026, 2:02 PM");
    expect(fullDateTime(at(2026, 9, 19), "24h", "en-US")).toBe("Mon, Oct 19, 2026, 14:02");
  });
});

describe("upcomingTime", () => {
  const n = now.getTime();
  it("shows the time today, the weekday this week, else the date", () => {
    expect(upcomingTime(at(2026, 9, 19, 18, 0), n, "24h", "en-US")).toBe("18:00");
    expect(plain(upcomingTime(at(2026, 9, 19, 18, 0), n, "12h", "en-US"))).toBe("6:00 PM");
    expect(upcomingTime(at(2026, 9, 20, 9, 0), n, "24h", "en-US")).toBe("Tue 09:00");
    expect(upcomingTime(at(2026, 10, 2, 9, 0), n, "24h", "en-US")).toBe("Nov 2");
  });
});
