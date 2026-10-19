import { describe, expect, it } from "vitest";
import { stamp } from "@/lib/client/stamp";

const now = new Date(2026, 9, 19, 12, 0);
const at = (y: number, m: number, d: number) => new Date(y, m, d, 14, 2).getTime();

describe("thread time dividers", () => {
  it("say Today and Yesterday for the last two days", () => {
    expect(stamp(at(2026, 9, 19), now, "en-US")).toMatch(/^Today /);
    expect(stamp(at(2026, 9, 18), now, "en-US")).toMatch(/^Yesterday /);
  });

  it("leave the year out within this year", () => {
    expect(stamp(at(2026, 9, 6), now, "en-US")).toMatch(/^Tue, Oct 6 · /);
  });

  it("add the year for messages from another year", () => {
    expect(stamp(at(2025, 9, 6), now, "en-US")).toMatch(/^Mon, Oct 6, 2025 · /);
    /* yesterday across New Year still reads as Yesterday */
    expect(stamp(at(2025, 11, 31), new Date(2026, 0, 1, 9, 0), "en-US")).toMatch(/^Yesterday /);
  });
});
