import { describe, expect, it } from "vitest";
import { findDecorations, findLabel } from "@/lib/client/terminal-find";

describe("find in terminal", () => {
  it("labels results", () => {
    expect(findLabel("", { resultIndex: 0, resultCount: 3 })).toBe("");
    expect(findLabel("foo", null)).toBe("");
    expect(findLabel("foo", { resultIndex: -1, resultCount: 0 })).toBe("No results");
    expect(findLabel("foo", { resultIndex: 2, resultCount: 12 })).toBe("3 of 12");
    expect(findLabel("foo", { resultIndex: -1, resultCount: 2500 })).toBe("2500 matches");
    expect(findLabel("foo", { resultIndex: -1, resultCount: 1 })).toBe("1 match");
  });

  it("uses #rrggbb colors, which the decoration API requires", () => {
    for (const dark of [true, false]) for (const v of Object.values(findDecorations(dark))) expect(v).toMatch(/^#[0-9a-f]{6}$/);
  });
});
