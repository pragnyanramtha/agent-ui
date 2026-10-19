import { describe, expect, it } from "vitest";
import { composite, contrast, ensureContrast, parseColor, readableOn, toHex, WHITE, type Rgb } from "@/lib/color";
import { PALETTE_BASES, PALETTES } from "@/lib/settings-schema";
import { accentVars, parseCustomTheme, THEME_TOKENS, themeTemplate, themeVars } from "@/lib/theme";

const rgb = (hex: string) => parseColor(hex)!.rgb;

describe("parseColor", () => {
  it("reads hex, rgb, hsl and oklch", () => {
    expect(parseColor("#fff")).toEqual({ rgb: [255, 255, 255], alpha: 1 });
    expect(parseColor("#0a0a0a80")!.alpha).toBeCloseTo(0.5, 2);
    expect(parseColor("rgb(10 20 30)")).toEqual({ rgb: [10, 20, 30], alpha: 1 });
    expect(parseColor("rgba(10, 20, 30, 0.5)")).toEqual({ rgb: [10, 20, 30], alpha: 0.5 });
    expect(parseColor("rgb(100% 0% 0% / 25%)")).toEqual({ rgb: [255, 0, 0], alpha: 0.25 });
    expect(toHex(parseColor("hsl(120 100% 25%)")!.rgb)).toBe("#008000");
    expect(toHex(parseColor("oklch(0.145 0 0)")!.rgb)).toBe("#0a0a0a");
    expect(toHex(parseColor("oklch(100% 0 0)")!.rgb)).toBe("#ffffff");
    expect(parseColor("oklch(1 0 0 / 0.07)")!.alpha).toBe(0.07);
    expect(parseColor("transparent")!.alpha).toBe(0);
  });

  it("refuses anything that isn't a plain color", () => {
    for (const bad of ["red", "#12", "#ggg", "rgb(1 2)", "rgb(1 2 3 4 5)", "var(--page)", "color-mix(in srgb, red, blue)", "url(x)", "rgb(1 2 3) ; x", "oklch(a b c)", ""]) {
      expect(parseColor(bad), bad).toBeNull();
    }
  });
});

describe("contrast helpers", () => {
  it("picks a label that reads on any fill", () => {
    for (let v = 0; v <= 255; v += 5) {
      const bg: Rgb = [v, v, v];
      expect(contrast(readableOn(bg), bg), `gray ${v}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const hex of ["#ffd60a", "#f76b15", "#3b82f6", "#22c55e", "#ec4899", "#14b8a6", "#7c3aed", "#808080", "#767676"]) {
      expect(contrast(readableOn(rgb(hex)), rgb(hex)), hex).toBeGreaterThanOrEqual(4.5);
    }
    expect(readableOn(rgb("#1d4ed8"))).toEqual(WHITE);
    expect(toHex(readableOn(rgb("#ffd60a")))).toBe("#0a0a0a");
  });

  it("moves a color just far enough", () => {
    const page = rgb("#0a0a0a");
    const dim = rgb("#3b2a80");
    const out = ensureContrast(dim, page, 4.5);
    expect(contrast(out, page)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(out, page)).toBeLessThan(5.2);
    expect(ensureContrast(WHITE, page, 4.5)).toEqual(WHITE);
  });

  it("blends alpha over the page", () => {
    expect(toHex(composite({ rgb: [255, 255, 255], alpha: 0.5 }, [0, 0, 0]))).toBe("#808080");
  });
});

describe("custom accent colors", () => {
  const cases = ["#ffd60a", "#f76b15", "#3b82f6", "#0f766e", "#111111", "#fafafa", "#7c3aed", "#ff4d8d"];
  it.each(cases)("%s keeps links, focus rings and buttons readable in every palette", (hex) => {
    for (const p of PALETTES) {
      for (const dark of [false, true]) {
        const page = dark ? p.dark.page : p.light.page;
        const v = accentVars(hex, page, dark);
        const where = `${p.id} ${dark ? "dark" : "light"}`;
        expect(contrast(rgb(v["--accent-ink"]), rgb(page)), `links on ${where}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(rgb(v["--accent"]), rgb(page)), `rings on ${where}`).toBeGreaterThanOrEqual(3);
        expect(contrast(WHITE, rgb(v["--accent-solid"])), `white on solid, ${where}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(rgb(v["--primary-foreground"]), rgb(v["--primary"])), `label on primary, ${where}`).toBeGreaterThanOrEqual(4.5);
        expect(v["--primary"]).toBe(hex);
      }
    }
  });

  it("sets nothing for a value it can't read", () => {
    expect(accentVars("nope", "#000000", true)).toEqual({});
  });
});

describe("custom theme JSON", () => {
  const ok = (text: string) => {
    const r = parseCustomTheme(text, PALETTE_BASES);
    if (!r.ok) throw new Error(r.errors.join(" "));
    return r;
  };
  const errors = (text: string) => {
    const r = parseCustomTheme(text, PALETTE_BASES);
    if (r.ok) throw new Error("expected errors");
    return r.errors;
  };

  it("reads a base, shared tokens and per-mode tokens", () => {
    const r = ok('{"name":"Ember","base":"graphite","accent":"#ff7a59","--line":"rgb(255 255 255 / 0.08)","dark":{"page":"#0b0b0c"},"light":{"page":"#ffffff","accent":"#c2410c"}}');
    expect(r.theme).toEqual({
      base: "graphite",
      dark: { accent: "#ff7a59", line: "rgb(255 255 255 / 0.08)", page: "#0b0b0c" },
      light: { accent: "#c2410c", line: "rgb(255 255 255 / 0.08)", page: "#ffffff" },
    });
    expect(r.warnings).toEqual([]);
  });

  it("accepts a base palette alone", () => {
    expect(ok('{"base":"nord"}').theme).toEqual({ base: "nord", light: {}, dark: {} });
  });

  it("says where the JSON breaks", () => {
    expect(errors('{\n  "page": "#000",\n}')[0]).toMatch(/^That isn't valid JSON \(line 3, column 1\)\.$/);
    expect(errors("")).toEqual(["Paste a theme first."]);
    expect(errors("[1, 2]")[0]).toMatch(/object of tokens/);
    expect(errors("{}")[0]).toMatch(/at least one token/);
    expect(errors("x".repeat(9000))[0]).toMatch(/too long/);
  });

  it("names unknown tokens, suggests the right one, and explains bad colors", () => {
    expect(errors('{"background":"#000"}')).toEqual(['Unknown token "background". Did you mean "page"?']);
    expect(errors('{"dark":{"sparkle":"#000"}}')).toEqual(['Unknown token "sparkle" in "dark".']);
    expect(errors('{"page":"blue"}')).toEqual(['"page" must be a color like #0a0a0a, rgb(10 10 10) or oklch(0.2 0 0).']);
    expect(errors('{"page":12}')[0]).toMatch(/must be a color/);
    expect(errors('{"base":"dracula"}')[0]).toMatch(/^"base" must be one of default, slate, graphite/);
    expect(errors('{"dark":"#000"}')).toEqual(['"dark" must be an object of tokens.']);
  });

  it("warns about text that will be hard to read", () => {
    const r = ok('{"dark":{"page":"#202020","ink":"#3a3a3a"},"light":{"primary":"#ffd60a","primary-foreground":"#ffffff"}}');
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]).toMatch(/^In light mode, button labels are 1\.\d:1/);
    expect(r.warnings[1]).toMatch(/^In dark mode, text is 1\.\d:1 on the page/);
  });

  it("turns a theme into variables, filling in the accent family and a safe button label", () => {
    const { theme } = ok('{"accent":"#ffd60a","dark":{"page":"#101010","primary":"#22c55e"}}');
    const vars = themeVars(theme, true, "#0a0a0a");
    expect(vars["--page"]).toBe("#101010");
    expect(vars["--accent"]).toBe("#ffd60a");
    expect(vars["--primary"]).toBe("#22c55e");
    expect(contrast(rgb(vars["--primary-foreground"]), rgb("#22c55e"))).toBeGreaterThanOrEqual(4.5);
    expect(Object.keys(vars).every((k) => THEME_TOKENS.includes(k.slice(2) as (typeof THEME_TOKENS)[number]))).toBe(true);
  });

  it("offers a template that parses", () => {
    const p = PALETTES[0];
    expect(ok(themeTemplate(p.id, { light: p.light, dark: p.dark })).warnings).toEqual([]);
  });
});
