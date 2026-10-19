import { describe, expect, it } from "vitest";
import { devicePixelsMatch } from "@/lib/client/terminal-render";

describe("device pixel boxes", () => {
  it("accepts boxes that follow devicePixelRatio, with rounding", () => {
    expect(devicePixelsMatch(100, 300, 3)).toBe(true);
    expect(devicePixelsMatch(100, 125, 1.25)).toBe(true);
    expect(devicePixelsMatch(371, 1113, 3)).toBe(true);
    expect(devicePixelsMatch(371, 1114, 3)).toBe(true);
  });

  it("rejects CSS-pixel boxes on a high-density screen (Chrome device emulation)", () => {
    expect(devicePixelsMatch(100, 100, 3)).toBe(false);
    expect(devicePixelsMatch(100, 100, 2)).toBe(false);
  });
});
