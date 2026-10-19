import { describe, expect, it } from "vitest";
import { BRIGHT, buildTerminalTheme, contrast, DARK_ANSI, ensureContrast, isDarkColor, LIGHT_ANSI, mix, NORMAL, oscColor, parseHex } from "@/lib/client/terminal-theme";

describe("terminal theme", () => {
  it("uses the page and ink colors for background and foreground", () => {
    const t = buildTerminalTheme({ dark: true, page: "#101112", ink: "#EEEEEE", accent: "#3388ff" });
    expect(t.background).toBe("#101112");
    expect(t.foreground).toBe("#eeeeee");
    expect(t.cursor).toBe(t.foreground);
    expect(t.cursorAccent).toBe(t.background);
    expect(t.red).toBe(DARK_ANSI.red);
  });

  it("falls back when the variables can't be read", () => {
    expect(buildTerminalTheme({ dark: true }).background).toBe("#17181a");
    expect(buildTerminalTheme({ dark: false, page: "oklch(1 0 0)" }).background).toBe("#fcfcfd");
  });

  it("keeps light ANSI colors readable on the light page", () => {
    for (const page of ["#ffffff", "#fcfcfd", "#f4f1ea", "#eef3f8"]) {
      const t = buildTerminalTheme({ dark: false, page, ink: "#2b2d31" });
      for (const k of NORMAL) expect(contrast(t[k], page), `${k} on ${page}`).toBeGreaterThanOrEqual(4.5);
      for (const k of BRIGHT) expect(contrast(t[k], page), `${k} on ${page}`).toBeGreaterThanOrEqual(3);
      expect(contrast(t.foreground, page)).toBeGreaterThanOrEqual(7);
    }
  });

  it("ships a light palette that already passes on the default page", () => {
    for (const k of NORMAL) expect(contrast(LIGHT_ANSI[k], "#fcfcfd"), k).toBeGreaterThanOrEqual(4.5);
  });

  it("gives the selection a visible tint", () => {
    for (const dark of [true, false]) {
      const t = buildTerminalTheme({ dark });
      expect(t.selectionBackground).not.toBe(t.background);
      expect(contrast(t.foreground, t.selectionBackground)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("color helpers", () => {
  it("parses short and long hex", () => {
    expect(parseHex("#fff")).toEqual([255, 255, 255]);
    expect(parseHex("17181a")).toEqual([23, 24, 26]);
    expect(parseHex("oklch(0.5 0 0)")).toBeNull();
  });

  it("mixes and measures", () => {
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(isDarkColor("#17181a")).toBe(true);
    expect(isDarkColor("#fcfcfd")).toBe(false);
  });

  it("only moves a color as far as needed", () => {
    expect(ensureContrast("#24292f", "#ffffff", 4.5)).toBe("#24292f");
    const fixed = ensureContrast("#ffcc00", "#ffffff", 4.5);
    expect(contrast(fixed, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(ensureContrast("#333333", "#111111", 4.5), "#111111")).toBeGreaterThanOrEqual(4.5);
  });

  it("formats OSC color replies", () => {
    expect(oscColor("#17181a")).toBe("rgb:1717/1818/1a1a");
  });
});
