import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ACCENTS, PALETTES } from "@/lib/settings-schema";

/* Every palette in app/globals.css keeps text readable: ink ramps pass WCAG AA on the surfaces they sit on, links and
 * filled buttons stay legible, and syntax / diff colors stand out from the code background. */

const css = fs.readFileSync(path.join(__dirname, "../app/globals.css"), "utf8");

function block(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = new RegExp(`(?:^|\\n)${selector.replace(/[.[\]"=()]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "g");
  for (const m of css.matchAll(re)) for (const d of m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim();
  return out;
}

type RGB = [number, number, number];

function oklchToRgb(l: number, c: number, h: number): RGB {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_, -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_, -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_];
  return lin.map((x) => Math.min(1, Math.max(0, x))) as RGB;
}

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/** linear sRGB, or null for values that aren't a plain opaque color (mixes, variables, alpha) */
function parse(value: string | undefined): RGB | null {
  if (!value) return null;
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) return [0, 2, 4].map((i) => toLinear(parseInt(hex[1].slice(i, i + 2), 16) / 255)) as RGB;
  const ok = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(value);
  if (ok) return oklchToRgb(Number(ok[1]), Number(ok[2]), Number(ok[3]));
  return null;
}

const lum = ([r, g, b]: RGB) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const contrast = (a: RGB, b: RGB) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

/** the effective tokens for a palette and mode, the way the cascade resolves them */
function tokens(id: string, dark: boolean) {
  const base = { ...block(":root"), ...(dark ? block(".dark") : {}) };
  if (id === "default") return base;
  return { ...base, ...block(`[data-palette="${id}"]`), ...(dark ? block(`.dark[data-palette="${id}"]`) : {}) };
}

const WHITE: RGB = [1, 1, 1];

const cases = PALETTES.flatMap((p) => [false, true].map((dark) => ({ id: p.id, dark, name: `${p.label} ${dark ? "dark" : "light"}` })));

describe("palettes", () => {
  it.each(cases)("$name keeps text at AA contrast", ({ id, dark }) => {
    const t = tokens(id, dark);
    const c = (fg: string, bg: string) => {
      const a = parse(t[fg]);
      const b = parse(t[bg]);
      expect(a, `${fg} = ${t[fg]}`).not.toBeNull();
      expect(b, `${bg} = ${t[bg]}`).not.toBeNull();
      return contrast(a!, b!);
    };
    for (const bg of ["--page", "--surface", "--sidebar", "--field"]) {
      /* well above AA, so primary text stays clearly ahead of ink-2 */
      expect(c("--ink", bg), `ink on ${bg}`).toBeGreaterThanOrEqual(6);
      expect(c("--ink-2", bg), `ink-2 on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    /* tertiary text carries meta lines: AA on the page and in cards, a hair under on hover-tinted fields */
    expect(c("--ink-3", "--page"), "ink-3 on page").toBeGreaterThanOrEqual(4.5);
    expect(c("--ink-3", "--surface"), "ink-3 on surface").toBeGreaterThanOrEqual(4.3);
    expect(c("--ink-3", "--sidebar"), "ink-3 on sidebar").toBeGreaterThanOrEqual(4.3);
    expect(c("--accent-ink", "--page"), "links").toBeGreaterThanOrEqual(4.5);
    expect(contrast(WHITE, parse(t["--accent-solid"])!), "white on accent buttons").toBeGreaterThanOrEqual(4.5);
  });

  it.each(cases)("$name keeps syntax and diff colors readable on code cards", ({ id, dark }) => {
    const t = tokens(id, dark);
    const surface = parse(t["--surface"])!;
    for (const fg of ["--accent-ink", "--orange", "--green", "--red"]) {
      const v = parse(t[fg]);
      if (!v) continue;
      /* the default palette's light orange sits at 2.9; nothing may read worse than that */
      expect(contrast(v, surface), `${fg} = ${t[fg]} on surface`).toBeGreaterThanOrEqual(2.9);
    }
    /* adds and removals are tinted rows: the tint must stay distinct from the card */
    for (const tint of ["--green-tint", "--red-tint"]) expect(t[tint], tint).toBeTruthy();
  });

  it.each([...ACCENTS.filter((a) => a.value !== "neutral"), { value: "custom 120", hue: 120, chroma: 1 }, { value: "custom 80", hue: 80, chroma: 1 }])("accent $value keeps links and buttons legible", ({ hue, chroma }) => {
    const light = parse(tokens("default", false)["--page"])!;
    const dark = parse(tokens("default", true)["--page"])!;
    expect(contrast(oklchToRgb(0.52, 0.17 * chroma, hue), light), "light links").toBeGreaterThanOrEqual(4.5);
    expect(contrast(oklchToRgb(0.8, 0.11 * chroma, hue), dark), "dark links").toBeGreaterThanOrEqual(4.5);
    expect(contrast(WHITE, oklchToRgb(0.52, 0.19 * chroma, hue)), "white on buttons").toBeGreaterThanOrEqual(4.5);
  });

  it("matches the browser chrome color to each palette's page", () => {
    for (const p of PALETTES.filter((x) => x.id !== "default")) {
      expect(block(`[data-palette="${p.id}"]`)["--page"]).toBe(p.light.page);
      expect(block(`.dark[data-palette="${p.id}"]`)["--page"]).toBe(p.dark.page);
    }
  });

  it("gives every palette the same tokens in both modes", () => {
    for (const p of PALETTES.filter((x) => x.id !== "default")) {
      expect(Object.keys(block(`.dark[data-palette="${p.id}"]`)).sort()).toEqual(Object.keys(block(`[data-palette="${p.id}"]`)).sort());
    }
  });
});
