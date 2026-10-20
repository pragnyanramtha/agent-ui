import { describe, expect, it } from "vitest";
import { bounds, covers, pick, rangeText, step } from "@/lib/client/line-range";

describe("line range", () => {
  it("normalizes bounds and coverage", () => {
    expect(bounds({ anchor: 5, head: 2 })).toEqual([2, 5]);
    expect(covers({ anchor: 2, head: 5 }, 3)).toBe(true);
    expect(covers({ anchor: 2, head: 5 }, 9)).toBe(false);
  });

  it("picks a one-line range or extends with shift", () => {
    expect(pick(null, 4, false)).toEqual({ anchor: 4, head: 4 });
    expect(pick({ anchor: 2, head: 2 }, 7, true)).toEqual({ anchor: 2, head: 7 });
  });

  it("steps with the keyboard, growing or dropping the range", () => {
    expect(step({ anchor: 2, head: 4 }, 4, 1, false, 1, 10)).toEqual({ range: null, to: 5 });
    expect(step({ anchor: 2, head: 4 }, 4, 1, true, 1, 10)).toEqual({ range: { anchor: 2, head: 5 }, to: 5 });
  });

  it("formats line numbers for labels", () => {
    expect(rangeText(12, 12)).toBe("12");
    expect(rangeText(12, 20)).toBe("12-20");
  });
});
