/* Color math shared by the settings registry, the theme parser and their tests (no DOM).
 * Colors are sRGB 0..255 plus alpha 0..1; contrast follows WCAG 2. */

export type Rgb = [number, number, number];
export type Rgba = { rgb: Rgb; alpha: number };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function hexToRgba(hex: string): Rgba | null {
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex);
  if (!m) return null;
  const h = m[1].length <= 4 ? [...m[1]].map((c) => c + c).join("") : m[1];
  const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
  return { rgb, alpha: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
}

/** "50%" -> 0.5 of `scale`, "0.5" -> 0.5 * `unit` */
function num(raw: string, scale: number, unit = 1): number | null {
  if (raw === "none") return 0;
  const pct = raw.endsWith("%");
  const n = Number(pct ? raw.slice(0, -1) : raw);
  if (!Number.isFinite(n)) return null;
  return pct ? (n / 100) * scale : n * unit;
}

function hue(raw: string): number | null {
  const m = /^(-?[\d.]+)(deg|turn|rad)?$/.exec(raw);
  if (!m) return raw === "none" ? 0 : null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return m[2] === "turn" ? n * 360 : m[2] === "rad" ? (n * 180) / Math.PI : n;
}

const toSrgb = (lin: number) => 255 * (lin <= 0.0031308 ? 12.92 * lin : 1.055 * lin ** (1 / 2.4) - 0.055);

export function oklchToRgb(l: number, c: number, h: number): Rgb {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_, -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_, -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_];
  return lin.map((x) => clamp(toSrgb(clamp(x, 0, 1)), 0, 255)) as Rgb;
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)].map((v) => v * 255) as Rgb;
}

/**
 * A CSS color as sRGB: hex (3, 4, 6 or 8 digits), rgb()/rgba(), hsl()/hsla(), oklch() and `transparent`.
 * Anything else (named colors, var(), color-mix()) is null.
 */
export function parseColor(input: string): Rgba | null {
  const v = input.trim().toLowerCase();
  if (v === "transparent") return { rgb: [0, 0, 0], alpha: 0 };
  if (v.startsWith("#")) return hexToRgba(v);
  const m = /^(rgba?|hsla?|oklch)\(\s*([^()]*?)\s*\)$/.exec(v);
  if (!m) return null;
  const [main, alphaPart, extra] = m[2].split("/").map((s) => s.trim());
  if (extra !== undefined) return null;
  const parts = main.split(/[\s,]+/).filter(Boolean);
  let alphaRaw: string | undefined = alphaPart;
  if (alphaRaw === undefined && parts.length === 4 && main.includes(",")) alphaRaw = parts.pop();
  if (parts.length !== 3) return null;
  const alpha = alphaRaw === undefined ? 1 : num(alphaRaw, 1);
  if (alpha === null) return null;
  let rgb: Rgb | null = null;
  if (m[1].startsWith("rgb")) {
    const c = parts.map((p) => num(p, 255));
    if (c.some((x) => x === null)) return null;
    rgb = c as Rgb;
  } else if (m[1].startsWith("hsl")) {
    const h = hue(parts[0]);
    const s = num(parts[1], 1, 0.01);
    const l = num(parts[2], 1, 0.01);
    if (h === null || s === null || l === null) return null;
    rgb = hslToRgb(((h % 360) + 360) % 360, clamp(s, 0, 1), clamp(l, 0, 1));
  } else {
    const l = num(parts[0], 1);
    const c = num(parts[1], 0.4);
    const h = hue(parts[2]);
    if (l === null || c === null || h === null) return null;
    rgb = oklchToRgb(clamp(l, 0, 1), Math.max(0, c), h);
  }
  return { rgb: rgb.map((x) => clamp(x, 0, 255)) as Rgb, alpha: clamp(alpha, 0, 1) };
}

export const toHex = ([r, g, b]: Rgb) => `#${[r, g, b].map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0")).join("")}`;

/** `fg` painted over an opaque `bg` */
export const composite = ({ rgb, alpha }: Rgba, bg: Rgb): Rgb => rgb.map((v, i) => v * alpha + bg[i] * (1 - alpha)) as Rgb;

export function luminance([r, g, b]: Rgb): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `a` moved `t` (0..1) of the way to `b` */
export const mix = (a: Rgb, b: Rgb, t: number): Rgb => a.map((v, i) => v + (b[i] - v) * t) as Rgb;

export const WHITE: Rgb = [255, 255, 255];
export const INK_BLACK: Rgb = [10, 10, 10];

/** `fg` moved toward black (on a light `bg`) or white (on a dark one) just far enough to reach `ratio` */
export function ensureContrast(fg: Rgb, bg: Rgb, ratio: number): Rgb {
  if (contrast(fg, bg) >= ratio) return fg;
  const toward: Rgb = luminance(bg) > 0.18 ? [0, 0, 0] : WHITE;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 14; i++) {
    const t = (lo + hi) / 2;
    if (contrast(mix(fg, toward, t), bg) >= ratio) hi = t;
    else lo = t;
  }
  return mix(fg, toward, hi).map((v) => (toward[0] ? Math.ceil(v) : Math.floor(v))) as Rgb;
}

/** White or near-black, whichever reads better on `bg`; pure black where near-black would miss 4.5:1 */
export function readableOn(bg: Rgb): Rgb {
  const white = contrast(WHITE, bg);
  const ink = contrast(INK_BLACK, bg);
  if (white >= ink && white >= 4.5) return WHITE;
  if (ink > white && ink >= 4.5) return INK_BLACK;
  return contrast([0, 0, 0], bg) > white ? [0, 0, 0] : WHITE;
}

export const isDark = (rgb: Rgb) => luminance(rgb) < 0.18;
