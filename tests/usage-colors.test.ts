import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { composite, contrast, parseColor, type Rgb } from "@/lib/color";
import { AGENT_CHART_TOKEN, OTHER_TOKEN, SERIES_TOKENS } from "@/lib/client/chart-colors";

/* Graphics need 3:1 against what they sit on (WCAG 1.4.11): the Usage chart's stacks on a card, the timeline's
 * marks on the page. Tokens can be defined in more than one :root / .dark block, so all of them are searched. */

const css = readFileSync(path.resolve(__dirname, "..", "app/globals.css"), "utf8");
const blocks = (selector: string) => css.split(`\n${selector} {`).slice(1).map((b) => b.slice(0, b.indexOf("\n}")));
const light = blocks(":root");
const dark = blocks(".dark");

function token(theme: string[], name: string, under?: Rgb): Rgb {
  for (const b of theme) {
    const v = new RegExp(`--${name}:\\s*([^;]+);`).exec(b)?.[1]?.trim();
    if (!v) continue;
    const ref = /^var\(--([\w-]+)\)$/.exec(v);
    if (ref) return token(theme, ref[1], under);
    const c = parseColor(v);
    if (!c) throw new Error(`not a color: ${v}`);
    return c.alpha < 1 ? composite(c, under ?? token(theme, "page")) : c.rgb;
  }
  throw new Error(`--${name} not found`);
}

const chart = [...new Set([...Object.values(AGENT_CHART_TOKEN), ...SERIES_TOKENS, OTHER_TOKEN])];

describe.each([
  ["light", light],
  ["dark", dark],
])("%s theme", (_, theme) => {
  it.each(chart)("chart color --%s reaches 3:1 on a card", (name) => {
    expect(contrast(token(theme, name), token(theme, "surface"))).toBeGreaterThanOrEqual(3);
  });

  it.each(["ink-3", "red", "orange-ink", "accent"])("timeline mark --%s reaches 3:1 on the page", (name) => {
    expect(contrast(token(theme, name), token(theme, "page"))).toBeGreaterThanOrEqual(3);
  });
});
