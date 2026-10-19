import { describe, expect, it } from "vitest";
import { keyboardInset } from "@/lib/client/useKeyboardInset";

const phone = { innerHeight: 844, height: 844, offsetTop: 0, scale: 1 };

describe("keyboardInset", () => {
  it("measures the part of the page an iOS keyboard covers while a field is focused", () => {
    expect(keyboardInset({ ...phone, height: 508 }, true)).toBe(336);
    expect(keyboardInset({ ...phone, height: 508, offsetTop: 20 }, true)).toBe(316);
  });

  it("is zero when the browser resized the page itself or nothing is covered", () => {
    expect(keyboardInset({ ...phone, innerHeight: 508, height: 508 }, true)).toBe(0);
    expect(keyboardInset(phone, true)).toBe(0);
  });

  it("ignores toolbars sliding in and out", () => {
    expect(keyboardInset({ ...phone, height: 790 }, true)).toBe(0);
  });

  it("ignores a pinch-zoomed viewport, which is small because of the zoom", () => {
    expect(keyboardInset({ ...phone, height: 422, scale: 2 }, false)).toBe(0);
    expect(keyboardInset({ ...phone, height: 422, offsetTop: 300, scale: 2 }, true)).toBe(0);
  });

  it("only counts a keyboard while something editable has focus", () => {
    expect(keyboardInset({ ...phone, height: 508 }, false)).toBe(0);
  });

  it("tolerates a scale a hair off 1", () => {
    expect(keyboardInset({ ...phone, height: 508, scale: 1.0000001 }, true)).toBe(336);
  });
});
