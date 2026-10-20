import { describe, expect, it } from "vitest";
import { applyTerminalOptions, fontStack, NERD_FONT, terminalFace, terminalOptions, TERMINAL_FONT_FACES, type TerminalPrefs } from "@/lib/client/terminal-options";
import { buildTerminalTheme, contrast, schemeTheme, TERMINAL_SCHEMES } from "@/lib/client/terminal-theme";
import { DEFAULTS, decodeStored, parseValue, settingDef, settingsIn, storageKey, type EnumSetting } from "@/lib/settings-schema";

const prefs = (over: Partial<TerminalPrefs> = {}): TerminalPrefs => ({
  terminalFont: DEFAULTS.terminalFont,
  terminalFontSize: DEFAULTS.terminalFontSize,
  terminalLineHeight: DEFAULTS.terminalLineHeight,
  terminalCursor: DEFAULTS.terminalCursor,
  terminalCursorBlink: DEFAULTS.terminalCursorBlink,
  terminalScrollback: DEFAULTS.terminalScrollback,
  terminalOptionMeta: DEFAULTS.terminalOptionMeta,
  terminalTheme: DEFAULTS.terminalTheme,
  ...over,
});
const appTheme = buildTerminalTheme({ dark: true, page: "#151619", ink: "#f2f3f5", accent: "#5fa0f7" });
const ctx = { codeFace: "'Geist Mono', 'Geist Mono Fallback'", appTheme };

describe("terminal settings registry", () => {
  it("lists every terminal setting in the Terminal section and keeps Open in a panel", () => {
    const keys = settingsIn("terminal").map((d) => d.key);
    for (const k of ["terminalDocked", "terminalFont", "terminalFontSize", "terminalLineHeight", "terminalCursor", "terminalCursorBlink", "terminalScrollback", "terminalCopyOnSelect", "terminalRightClickPaste", "terminalBell", "terminalOptionMeta", "terminalWebgl", "terminalTheme"]) {
      expect(keys, k).toContain(k);
    }
  });

  it("defaults to how terminals looked before there were settings", () => {
    expect(terminalOptions(prefs(), ctx)).toMatchObject({ fontSize: 13, lineHeight: 1.12, cursorStyle: "block", cursorBlink: true, scrollback: 10000, macOptionIsMeta: true });
    expect(DEFAULTS.terminalWebgl).toBe(true);
    expect(DEFAULTS.terminalBell).toBe("none");
    expect(DEFAULTS.terminalCopyOnSelect).toBe(false);
    expect(DEFAULTS.terminalRightClickPaste).toBe(false);
  });

  it("reads the size the A- and A+ buttons stored before", () => {
    expect(storageKey("terminalFontSize")).toBe("cui:term-font");
    expect(decodeStored("terminalFontSize", "15")).toBe(15);
    expect(decodeStored("terminalFontSize", "99")).toBe(24);
    expect(decodeStored("terminalFontSize", "big")).toBe(13);
  });

  it("snaps line height and scrollback to their steps", () => {
    expect(parseValue(settingDef("terminalLineHeight"), 1.133)).toEqual({ ok: true, value: 1.14 });
    expect(parseValue(settingDef("terminalScrollback"), 2500.4)).toEqual({ ok: true, value: 3000 });
    expect(parseValue(settingDef("terminalScrollback"), 5)).toEqual({ ok: true, value: 1000 });
  });

  it("offers every scheme in the color scheme setting", () => {
    const values = (settingDef("terminalTheme") as EnumSetting).options.map((o) => o.value);
    expect(values).toEqual(["app", ...TERMINAL_SCHEMES.map((s) => s.id)]);
  });
});

describe("terminal options", () => {
  it("follows the code font, or uses the picked one, ahead of the Nerd Font symbols", () => {
    expect(terminalFace("code", " 'JetBrains Mono' ")).toBe("'JetBrains Mono'");
    expect(terminalOptions(prefs(), ctx).fontFamily).toBe(`${ctx.codeFace}, ${NERD_FONT}, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`);
    expect(terminalOptions(prefs({ terminalFont: "fira-code" }), ctx).fontFamily.startsWith(TERMINAL_FONT_FACES["fira-code"])).toBe(true);
    expect(fontStack("")).toBe(`${NERD_FONT}, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`);
  });

  it("starts phones one size smaller until a size is picked", () => {
    expect(terminalOptions(prefs(), { ...ctx, phone: true }).fontSize).toBe(12);
    expect(terminalOptions(prefs(), { ...ctx, phone: true, sizeChosen: true }).fontSize).toBe(13);
    expect(terminalOptions(prefs({ terminalFontSize: 8 }), { ...ctx, phone: true }).fontSize).toBe(8);
  });

  it("uses the app colors, or a fixed scheme", () => {
    expect(terminalOptions(prefs(), ctx).theme).toBe(appTheme);
    expect(terminalOptions(prefs({ terminalTheme: "dracula" }), ctx).theme.background).toBe("#282a36");
    expect(schemeTheme("app")).toBeNull();
    expect(schemeTheme("nope")).toBeNull();
  });

  it("ships readable schemes", () => {
    for (const s of TERMINAL_SCHEMES) {
      expect(contrast(s.theme.foreground, s.theme.background), s.id).toBeGreaterThanOrEqual(4.5);
      expect(s.theme.cursorAccent, s.id).toBe(s.theme.background);
    }
  });
});

describe("applying to an open terminal", () => {
  const fake = () => ({ options: { ...terminalOptions(prefs(), ctx) } as Record<string, unknown> });

  it("changes nothing when nothing changed", () => {
    const term = fake();
    expect(applyTerminalOptions(term, terminalOptions(prefs(), ctx))).toEqual({ changed: [], refit: false });
  });

  it("sets only what changed, and refits when the cell size moves", () => {
    const term = fake();
    const res = applyTerminalOptions(term, terminalOptions(prefs({ terminalFontSize: 16, terminalCursor: "bar" }), ctx));
    expect(res.changed.sort()).toEqual(["cursorStyle", "fontSize"]);
    expect(res.refit).toBe(true);
    expect(term.options.fontSize).toBe(16);
    expect(term.options.cursorStyle).toBe("bar");
  });

  it("doesn't refit for cursor, scrollback or colors", () => {
    const term = fake();
    const res = applyTerminalOptions(term, terminalOptions(prefs({ terminalCursorBlink: false, terminalScrollback: 50000, terminalTheme: "gruvbox-dark" }), ctx));
    expect(res.changed.sort()).toEqual(["cursorBlink", "scrollback", "theme"]);
    expect(res.refit).toBe(false);
  });

  it("compares themes by value, so a re-read of the same page colors is a no-op", () => {
    const term = fake();
    const same = buildTerminalTheme({ dark: true, page: "#151619", ink: "#f2f3f5", accent: "#5fa0f7" });
    expect(applyTerminalOptions(term, terminalOptions(prefs(), { ...ctx, appTheme: same })).changed).toEqual([]);
  });

  it("refits when the code font changes under a terminal that follows it", () => {
    const term = fake();
    const res = applyTerminalOptions(term, terminalOptions(prefs(), { ...ctx, codeFace: "'Fira Code'" }));
    expect(res).toEqual({ changed: ["fontFamily"], refit: true });
  });
});
