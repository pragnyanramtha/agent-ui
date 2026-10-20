import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { composite, contrast, parseColor, type Rgb } from "@/lib/color";

/* WCAG contrast of the colors the components actually ship, read from their source */

const read = (f: string) => readFileSync(path.resolve(__dirname, "..", f), "utf8");
const css = read("app/globals.css");
const light = css.slice(css.indexOf(":root {"));
const dark = css.slice(css.indexOf(".dark {"));

const parse = (v: string) => {
  const c = parseColor(v.replace(/_/g, " "));
  if (!c) throw new Error(`not a color: ${v}`);
  return c;
};

/** a theme token as painted on the page (alpha tokens such as the dark hover are blended over it), following `var(--x)` */
function token(block: string, name: string): Rgb {
  const v = new RegExp(`--${name}:\\s*([^;]+);`).exec(block)?.[1];
  if (!v) throw new Error(`--${name} not found`);
  const ref = /^var\(--([\w-]+)\)$/.exec(v.trim());
  if (ref) return token(block, ref[1]);
  const c = parse(v);
  return c.alpha < 1 ? composite(c, token(block, "page")) : c.rgb;
}

describe("ChangesPanel +N/-N counts", () => {
  const panel = read("components/claude/ChangesView.tsx");
  const addLight = parse(/\[--add-ink:(oklch\([^\]]+\))\]/.exec(panel)?.[1] ?? "").rgb;
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
