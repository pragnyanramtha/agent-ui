/* What the Terminal settings mean for an xterm instance. Pure, so the mapping can be tested without a browser;
 * components/claude/WebTerminal.tsx builds the context (fonts, page colors) and applies the result live. */

import type { Settings } from "@/lib/settings-schema";
import { schemeTheme, type TerminalTheme } from "./terminal-theme";

export const NERD_FONT = '"Symbols Nerd Font Mono"';

/** next/font registers these families under their own names; "code" reads the page's current code font instead */
export const TERMINAL_FONT_FACES: Record<Exclude<Settings["terminalFont"], "code">, string> = {
  jetbrains: "'JetBrains Mono', 'JetBrains Mono Fallback'",
  "geist-mono": "'Geist Mono', 'Geist Mono Fallback'",
  "fira-code": "'Fira Code', 'Fira Code Fallback'",
  system: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono"',
};

export type TerminalPrefs = Pick<
  Settings,
  "terminalFont" | "terminalFontSize" | "terminalLineHeight" | "terminalCursor" | "terminalCursorBlink" | "terminalScrollback" | "terminalOptionMeta" | "terminalTheme"
>;

export type TerminalContext = {
  /** the page's code font (the --font-mono-face variable) */
  codeFace: string;
  /** colors that follow the app, for the "app" scheme */
  appTheme: TerminalTheme;
  /** a phone that never picked a size starts one smaller */
  phone?: boolean;
  sizeChosen?: boolean;
};

export type TerminalOptions = {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: "block" | "bar" | "underline";
  cursorBlink: boolean;
  scrollback: number;
  macOptionIsMeta: boolean;
  theme: TerminalTheme;
};

export function terminalFace(choice: Settings["terminalFont"], codeFace: string): string {
  return choice === "code" ? codeFace.trim() : TERMINAL_FONT_FACES[choice] ?? codeFace.trim();
}

/** The font stack: the chosen face, then Nerd Font symbols for prompt icons, then the system monospace. */
export const fontStack = (face: string) => `${face ? `${face}, ` : ""}${NERD_FONT}, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;

export function terminalOptions(p: TerminalPrefs, ctx: TerminalContext): TerminalOptions {
  return {
    fontFamily: fontStack(terminalFace(p.terminalFont, ctx.codeFace)),
    fontSize: ctx.phone && !ctx.sizeChosen ? Math.max(8, p.terminalFontSize - 1) : p.terminalFontSize,
    lineHeight: p.terminalLineHeight,
    cursorStyle: p.terminalCursor,
    cursorBlink: p.terminalCursorBlink,
    scrollback: p.terminalScrollback,
    macOptionIsMeta: p.terminalOptionMeta,
    theme: schemeTheme(p.terminalTheme) ?? ctx.appTheme,
  };
}

/** Options whose change moves the cell grid, so the terminal has to refit. */
const LAYOUT: readonly (keyof TerminalOptions)[] = ["fontFamily", "fontSize", "lineHeight"];

/** Sets the options that differ on a live terminal. Returns what changed and whether it needs a refit. */
export function applyTerminalOptions(term: { options: Record<string, unknown> }, next: TerminalOptions): { changed: (keyof TerminalOptions)[]; refit: boolean } {
  const changed: (keyof TerminalOptions)[] = [];
  for (const key of Object.keys(next) as (keyof TerminalOptions)[]) {
    const cur = term.options[key];
    const val = next[key];
    if (typeof val === "object" ? JSON.stringify(cur) === JSON.stringify(val) : cur === val) continue;
    term.options[key] = val;
    changed.push(key);
  }
  return { changed, refit: changed.some((k) => LAYOUT.includes(k)) };
}
