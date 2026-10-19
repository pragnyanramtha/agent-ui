import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { composite, contrast, parseColor, type Rgb } from "@/lib/color";

/* WCAG contrast of diff text (line numbers, +N/-N counts, status letters) in both themes and both diff color
 * choices, with the values read from app/globals.css and components/claude/diff.css as the browser cascades them */

const read = (f: string) => readFileSync(path.resolve(__dirname, "..", f), "utf8");
const globals = read("app/globals.css");
const diffCss = read("components/claude/diff.css");

/** custom properties declared in the first block that opens with `selector {` */
function vars(css: string, selector: string): Record<string, string> {
  const at = css.indexOf(`${selector} {`);
  if (at === -1) throw new Error(`${selector} not found`);
  const body = css.slice(at, css.indexOf("}", at));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

function palette(dark: boolean, blueOrange: boolean): Record<string, string> {
  return {
    ...vars(globals, ":root"),
    ...(dark ? vars(globals, ".dark") : {}),
    ...vars(diffCss, ".diff-tone"),
    ...(dark ? vars(diffCss, ":root.dark .diff-tone") : {}),
    ...(blueOrange ? vars(diffCss, ':root[data-diff-colors="blue-orange"] .diff-tone') : {}),
    ...(dark && blueOrange ? vars(diffCss, ':root.dark[data-diff-colors="blue-orange"] .diff-tone') : {}),
  };
}

function color(p: Record<string, string>, name: string): Rgb {
  const v = p[name];
  if (!v) throw new Error(`--${name} not set`);
  const ref = /^var\(--([\w-]+)\)$/.exec(v);
  if (ref) return color(p, ref[1]);
  const c = parseColor(v);
  if (!c) throw new Error(`not a color: ${v}`);
  return c.alpha < 1 ? composite(c, color(p, "surface")) : c.rgb;
}

const MODES = [
  ["light", "red and green", false, false],
  ["dark", "red and green", true, false],
  ["light", "blue and orange", false, true],
  ["dark", "blue and orange", true, true],
] as const;

describe("diff text contrast", () => {
  it.each(MODES)("added and removed text reach 4.5:1 in %s theme with %s", (_theme, _choice, dark, blueOrange) => {
    const p = palette(dark, blueOrange);
    for (const bg of ["surface", "page", "inset", "green-tint"]) expect(contrast(color(p, "add-ink"), color(p, bg)), `add-ink on ${bg}`).toBeGreaterThanOrEqual(4.5);
    for (const bg of ["surface", "page", "inset", "red-tint"]) expect(contrast(color(p, "del-ink"), color(p, bg)), `del-ink on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(MODES)("unchanged line numbers and hunk headers reach 4.5:1 in %s theme with %s", (_theme, _choice, dark, blueOrange) => {
    const p = palette(dark, blueOrange);
    expect(contrast(color(p, "ink-3"), color(p, "surface"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(color(p, "ink-3"), color(p, "inset"))).toBeGreaterThanOrEqual(4.5);
  });

  it("the raw semantic colors fail on the row tints in light theme, which is why diff text has its own", () => {
    expect(contrast(color(palette(false, false), "green"), color(palette(false, false), "green-tint"))).toBeLessThan(4.5);
    expect(contrast(color(palette(false, true), "red"), color(palette(false, true), "red-tint"))).toBeLessThan(4.5);
  });

  it.each(["components/claude/DiffView.tsx", "components/claude/DiffBlock.tsx", "components/claude/TurnFold.tsx"])("%s draws diff text with the ink tokens", (file) => {
    const src = read(file);
    expect(src).not.toMatch(/text-(green|red)(?![-\w])/);
    expect(src).toMatch(/text-\(--add-ink\)/);
    expect(src).toMatch(/text-\(--del-ink\)/);
  });
});
