/* Custom themes and custom accent colors: pasted JSON of token overrides, checked and turned into CSS variables.
 * Shared by the browser and the server (the server validates what it stores). No DOM.
 *
 *   {
 *     "base": "graphite",                       optional palette to start from
 *     "accent": "#ff7a59",                       tokens here apply to both modes
 *     "dark": { "page": "#0b0b0c", "ink": "#ededed" },
 *     "light": { "page": "#ffffff" }
 *   }
 */

import { composite, contrast, ensureContrast, isDark, mix, parseColor, readableOn, toHex, WHITE, type Rgb } from "./color";

export const THEME_TOKENS = [
  "page",
  "canvas",
  "surface",
  "inset",
  "field",
  "hover",
  "hover-2",
  "line",
  "line-soft",
  "line-strong",
  "ink",
  "ink-2",
  "ink-3",
  "sidebar",
  "sidebar-hover",
  "sidebar-active",
  "accent",
  "accent-ink",
  "accent-tint",
  "accent-solid",
  "accent-solid-hover",
  "primary",
  "primary-hover",
  "primary-foreground",
  "ring",
  "green",
  "green-tint",
  "orange",
  "orange-tint",
  "orange-ink",
  "red",
  "red-tint",
  "red-ink",
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];
export type TokenSet = Partial<Record<ThemeToken, string>>;
export type CustomTheme = { base?: string; light: TokenSet; dark: TokenSet };

/** Every CSS variable a theme or a custom accent may set on <html>, so stale ones can be cleared. */
export const THEME_VARS = THEME_TOKENS.map((t) => `--${t}` as const);

/** The variables a custom accent sets; a named accent (data-accent) needs them left to the stylesheet. */
export const ACCENT_TOKENS: readonly ThemeToken[] = ["accent", "accent-ink", "accent-tint", "accent-solid", "accent-solid-hover", "primary", "primary-hover", "primary-foreground", "ring"];

const TOKEN_SET = new Set<string>(THEME_TOKENS);

/* names other apps use for the same thing, offered as a hint */
const SIMILAR: Record<string, ThemeToken> = {
  background: "page",
  bg: "page",
  foreground: "ink",
  fg: "ink",
  text: "ink",
  card: "surface",
  popover: "surface",
  border: "line",
  input: "field",
  muted: "field",
  "muted-foreground": "ink-3",
  "secondary-foreground": "ink-2",
  destructive: "red",
  danger: "red",
  error: "red",
  success: "green",
  warning: "orange",
  link: "accent-ink",
  "sidebar-background": "sidebar",
};

/** Swatch colors of a base palette, for contrast checks and the page a custom accent sits on. */
export type BaseColors = { page: string; ink: string; ink3: string };
export type Bases = Record<string, { light: BaseColors; dark: BaseColors }>;

export type ThemeParse = { ok: true; theme: CustomTheme; warnings: string[] } | { ok: false; errors: string[] };

export const MAX_THEME_LENGTH = 8000;
const MAX_VALUE = 80;

/** "Unexpected token } in JSON at position 42" -> "line 3, column 5" */
function where(text: string, message: string): string {
  const lc = /line (\d+) column (\d+)/.exec(message);
  if (lc) return ` (line ${lc[1]}, column ${lc[2]})`;
  const pos = /position (\d+)/.exec(message);
  if (!pos) return "";
  const before = text.slice(0, Number(pos[1]));
  const line = before.split("\n").length;
  return ` (line ${line}, column ${before.length - before.lastIndexOf("\n")})`;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function readTokens(obj: Record<string, unknown>, scope: string, errors: string[], skip: readonly string[] = []): TokenSet {
  const out: TokenSet = {};
  for (const [rawKey, value] of Object.entries(obj)) {
    if (skip.includes(rawKey)) continue;
    const key = rawKey.replace(/^--/, "");
    const at = scope ? ` in "${scope}"` : "";
    if (!TOKEN_SET.has(key)) {
      const hint = SIMILAR[key.toLowerCase()];
      errors.push(`Unknown token "${rawKey}"${at}.${hint ? ` Did you mean "${hint}"?` : ""}`);
      continue;
    }
    if (typeof value !== "string" || value.length > MAX_VALUE || !parseColor(value)) {
      errors.push(`"${rawKey}"${at} must be a color like #0a0a0a, rgb(10 10 10) or oklch(0.2 0 0).`);
      continue;
    }
    out[key as ThemeToken] = value.trim();
  }
  return out;
}

/** The color a token ends up as, painted over the page (alpha colors included) */
function resolved(set: TokenSet, token: ThemeToken, fallback: string | undefined, page: Rgb): Rgb | null {
  const c = parseColor(set[token] ?? fallback ?? "");
  return c ? composite(c, page) : null;
}

function contrastWarnings(theme: CustomTheme, bases: Bases): string[] {
  const out: string[] = [];
  const base = bases[theme.base ?? "default"] ?? Object.values(bases)[0];
  for (const mode of ["light", "dark"] as const) {
    const set = theme[mode];
    if (!set.page && !set.ink && !set["ink-3"] && !set.primary && !set["primary-foreground"]) continue;
    const swatch = base?.[mode];
    const page = parseColor(set.page ?? swatch?.page ?? (mode === "dark" ? "#0a0a0a" : "#ffffff"));
    if (!page) continue;
    const pageRgb = composite(page, mode === "dark" ? [0, 0, 0] : WHITE);
    const check = (token: ThemeToken, fallback: string | undefined, min: number, what: string) => {
      const fg = resolved(set, token, fallback, pageRgb);
      if (!fg) return;
      const ratio = contrast(fg, pageRgb);
      if (ratio < min) out.push(`In ${mode} mode, ${what} is ${ratio.toFixed(1)}:1 on the page; aim for ${min}:1 or more.`);
    };
    check("ink", swatch?.ink, 4.5, "text");
    check("ink-3", swatch?.ink3, 3, "secondary text");
    if (set.primary && set["primary-foreground"]) {
      const bg = resolved(set, "primary", undefined, pageRgb);
      const fg = bg && resolved(set, "primary-foreground", undefined, bg);
      if (bg && fg && contrast(fg, bg) < 4.5) out.push(`In ${mode} mode, button labels are ${contrast(fg, bg).toFixed(1)}:1 on "primary"; aim for 4.5:1 or more.`);
    }
  }
  return out;
}

/** Reads pasted theme JSON. Errors say what to fix; warnings flag colors that will be hard to read. */
export function parseCustomTheme(text: string, bases: Bases): ThemeParse {
  if (!text.trim()) return { ok: false, errors: ["Paste a theme first."] };
  if (text.length > MAX_THEME_LENGTH) return { ok: false, errors: [`That theme is too long (${text.length} characters, the limit is ${MAX_THEME_LENGTH}).`] };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { ok: false, errors: [`That isn't valid JSON${where(text, err instanceof Error ? err.message : "")}.`] };
  }
  if (!isObject(data)) return { ok: false, errors: ['A theme is an object of tokens, like {"dark": {"page": "#0a0a0a"}}.'] };
  const errors: string[] = [];
  let base: string | undefined;
  if ("base" in data) {
    if (typeof data.base !== "string" || !(data.base in bases)) errors.push(`"base" must be one of ${Object.keys(bases).join(", ")}.`);
    else base = data.base;
  }
  if ("name" in data && typeof data.name !== "string") errors.push('"name" must be text.');
  const both = readTokens(data, "", errors, ["base", "name", "light", "dark"]);
  const mode = (m: "light" | "dark"): TokenSet => {
    if (!(m in data)) return {};
    const v = (data as Record<string, unknown>)[m];
    if (!isObject(v)) {
      errors.push(`"${m}" must be an object of tokens.`);
      return {};
    }
    return readTokens(v, m, errors);
  };
  const theme: CustomTheme = { ...(base ? { base } : {}), light: { ...both, ...mode("light") }, dark: { ...both, ...mode("dark") } };
  if (errors.length) return { ok: false, errors };
  if (!base && !Object.keys(theme.light).length && !Object.keys(theme.dark).length) return { ok: false, errors: [`Add a "base" palette or at least one token, like "page" or "accent".`] };
  return { ok: true, theme, warnings: contrastWarnings(theme, bases) };
}

const rgbText = ([r, g, b]: Rgb, alpha: number) => `rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)} / ${alpha})`;
const BLACK: Rgb = [0, 0, 0];

/**
 * The accent tokens for one color on a given page: links and focus rings are pushed to readable contrast,
 * filled buttons keep the exact color with a label (white or near-black) that reads on it.
 */
export function accentVars(color: string, page: string, dark: boolean): Record<string, string> {
  const c = parseColor(color);
  const p = parseColor(page);
  if (!c) return {};
  const pageRgb = p ? composite(p, dark ? BLACK : WHITE) : dark ? ([10, 10, 10] as Rgb) : WHITE;
  const rgb = composite(c, pageRgb);
  /* the older filled buttons print white labels, so their fill is deepened until white reads */
  const solid = ensureContrast(rgb, WHITE, 4.5);
  return {
    "--accent": toHex(ensureContrast(rgb, pageRgb, 3)),
    "--accent-ink": toHex(ensureContrast(rgb, pageRgb, 4.5)),
    "--accent-tint": dark ? rgbText(rgb, 0.16) : toHex(mix(pageRgb, rgb, 0.12)),
    "--accent-solid": toHex(solid),
    "--accent-solid-hover": toHex(mix(solid, BLACK, 0.12)),
    "--primary": toHex(rgb),
    "--primary-hover": toHex(mix(rgb, isDark(rgb) ? WHITE : BLACK, 0.1)),
    "--primary-foreground": toHex(readableOn(rgb)),
  };
}

/** The CSS variables a parsed theme sets in one mode. An accent alone fills in the other accent tokens. */
export function themeVars(theme: CustomTheme, dark: boolean, basePage: string): Record<string, string> {
  const set = dark ? theme.dark : theme.light;
  const out: Record<string, string> = {};
  if (set.accent) Object.assign(out, accentVars(set.accent, set.page ?? basePage, dark));
  for (const [k, v] of Object.entries(set)) out[`--${k}`] = v;
  if (set.primary && !set["primary-foreground"]) {
    const page = parseColor(set.page ?? basePage);
    const bg = parseColor(set.primary);
    if (bg) out["--primary-foreground"] = toHex(readableOn(composite(bg, page ? composite(page, dark ? BLACK : WHITE) : dark ? BLACK : WHITE)));
  }
  return out;
}

/** A starting point for the custom theme field: the given palette's swatch colors as tokens. */
export function themeTemplate(base: string, colors: { light: Record<string, string>; dark: Record<string, string> }): string {
  const pick = (c: Record<string, string>) => ({ page: c.page, sidebar: c.sidebar, surface: c.surface, ink: c.ink, "ink-3": c.ink3, accent: c.accent });
  return `${JSON.stringify({ base, dark: pick(colors.dark), light: pick(colors.light) }, null, 2)}\n`;
}
