/* xterm colors that follow the app: background and foreground come from the page and ink variables,
 * the ANSI palette from the theme's lightness. Pure helpers are testable without a DOM. */

export type TerminalTheme = {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionInactiveBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
};

type Ansi = Omit<TerminalTheme, "background" | "foreground" | "cursor" | "cursorAccent" | "selectionBackground" | "selectionInactiveBackground">;

export const NORMAL = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;
export const BRIGHT = ["brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const;

/* One Dark-ish, matched to the app's dark page */
export const DARK_ANSI: Ansi = {
  black: "#1d1e21",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#c9ccd3",
  brightBlack: "#6b7079",
  brightRed: "#f28b94",
  brightGreen: "#b5e08f",
  brightYellow: "#f2d398",
  brightBlue: "#8cc7ff",
  brightMagenta: "#dc9ef0",
  brightCyan: "#7fd3dd",
  brightWhite: "#ffffff",
};

/* GitHub Light-ish: "white" is a mid gray so `ls` and prompts that print white stay readable on paper */
export const LIGHT_ANSI: Ansi = {
  black: "#24292f",
  red: "#c4232d",
  green: "#116329",
  yellow: "#7a4d00",
  blue: "#0960c8",
  magenta: "#7a3fd6",
  cyan: "#136b72",
  white: "#666d76",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#8a5a00",
  brightBlue: "#1f6fd1",
  brightMagenta: "#8e4fe6",
  brightCyan: "#1b7c83",
  brightWhite: "#8c959f",
};

export const DARK_FALLBACK = { page: "#17181a", ink: "#e6e8ec", accent: "#61afef" };
export const LIGHT_FALLBACK = { page: "#fcfcfd", ink: "#2b2d31", accent: "#0960c8" };

type Rgb = [number, number, number];

export function parseHex(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
}

export const toHex = ([r, g, b]: Rgb) => `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;

export function luminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `a` moved `t` (0..1) of the way to `b` */
export function mix(a: string, b: string, t: number): string {
  const x = parseHex(a);
  const y = parseHex(b);
  if (!x || !y) return a;
  return toHex(x.map((v, i) => v + (y[i] - v) * t) as Rgb);
}

/** `fg` darkened (on a light `bg`) or lightened (on a dark one) just enough to reach `ratio` */
export function ensureContrast(fg: string, bg: string, ratio: number): string {
  if (contrast(fg, bg) >= ratio) return fg;
  const toward = luminance(bg) > 0.18 ? "#000000" : "#ffffff";
  for (let t = 0.05; t <= 1; t += 0.05) {
    const next = mix(fg, toward, t);
    if (contrast(next, bg) >= ratio) return next;
  }
  return toward;
}

export const isDarkColor = (hex: string) => luminance(hex) < 0.18;

/**
 * The theme for a page color, ink color and accent (hex). Normal ANSI colors keep 4.5:1 against a light
 * background and bright ones 3:1, whatever palette the page uses.
 */
export function buildTerminalTheme({ dark, page, ink, accent }: { dark: boolean; page?: string | null; ink?: string | null; accent?: string | null }): TerminalTheme {
  const fb = dark ? DARK_FALLBACK : LIGHT_FALLBACK;
  const background = page && parseHex(page) ? page.toLowerCase() : fb.page;
  const foreground = ensureContrast(ink && parseHex(ink) ? ink.toLowerCase() : fb.ink, background, 7);
  const tint = accent && parseHex(accent) ? accent : fb.accent;
  const ansi: Ansi = { ...(dark ? DARK_ANSI : LIGHT_ANSI) };
  if (!dark) {
    for (const k of NORMAL) ansi[k] = ensureContrast(ansi[k], background, 4.5);
    for (const k of BRIGHT) ansi[k] = ensureContrast(ansi[k], background, 3);
  }
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: mix(background, tint, dark ? 0.35 : 0.22),
    selectionInactiveBackground: mix(background, foreground, dark ? 0.16 : 0.1),
    ...ansi,
  };
}

type Scheme = { bg: string; fg: string; cursor: string; selection: string; ansi: Ansi };

const scheme = ({ bg, fg, cursor, selection, ansi }: Scheme): TerminalTheme => ({
  background: bg,
  foreground: fg,
  cursor,
  cursorAccent: bg,
  selectionBackground: selection,
  selectionInactiveBackground: mix(bg, fg, 0.12),
  ...ansi,
});

/** Classic terminal color schemes, for people who want the terminal to look the same whatever the app palette. */
export const TERMINAL_SCHEMES = [
  {
    id: "one-dark",
    label: "One Dark",
    theme: scheme({
      bg: "#282c34",
      fg: "#abb2bf",
      cursor: "#528bff",
      selection: "#3e4451",
      ansi: { ...DARK_ANSI, black: "#282c34", white: "#abb2bf", brightBlack: "#5c6370" },
    }),
  },
  {
    id: "dracula",
    label: "Dracula",
    theme: scheme({
      bg: "#282a36",
      fg: "#f8f8f2",
      cursor: "#f8f8f2",
      selection: "#44475a",
      ansi: {
        black: "#21222c",
        red: "#ff5555",
        green: "#50fa7b",
        yellow: "#f1fa8c",
        blue: "#bd93f9",
        magenta: "#ff79c6",
        cyan: "#8be9fd",
        white: "#f8f8f2",
        brightBlack: "#6272a4",
        brightRed: "#ff6e6e",
        brightGreen: "#69ff94",
        brightYellow: "#ffffa5",
        brightBlue: "#d6acff",
        brightMagenta: "#ff92df",
        brightCyan: "#a4ffff",
        brightWhite: "#ffffff",
      },
    }),
  },
  {
    id: "solarized-dark",
    label: "Solarized Dark",
    theme: scheme({
      bg: "#002b36",
      fg: "#93a1a1",
      cursor: "#93a1a1",
      selection: "#0d4a5a",
      ansi: {
        black: "#073642",
        red: "#dc322f",
        green: "#859900",
        yellow: "#b58900",
        blue: "#268bd2",
        magenta: "#d33682",
        cyan: "#2aa198",
        white: "#eee8d5",
        brightBlack: "#586e75",
        brightRed: "#cb4b16",
        brightGreen: "#9cb200",
        brightYellow: "#d4a000",
        brightBlue: "#4aa3e6",
        brightMagenta: "#6c71c4",
        brightCyan: "#3cc0b5",
        brightWhite: "#fdf6e3",
      },
    }),
  },
  {
    id: "solarized-light",
    label: "Solarized Light",
    theme: scheme({
      bg: "#fdf6e3",
      fg: "#586e75",
      cursor: "#586e75",
      selection: "#eee1bc",
      ansi: {
        black: "#073642",
        red: "#c4271f",
        green: "#5f6f00",
        yellow: "#7f6000",
        blue: "#1a6eb0",
        magenta: "#b02a6b",
        cyan: "#1a7a72",
        white: "#6b7f85",
        brightBlack: "#586e75",
        brightRed: "#b8400f",
        brightGreen: "#6b7d00",
        brightYellow: "#8a6900",
        brightBlue: "#2a7cc0",
        brightMagenta: "#5a5fb0",
        brightCyan: "#1f8a80",
        brightWhite: "#002b36",
      },
    }),
  },
  {
    id: "gruvbox-dark",
    label: "Gruvbox Dark",
    theme: scheme({
      bg: "#282828",
      fg: "#ebdbb2",
      cursor: "#ebdbb2",
      selection: "#504945",
      ansi: {
        black: "#282828",
        red: "#cc241d",
        green: "#98971a",
        yellow: "#d79921",
        blue: "#458588",
        magenta: "#b16286",
        cyan: "#689d6a",
        white: "#a89984",
        brightBlack: "#928374",
        brightRed: "#fb4934",
        brightGreen: "#b8bb26",
        brightYellow: "#fabd2f",
        brightBlue: "#83a598",
        brightMagenta: "#d3869b",
        brightCyan: "#8ec07c",
        brightWhite: "#ebdbb2",
      },
    }),
  },
  {
    id: "github-light",
    label: "GitHub Light",
    theme: scheme({ bg: "#ffffff", fg: "#24292f", cursor: "#0969da", selection: "#cce4ff", ansi: LIGHT_ANSI }),
  },
] as const satisfies readonly { id: string; label: string; theme: TerminalTheme }[];

/** A fixed scheme by id, or null for "app" (and anything unknown), which follows the page. */
export const schemeTheme = (id: string): TerminalTheme | null => TERMINAL_SCHEMES.find((s) => s.id === id)?.theme ?? null;

let probe: CanvasRenderingContext2D | null | undefined;

/** Any CSS color (oklch, hsl, named...) as #rrggbb, via a 1px canvas; null when the browser can't parse it */
export function cssColorToHex(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (parseHex(v)) return toHex(parseHex(v)!);
  if (probe === undefined) probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!probe) return null;
  probe.fillStyle = "#010203";
  probe.fillStyle = v;
  if (probe.fillStyle === "#010203") return null;
  probe.clearRect(0, 0, 1, 1);
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
  return toHex([r, g, b]);
}

/** The terminal theme for whatever the app shows right now */
export function readTerminalTheme(): TerminalTheme {
  const root = document.documentElement;
  const css = getComputedStyle(root);
  const read = (name: string) => cssColorToHex(css.getPropertyValue(name));
  const page = read("--page");
  const dark = page ? isDarkColor(page) : root.classList.contains("dark");
  return buildTerminalTheme({ dark, page, ink: read("--ink"), accent: read("--accent") });
}

/** "#17181a" -> "rgb:1717/1818/1a1a", the form OSC 10/11 replies use */
export const oscColor = (hex: string) => `rgb:${[1, 3, 5].map((i) => hex.slice(i, i + 2).repeat(2)).join("/")}`;
