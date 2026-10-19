import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/* WCAG contrast of the colors the components actually ship, read from their source */

type Oklch = [number, number, number];

function toLinearSrgb([L, C, H]: Oklch): number[] {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map((v) =>
    Math.min(1, Math.max(0, v)),
  );
}

const luminance = (c: Oklch) => {
  const [r, g, b] = toLinearSrgb(c);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (fg: Oklch, bg: Oklch) => {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const parse = (v: string): Oklch => {
  const m = /oklch\(\s*([\d.]+)[\s_]+([\d.]+)[\s_]+([\d.]+)\s*\)/.exec(v);
  if (!m) throw new Error(`not an oklch color: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};

const read = (f: string) => readFileSync(path.resolve(__dirname, "..", f), "utf8");
const css = read("app/globals.css");
const light = css.slice(css.indexOf(":root {"));
const dark = css.slice(css.indexOf(".dark {"));

/** a theme token, following one level of `var(--x)` */
function token(block: string, name: string): Oklch {
  const v = new RegExp(`--${name}:\\s*([^;]+);`).exec(block)?.[1];
  if (!v) throw new Error(`--${name} not found`);
  const ref = /^var\(--([\w-]+)\)$/.exec(v.trim());
  return ref ? token(block, ref[1]) : parse(v);
}

describe("ChangesPanel +N/-N counts", () => {
  const panel = read("components/claude/ChangesPanel.tsx");
  const addLight = parse(/\[--add-ink:(oklch\([^\]]+\))\]/.exec(panel)?.[1] ?? "");
  const addDarkRef = /dark:\[--add-ink:var\(--([\w-]+)\)\]/.exec(panel)?.[1] ?? "";

  it("uses the ink colors, not the raw semantic ones", () => {
    expect(panel).not.toMatch(/text-(green|red)(?![-\w])/);
    expect(panel).toMatch(/text-red-ink/);
    expect(addDarkRef).toBe("green");
  });

  /* the counts sit on the page, and on the hover tint when a file row is expanded */
  it.each([
    ["light", light, "page"],
    ["light", light, "hover"],
    ["dark", dark, "page"],
    ["dark", dark, "hover"],
  ])("reach 4.5:1 in %s theme on --%s", (theme, block, bg) => {
    const add = theme === "light" ? addLight : token(block, addDarkRef);
    const del = token(block, "red-ink");
    const back = token(block, bg);
    expect(contrast(add, back)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(del, back)).toBeGreaterThanOrEqual(4.5);
  });

  it("the old colors really failed in light theme", () => {
    expect(contrast(token(light, "green"), token(light, "hover"))).toBeLessThan(4.5);
    expect(contrast(token(light, "red"), token(light, "hover"))).toBeLessThan(4.5);
  });
});
