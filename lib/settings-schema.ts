/* Every user setting in one typed registry, shared by the browser and the server (no React, no DOM).
 *
 * A setting is data: where it shows (section, group), how it reads (label, description), what it accepts (type,
 * options or range), its default, and where it lives:
 *   - "device": this browser's localStorage only (text size on this phone, terminal panel on this laptop)
 *   - "synced": the server's settings.json, so every browser signed in to this server shares it
 * Settings that change the look also say how they land on <html> (`dom`), which drives both the pre-paint script in
 * app/layout.tsx and the live updates in lib/client/settings.ts.
 *
 * Adding one: add an entry to SETTINGS below. The Settings screen lists it in its section with a control picked
 * from its type; search, reset, export and import pick it up too. */

import { effortOptions } from "./agent-traits";
import type { AgentId } from "./types";
import { COMMANDS, normalizeBindingsText, parseBindings, type Command } from "./keybindings";
import { choiceMs, fetchIntervalLabel } from "./git-interval";
import { TERMINAL_SCHEMES } from "./client/terminal-theme";
import { accentVars, ACCENT_TOKENS, parseCustomTheme, themeVars, THEME_VARS, type Bases } from "./theme";
import { SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN } from "./sidebar-width";
import { SSH_HOST } from "./editor-links";

export type Scope = "device" | "synced";

export type SectionId = "general" | "appearance" | "sidebar" | "composer" | "conversation" | "terminal" | "notifications" | "keyboard" | "agents" | "git" | "data" | "about" | "storage" | "projects";

export type SectionInfo = {
  id: SectionId;
  label: string;
  description: string;
  /** rows that aren't settings (buttons, lists) but should still come up in search */
  items?: { id: string; label: string; description?: string; keywords?: string[] }[];
};

export const SECTIONS: readonly SectionInfo[] = [
  { id: "general", label: "General", description: "Theme and your account on this server.", items: [
      { id: "sign-out", label: "Sign out", description: "Signs this browser out.", keywords: ["log out", "logout", "account"] },
      { id: "sign-out-everywhere", label: "Sign out everywhere", description: "Signs out every device, this one too.", keywords: ["log out", "logout", "revoke", "devices", "account"] },
    ],
  },
  { id: "appearance", label: "Appearance", description: "Colors, fonts, sizes and spacing." },
  { id: "sidebar", label: "Sidebar", description: "How the session list groups, sorts and shows sessions." },
  { id: "composer", label: "Composer", description: "How messages are written and sent." },
  { id: "conversation", label: "Conversation", description: "How sessions read." },
  { id: "terminal", label: "Terminal", description: "Terminals opened from a session or the menu." },
  {
    id: "notifications",
    label: "Notifications",
    description: "Alerts when agents finish or need you.",
    items: [
      { id: "push", label: "Push notifications", description: "Finished turns, approvals and failures.", keywords: ["alerts", "web push"] },
      { id: "test", label: "Send test notification", description: "Try every alert that's on.", keywords: ["alerts", "try", "check"] },
    ],
  },
  {
    id: "keyboard",
    label: "Keyboard",
    description: "Shortcuts on devices with a keyboard.",
    items: [
      { id: "shortcuts", label: "Keyboard shortcuts", keywords: ["keys", "hotkeys", "bindings", "rebind", "keybindings"] },
      ...COMMANDS.map((c: Command) => ({ id: `cmd:${c.id}`, label: c.label, keywords: ["shortcut", "keys", c.group, ...(c.keywords ?? [])] })),
    ],
  },
  { id: "agents", label: "Agents", description: "Agent CLIs, accounts and running terminals.", items: [{ id: "profiles", label: "Profiles and terminals", description: "Accounts, proxies, models and running agents.", keywords: ["claude", "codex", "models", "accounts", "proxy"] }] },
  { id: "git", label: "Git", description: "Diffs, commits, the remote and worktrees." },
  {
    id: "data",
    label: "Data",
    description: "Back up, move or reset your settings.",
    items: [
      { id: "export", label: "Export settings", description: "Download your settings as a file.", keywords: ["backup", "download", "json"] },
      { id: "import", label: "Import settings", description: "Load settings from a file.", keywords: ["restore", "upload", "json"] },
      { id: "reset-all", label: "Reset all settings", keywords: ["defaults", "clear"] },
    ],
  },
  { id: "about", label: "About", description: "Version and links.", items: [{ id: "version", label: "Version", keywords: ["build", "commit", "release", "server"] }] },
  {
    id: "storage",
    label: "Storage",
    description: "Disk used by worktrees, attachments and checkpoints.",
    items: [
      { id: "usage", label: "Disk usage", description: "Worktrees, attachments and checkpoints on the server.", keywords: ["space", "size", "disk", "bytes", "full"] },
      { id: "clean-now", label: "Clean up now", description: "Lists what would go, then deletes it.", keywords: ["delete", "remove", "free space", "prune", "dry run"] },
    ],
  },
  {
    id: "projects",
    label: "Projects",
    description: "Defaults for new sessions and run actions, per folder.",
    items: [
      { id: "project-defaults", label: "Project defaults", description: "Profile, model, approvals and worktrees for new sessions in a folder.", keywords: ["folder", "repository", "repo", "profile", "model", "approvals", "effort", "worktree"] },
      { id: "branch-prefix", label: "Branch prefix", description: "How worktree branches for a project are named.", keywords: ["worktree", "branch", "naming", "git"] },
      { id: "run-actions", label: "Run actions", description: "Commands the session header's Run menu starts in a terminal.", keywords: ["scripts", "package.json", "npm", "pnpm", "yarn", "bun", "dev server", "tasks", "commands"] },
    ],
  },
];

/** How a setting shows on <html>: a data attribute with its value, and/or a CSS variable. Default values set nothing. */
export type Dom = {
  attr?: `data-${string}`;
  cssVar?: `--${string}`;
  /** appended to the variable's value (px) */
  unit?: string;
  /** the variable gets value * factor (110 -> 1.1) */
  factor?: number;
  /** only applied while another setting has this value */
  when?: readonly [key: string, value: string];
};

type Common<T> = {
  section: SectionId;
  /** other sections that list it too */
  alsoIn?: readonly SectionId[];
  /** a subheading inside the section; rows with the same group share a card */
  group?: string;
  label: string;
  description?: string;
  keywords?: readonly string[];
  scope: Scope;
  default: T;
  /** device settings only: the default on touch screens (coarse pointer) until the user picks a value */
  touchDefault?: T;
  /** device settings only: the localStorage key (default `cui:set:<key>`) and how its stored text reads.
   * Older keys keep their own format so earlier choices survive. */
  storage?: { key: string; parse(raw: string): T | undefined; format(value: T): string; plain?: boolean };
  dom?: Dom;
  /** listed only while another setting has this value (or one of these values) */
  showIf?: readonly [key: string, value: unknown];
  /** not a row of its own: its section edits it with its own controls (still reset, exported and imported) */
  hidden?: boolean;
};

export type BooleanSetting = Common<boolean> & { type: "boolean" };
export type EnumOption<T extends string = string> = { value: T; label: string; hint?: string };
export type EnumSetting<T extends string = string> = Common<T> & { type: "enum"; options: readonly EnumOption<T>[]; control?: "segmented" | "select" | "swatches" | "palette" };
export type NumberSetting = Common<number> & { type: "number"; min: number; max: number; step: number; unit?: string; control?: "slider" | "segmented" | "hue" };
export type StringSetting = Common<string> & {
  type: "string";
  maxLength: number;
  placeholder?: string;
  pattern?: RegExp;
  /** the canonical form of a value, or null when it isn't valid */
  normalize?: (value: string) => string | null;
  /** how the value reads in an import summary */
  summary?: (value: string) => string;
  /** a finer check than a pattern: null when the value is fine, else why not ("isn't a valid ...") */
  check?: (value: string) => string | null;
  control?: "theme-json";
};
export type ColorSetting = Common<string> & { type: "color" };
export type SettingDef = BooleanSetting | EnumSetting | NumberSetting | StringSetting | ColorSetting;

const boolean = (d: Omit<BooleanSetting, "type">): BooleanSetting => ({ type: "boolean", ...d });
const choice = <const T extends string>(d: Omit<EnumSetting<T>, "type">): EnumSetting<T> => ({ type: "enum", ...d });
const number = (d: Omit<NumberSetting, "type">): NumberSetting => ({ type: "number", ...d });
const text = (d: Omit<StringSetting, "type">): StringSetting => ({ type: "string", ...d });
const color = (d: Omit<ColorSetting, "type">): ColorSetting => ({ type: "color", ...d });

/* ── palettes ─────────────────────────────────────────────── */

/** Swatch colors for the palette picker and the browser chrome color (`page`). The full token sets live in
 * app/globals.css under [data-palette=...]; tests/palettes.test.ts checks that `page` matches them. */
export type PaletteColors = { page: string; sidebar: string; surface: string; line: string; ink: string; ink3: string; accent: string };
export type Palette = { id: string; label: string; light: PaletteColors; dark: PaletteColors };

export const PALETTES = [
  {
    id: "default",
    label: "Default",
    light: { page: "#ffffff", sidebar: "#f9f9f9", surface: "#ffffff", line: "#ebebeb", ink: "#0d0d0d", ink3: "#6b6b6b", accent: "#2f74e0" },
    dark: { page: "#212121", sidebar: "#181818", surface: "#2a2a2a", line: "#333333", ink: "#ececec", ink3: "#9b9b9b", accent: "#5fa0f7" },
  },
  {
    id: "slate",
    label: "Slate",
    light: { page: "#fbfdff", sidebar: "#f5f7fa", surface: "#ffffff", line: "#e6e8eb", ink: "#1e1f22", ink3: "#6c6f73", accent: "#2f74e0" },
    dark: { page: "#151617", sidebar: "#0f1012", surface: "#1b1c1e", line: "#27282a", ink: "#eff0f3", ink3: "#88898c", accent: "#5fa0f7" },
  },
  {
    id: "graphite",
    label: "Graphite",
    light: { page: "#fcfcfc", sidebar: "#f6f6f7", surface: "#ffffff", line: "#e9e9ec", ink: "#18181b", ink3: "#6b6b74", accent: "#3f3f46" },
    dark: { page: "#18181b", sidebar: "#121214", surface: "#1f1f23", line: "#2a2a2e", ink: "#f4f4f5", ink3: "#93939c", accent: "#d4d4d8" },
  },
  {
    id: "midnight",
    label: "Midnight",
    light: { page: "#f8fafc", sidebar: "#f1f5f9", surface: "#ffffff", line: "#e2e8f0", ink: "#0f172a", ink3: "#5b6b82", accent: "#3b63e6" },
    dark: { page: "#0b1020", sidebar: "#070b16", surface: "#111831", line: "#1c2544", ink: "#e6ebf5", ink3: "#8793ad", accent: "#7c9cff" },
  },
  {
    id: "nord",
    label: "Nord",
    light: { page: "#eceff4", sidebar: "#e5e9f0", surface: "#f8f9fb", line: "#d8dee9", ink: "#2e3440", ink3: "#566176", accent: "#5e81ac" },
    dark: { page: "#2e3440", sidebar: "#272c36", surface: "#3b4252", line: "#3f4757", ink: "#eceff4", ink3: "#a3acbd", accent: "#88c0d0" },
  },
  {
    id: "solarized",
    label: "Solarized",
    light: { page: "#fdf6e3", sidebar: "#f5eedb", surface: "#fffbef", line: "#e8e1cc", ink: "#073642", ink3: "#586e75", accent: "#268bd2" },
    dark: { page: "#002b36", sidebar: "#00232c", surface: "#073642", line: "#0d404c", ink: "#eee8d5", ink3: "#93a1a1", accent: "#268bd2" },
  },
  {
    id: "catppuccin",
    label: "Catppuccin",
    light: { page: "#eff1f5", sidebar: "#e6e9ef", surface: "#f7f8fb", line: "#dce0e8", ink: "#4c4f69", ink3: "#62657b", accent: "#8839ef" },
    dark: { page: "#1e1e2e", sidebar: "#181825", surface: "#252536", line: "#2e2f42", ink: "#cdd6f4", ink3: "#9399b2", accent: "#cba6f7" },
  },
  {
    id: "rose-pine",
    label: "Rosé Pine",
    light: { page: "#faf4ed", sidebar: "#f4ede8", surface: "#fffaf3", line: "#ebe2d9", ink: "#575279", ink3: "#6b6787", accent: "#286983" },
    dark: { page: "#191724", sidebar: "#15131f", surface: "#1f1d2e", line: "#2a2740", ink: "#e0def4", ink3: "#908caa", accent: "#c4a7e7" },
  },
  {
    id: "github",
    label: "GitHub",
    light: { page: "#ffffff", sidebar: "#f6f8fa", surface: "#ffffff", line: "#d8dee4", ink: "#1f2328", ink3: "#636c76", accent: "#0969da" },
    dark: { page: "#0d1117", sidebar: "#010409", surface: "#161b22", line: "#21262d", ink: "#e6edf3", ink3: "#8d96a0", accent: "#4493f8" },
  },
] as const satisfies readonly Palette[];

export type PaletteId = (typeof PALETTES)[number]["id"];

/** Swatch colors per palette, for checking custom themes and placing a custom accent on its page. */
export const PALETTE_BASES: Bases = Object.fromEntries(PALETTES.map((p) => [p.id, { light: p.light, dark: p.dark }]));

const paletteOptions = PALETTES.map((p) => ({ value: p.id, label: p.label }));

/** Accent swatches: an oklch hue and a chroma factor (0 is neutral gray). */
export const ACCENTS = [
  { value: "blue", label: "Blue", hue: 256, chroma: 1 },
  { value: "violet", label: "Violet", hue: 292, chroma: 1 },
  { value: "green", label: "Green", hue: 150, chroma: 0.8 },
  { value: "orange", label: "Orange", hue: 50, chroma: 1 },
  { value: "pink", label: "Pink", hue: 350, chroma: 1 },
  { value: "teal", label: "Teal", hue: 190, chroma: 0.75 },
  { value: "neutral", label: "Neutral", hue: 260, chroma: 0 },
] as const;

/* ── the registry ─────────────────────────────────────────── */

const bit = { parse: (raw: string) => raw === "1", format: (v: boolean) => (v ? "1" : "0") };

export const SETTINGS = {
  /* general / appearance */
  theme: choice({
    section: "appearance",
    alsoIn: ["general"],
    group: "Theme",
    label: "Theme",
    description: "System follows this device's light or dark setting.",
    keywords: ["dark mode", "light mode", "color scheme"],
    scope: "device",
    default: "dark",
    options: [
      { value: "system", label: "System" },
      { value: "light", label: "Light" },
      { value: "dark", label: "Dark" },
    ],
    /* written by the theme script before paint, so it stays a bare string */
    storage: { key: "bui-theme", plain: true, parse: (raw) => (raw === "light" || raw === "system" ? raw : "dark"), format: (v) => v },
  }),
  palette: choice({
    section: "appearance",
    group: "Theme",
    label: "Palette",
    description: "Each has a light and a dark version.",
    keywords: ["colors", "color theme", "nord", "solarized", "catppuccin", "rose pine", "github", "midnight", "graphite", "slate", "custom theme"],
    scope: "synced",
    default: "default",
    control: "palette",
    options: [...paletteOptions, { value: "custom", label: "Custom" }],
    dom: { attr: "data-palette" },
  }),
  customTheme: text({
    section: "appearance",
    group: "Theme",
    label: "Custom theme",
    description: "Token overrides as JSON, on top of a base palette. Saved and exported with your settings.",
    keywords: ["json", "tokens", "colors", "import theme", "paste"],
    scope: "synced",
    default: "",
    maxLength: 8000,
    control: "theme-json",
    showIf: ["palette", "custom"],
    check: (v) => (v === "" || parseCustomTheme(v, PALETTE_BASES).ok ? null : "isn't a valid custom theme"),
  }),
  lightPalette: choice({
    section: "appearance",
    group: "Theme",
    label: "Palette in light mode",
    description: "Use a different palette while the theme is light.",
    keywords: ["colors", "light mode", "day", "separate"],
    scope: "synced",
    default: "same",
    control: "select",
    options: [{ value: "same", label: "Same as dark" }, ...paletteOptions, { value: "custom", label: "Custom" }],
  }),
  accent: choice({
    section: "appearance",
    group: "Theme",
    label: "Accent color",
    description: "Buttons, links, focus rings and selection.",
    keywords: ["highlight", "color", "hue"],
    scope: "synced",
    default: "auto",
    control: "swatches",
    options: [{ value: "auto", label: "Palette" }, ...ACCENTS.map((a) => ({ value: a.value, label: a.label })), { value: "custom", label: "Custom" }],
    dom: { attr: "data-accent" },
  }),
  accentColor: color({
    section: "appearance",
    group: "Theme",
    label: "Custom color",
    description: "Links and focus rings are adjusted to stay readable; button labels turn dark on light colors.",
    keywords: ["hex", "brand", "accent"],
    scope: "synced",
    default: "#f76b15",
    showIf: ["accent", "custom"],
  }),

  /* appearance: type */
  uiFont: choice({
    section: "appearance",
    group: "Text",
    label: "Interface font",
    keywords: ["typeface", "font family"],
    scope: "synced",
    default: "geist",
    control: "select",
    options: [
      { value: "geist", label: "Geist" },
      { value: "inter", label: "Inter" },
      { value: "system", label: "System UI" },
    ],
    dom: { attr: "data-ui-font" },
  }),
  codeFont: choice({
    section: "appearance",
    group: "Text",
    label: "Code font",
    description: "Code, diffs, paths and terminals.",
    keywords: ["monospace", "typeface", "font family"],
    scope: "synced",
    default: "jetbrains",
    control: "select",
    options: [
      { value: "jetbrains", label: "JetBrains Mono" },
      { value: "geist-mono", label: "Geist Mono" },
      { value: "fira-code", label: "Fira Code" },
      { value: "system", label: "System monospace" },
    ],
    dom: { attr: "data-code-font" },
  }),
  uiScale: number({
    section: "appearance",
    group: "Text",
    label: "Interface size",
    description: "Scales text and controls on this device.",
    keywords: ["zoom", "font size", "text size", "bigger", "smaller"],
    scope: "device",
    default: 100,
    min: 90,
    max: 120,
    step: 10,
    unit: "%",
    control: "segmented",
    dom: { attr: "data-ui-scale", cssVar: "--ui-scale", factor: 0.01 },
  }),
  codeSize: number({
    section: "appearance",
    group: "Text",
    label: "Code size",
    description: "Code blocks, diffs and tool output on this device.",
    keywords: ["font size", "monospace", "text size"],
    scope: "device",
    default: 12.5,
    min: 11,
    max: 16,
    step: 0.5,
    unit: "px",
    control: "slider",
    dom: { attr: "data-code-size", cssVar: "--code-size", unit: "px" },
  }),
  codeLigatures: boolean({
    section: "appearance",
    group: "Text",
    label: "Code ligatures",
    description: "Joins pairs like != and => into one glyph. Off shows exactly what was typed.",
    keywords: ["font", "monospace", "glyphs", "arrows"],
    scope: "device",
    default: false,
    dom: { attr: "data-ligatures" },
  }),

  /* appearance: layout */
  density: choice({
    section: "appearance",
    group: "Layout",
    label: "Density",
    description: "Space between messages, list rows and the composer.",
    keywords: ["spacing", "compact", "padding"],
    scope: "device",
    default: "comfortable",
    options: [
      { value: "compact", label: "Compact" },
      { value: "comfortable", label: "Comfortable" },
      { value: "spacious", label: "Spacious" },
    ],
    dom: { attr: "data-density" },
  }),
  conversationWidth: choice({
    section: "appearance",
    alsoIn: ["conversation"],
    group: "Layout",
    label: "Conversation width",
    description: "How wide messages and the composer get on large screens.",
    keywords: ["max width", "column", "measure"],
    scope: "device",
    default: "default",
    options: [
      { value: "narrow", label: "Narrow" },
      { value: "default", label: "Default" },
      { value: "wide", label: "Wide" },
      { value: "full", label: "Full" },
    ],
    dom: { attr: "data-width" },
  }),
  corners: choice({
    section: "appearance",
    group: "Layout",
    label: "Corners",
    keywords: ["radius", "rounded", "border radius"],
    scope: "synced",
    default: "default",
    options: [
      { value: "sharp", label: "Sharp" },
      { value: "default", label: "Default" },
      { value: "round", label: "Round" },
    ],
    dom: { attr: "data-corners" },
  }),
  translucentSidebar: boolean({
    section: "appearance",
    group: "Layout",
    label: "Translucent sidebar",
    description: "A soft wash of the accent shows through the sidebar, menus turn frosted, and the phone drawer blurs the page behind it.",
    keywords: ["vibrancy", "glass", "blur", "transparent", "frosted"],
    scope: "synced",
    default: false,
    dom: { attr: "data-translucent" },
  }),

  /* appearance: accessibility */
  reduceMotion: choice({
    section: "appearance",
    group: "Accessibility",
    label: "Reduce motion",
    description: "System follows this device's setting.",
    keywords: ["animation", "transitions", "vestibular"],
    scope: "device",
    default: "system",
    options: [
      { value: "system", label: "System" },
      { value: "on", label: "On" },
      { value: "off", label: "Off" },
    ],
    dom: { attr: "data-motion" },
  }),
  increaseContrast: boolean({
    section: "appearance",
    group: "Accessibility",
    label: "Increase contrast",
    description: "Darker secondary text and stronger borders.",
    keywords: ["accessibility", "borders", "legibility"],
    scope: "device",
    default: false,
    dom: { attr: "data-contrast" },
  }),
  showTimestamps: boolean({
    section: "appearance",
    alsoIn: ["conversation"],
    group: "Conversation",
    label: "Show timestamps",
    description: "Times under every message, not only on hover.",
    keywords: ["time", "clock", "date"],
    scope: "synced",
    default: false,
    dom: { attr: "data-timestamps" },
  }),

  /* sidebar */
  sidebarGroup: choice({
    section: "sidebar",
    group: "List",
    label: "Group sessions",
    description: "A flat list shows Pinned, then Recent.",
    keywords: ["projects", "folders", "flat", "recent", "session list"],
    scope: "synced",
    default: "project",
    options: [
      { value: "project", label: "By project" },
      { value: "flat", label: "Flat list" },
    ],
  }),
  sidebarSort: choice({
    section: "sidebar",
    group: "List",
    label: "Sort by",
    keywords: ["order", "newest", "alphabetical", "session list"],
    scope: "synced",
    default: "activity",
    options: [
      { value: "activity", label: "Last activity" },
      { value: "created", label: "Created" },
      { value: "title", label: "Title" },
    ],
  }),
  sidebarProjectCap: choice({
    section: "sidebar",
    group: "List",
    label: "Sessions per project",
    description: "How many show before Show more.",
    keywords: ["limit", "show more", "folders"],
    scope: "synced",
    default: "10",
    options: [
      { value: "5", label: "5" },
      { value: "10", label: "10" },
      { value: "20", label: "20" },
      { value: "all", label: "All" },
    ],
    showIf: ["sidebarGroup", "project"],
  }),
  sidebarShowArchived: boolean({
    section: "sidebar",
    group: "List",
    label: "Show archived",
    description: "An Archived list at the end, folded until opened.",
    keywords: ["hidden", "restore", "unarchive"],
    scope: "synced",
    default: true,
  }),
  sidebarAgentIcon: boolean({
    section: "sidebar",
    group: "Rows",
    label: "Show agent on rows",
    description: "A colored mark on sessions from agents other than Claude, when more than one has sessions.",
    keywords: ["claude", "codex", "gemini", "icon", "badge"],
    scope: "synced",
    default: true,
  }),
  sidebarTime: choice({
    section: "sidebar",
    group: "Rows",
    label: "Times",
    description: "Relative reads 2h or Mon. Absolute reads the clock time today, else the date.",
    keywords: ["relative", "absolute", "clock", "ago", "last activity"],
    scope: "synced",
    default: "relative",
    options: [
      { value: "relative", label: "Relative" },
      { value: "absolute", label: "Absolute" },
    ],
  }),
  sidebarConfirm: choice({
    section: "sidebar",
    group: "Rows",
    label: "Confirm first",
    description: "Archived sessions can be restored. Deleted ones can't.",
    keywords: ["ask", "archive", "delete", "dialog", "undo"],
    scope: "synced",
    default: "delete",
    control: "select",
    options: [
      { value: "delete", label: "Before deleting" },
      { value: "both", label: "Before archiving or deleting" },
      { value: "never", label: "Never" },
    ],
  }),

  /* composer */
  sendShortcut: choice({
    section: "composer",
    group: "Sending",
    label: "Send with",
    description: "Ctrl/Cmd+Enter always sends. On phones, Enter adds a new line unless you pick Enter everywhere.",
    keywords: ["submit", "newline", "new line", "return key", "enter", "ctrl enter", "cmd enter", "keyboard"],
    scope: "device",
    default: "mod-enter",
    control: "select",
    options: [
      { value: "enter", label: "Enter (Shift+Enter for a new line)" },
      { value: "mod-enter", label: "Ctrl/Cmd+Enter (Enter for a new line)" },
      { value: "enter-always", label: "Enter everywhere, phones too" },
    ],
    /* the old "Send with Enter" switch stored 1/0 under this key; those choices read as Enter and Ctrl/Cmd+Enter */
    storage: {
      key: "cui:send-enter",
      parse: (raw) => (raw === "1" ? "enter" : raw === "0" ? "mod-enter" : raw === "always" ? "enter-always" : undefined),
      format: (v) => (v === "enter" ? "1" : v === "mod-enter" ? "0" : "always"),
    },
  }),
  busySend: choice({
    section: "composer",
    group: "Sending",
    label: "Messages sent while the agent works",
    description: "Stop and send ends the current turn first, then sends.",
    keywords: ["queue", "interrupt", "steer", "busy", "running", "follow up"],
    scope: "synced",
    default: "queue",
    options: [
      { value: "queue", label: "Queue" },
      { value: "interrupt", label: "Stop and send" },
    ],
  }),
  longPaste: choice({
    section: "composer",
    group: "Sending",
    label: "Long pastes",
    description: "Pasted text over the line limit can ask before it's sent, or go in as a text file.",
    keywords: ["paste", "clipboard", "attachment", "file", "confirm", "large"],
    scope: "device",
    default: "text",
    control: "select",
    options: [
      { value: "text", label: "Paste as text" },
      { value: "confirm", label: "Ask before sending" },
      { value: "attach", label: "Attach as a file" },
    ],
  }),
  longPasteLines: number({
    section: "composer",
    group: "Sending",
    label: "Long paste limit",
    keywords: ["paste", "lines", "threshold"],
    scope: "device",
    default: 200,
    min: 20,
    max: 1000,
    step: 10,
    unit: " lines",
    control: "slider",
    showIf: ["longPaste", ["confirm", "attach"]],
  }),

  spellCheck: boolean({
    section: "composer",
    group: "Typing",
    label: "Spell check",
    description: "Underline misspelled words in the message box.",
    keywords: ["spelling", "spellcheck", "typos"],
    scope: "device",
    default: true,
  }),
  phoneAutocorrect: boolean({
    section: "composer",
    group: "Typing",
    label: "Autocorrect on phones",
    description: "Off suits code: no autocorrect and no automatic capitals.",
    keywords: ["autocapitalize", "capitals", "keyboard", "mobile", "code"],
    scope: "device",
    default: true,
  }),
  composerMaxLines: number({
    section: "composer",
    group: "Typing",
    label: "Message box height",
    description: "How many lines it grows to before it scrolls.",
    keywords: ["max height", "lines", "rows", "textarea", "size"],
    scope: "device",
    default: 8,
    min: 3,
    max: 24,
    step: 1,
    unit: " lines",
    control: "slider",
  }),
  rememberDrafts: boolean({
    section: "composer",
    group: "Typing",
    label: "Remember drafts",
    description: "Keep unsent text for each session on this device, across reloads.",
    keywords: ["draft", "unsent", "save", "restore"],
    scope: "device",
    default: true,
  }),

  effortClaude: choice({
    section: "composer",
    group: "Reasoning effort",
    label: "Claude",
    description: "Used when a session has no effort of its own. A profile's default wins.",
    keywords: ["effort", "thinking", "reasoning", "default"],
    scope: "synced",
    default: "default",
    options: [{ value: "default", label: "Default" }, ...effortOptions("claude").map((o) => ({ value: o.key, label: o.name }))],
    control: "select",
  }),
  effortCodex: choice({
    section: "composer",
    group: "Reasoning effort",
    label: "Codex",
    description: "Used when a session has no effort of its own. A profile's default wins.",
    keywords: ["effort", "reasoning", "default"],
    scope: "synced",
    default: "default",
    options: [{ value: "default", label: "Default" }, ...effortOptions("codex").map((o) => ({ value: o.key, label: o.name }))],
    control: "select",
  }),

  /* terminal */
  terminalDocked: boolean({
    section: "terminal",
    label: "Open in a panel",
    description: "On desktop, terminals open under the session. Off opens them full size.",
    keywords: ["dock", "shell", "sheet"],
    scope: "device",
    default: true,
    storage: { key: "cui:term-docked", parse: (raw) => raw !== "sheet", format: (v) => (v ? "dock" : "sheet") },
  }),
  terminalFont: choice({
    section: "terminal",
    group: "Text",
    label: "Font",
    description: "Code font follows Appearance.",
    keywords: ["typeface", "font family", "monospace"],
    scope: "synced",
    default: "code",
    control: "select",
    options: [
      { value: "code", label: "Code font" },
      { value: "jetbrains", label: "JetBrains Mono" },
      { value: "geist-mono", label: "Geist Mono" },
      { value: "fira-code", label: "Fira Code" },
      { value: "system", label: "System monospace" },
    ],
  }),
  terminalFontSize: number({
    section: "terminal",
    group: "Text",
    label: "Font size",
    description: "A− and A+ in the terminal change it too.",
    keywords: ["text size", "zoom", "bigger", "smaller"],
    scope: "device",
    default: 13,
    min: 8,
    max: 24,
    step: 1,
    unit: "px",
    control: "slider",
    /* the terminal's A-/A+ buttons stored a bare number here */
    storage: { key: "cui:term-font", parse: (raw) => (/^\d+(\.\d+)?$/.test(raw) ? Number(raw) : undefined), format: (v) => String(v) },
  }),
  terminalLineHeight: number({
    section: "terminal",
    group: "Text",
    label: "Line height",
    keywords: ["spacing", "leading", "rows"],
    scope: "device",
    default: 1.12,
    min: 1,
    max: 1.6,
    step: 0.02,
    control: "slider",
  }),
  terminalCursor: choice({
    section: "terminal",
    group: "Cursor",
    label: "Cursor style",
    keywords: ["caret", "block", "bar", "underline", "beam"],
    scope: "synced",
    default: "block",
    options: [
      { value: "block", label: "Block" },
      { value: "bar", label: "Bar" },
      { value: "underline", label: "Underline" },
    ],
  }),
  terminalCursorBlink: boolean({
    section: "terminal",
    group: "Cursor",
    label: "Blinking cursor",
    keywords: ["caret", "blink", "flash"],
    scope: "synced",
    default: true,
  }),
  terminalTheme: choice({
    section: "terminal",
    group: "Colors",
    label: "Color scheme",
    description: "App colors follow your palette and light or dark theme.",
    keywords: ["theme", "colors", "palette", "ansi", ...TERMINAL_SCHEMES.map((t) => t.label.toLowerCase())],
    scope: "synced",
    default: "app",
    control: "select",
    options: [{ value: "app", label: "App colors" }, ...TERMINAL_SCHEMES.map((t) => ({ value: t.id, label: t.label }))],
  }),
  terminalCopyOnSelect: boolean({
    section: "terminal",
    group: "Mouse and keys",
    label: "Copy on select",
    description: "Selected text goes to the clipboard right away.",
    keywords: ["clipboard", "selection", "mouse"],
    scope: "device",
    default: false,
  }),
  terminalRightClickPaste: boolean({
    section: "terminal",
    group: "Mouse and keys",
    label: "Right-click pastes",
    description: "Copies the selection if there is one. Long-press still opens the menu.",
    keywords: ["clipboard", "context menu", "mouse", "paste"],
    scope: "device",
    default: false,
  }),
  terminalOptionMeta: boolean({
    section: "terminal",
    group: "Mouse and keys",
    label: "Option as Meta on a Mac",
    description: "Option works as Alt, for word jumps in the shell. Off types characters like é.",
    keywords: ["alt", "meta", "macos", "option key"],
    scope: "device",
    default: true,
  }),
  terminalBell: choice({
    section: "terminal",
    group: "Mouse and keys",
    label: "Bell",
    description: "When a program rings the terminal bell.",
    keywords: ["beep", "alert", "sound", "flash"],
    scope: "synced",
    default: "none",
    options: [
      { value: "none", label: "None" },
      { value: "visual", label: "Flash" },
      { value: "sound", label: "Sound" },
    ],
  }),
  terminalScrollback: number({
    section: "terminal",
    group: "Performance",
    label: "Scrollback",
    description: "Lines kept above the screen in each terminal.",
    keywords: ["history", "buffer", "lines", "memory"],
    scope: "device",
    default: 10000,
    min: 1000,
    max: 100000,
    step: 1000,
    control: "slider",
  }),
  terminalWebgl: boolean({
    section: "terminal",
    group: "Performance",
    label: "GPU rendering",
    description: "Turn off if terminal text looks garbled or blank on this device.",
    keywords: ["webgl", "renderer", "graphics", "gpu", "blurry"],
    scope: "device",
    default: true,
  }),

  /* keyboard */
  keybindings: text({
    section: "keyboard",
    label: "Keyboard shortcuts",
    description: "Shortcuts you changed on this device.",
    keywords: ["keys", "hotkeys", "bindings"],
    scope: "device",
    default: "{}",
    maxLength: 8000,
    hidden: true,
    normalize: normalizeBindingsText,
    summary: (v) => {
      const n = Object.keys(parseBindings(v)).length;
      return n ? `${n} changed` : "Defaults";
    },
    storage: { key: "cui:keys", parse: (raw) => raw, format: (v) => v },
  }),

  /* conversation */
  timeFormat: choice({
    section: "conversation",
    label: "Time format",
    description: "For message times, dividers, usage and snoozes. System follows this device's language.",
    keywords: ["clock", "12-hour", "24-hour", "am", "pm", "timestamps"],
    scope: "synced",
    default: "system",
    options: [
      { value: "system", label: "System" },
      { value: "12h", label: "12-hour" },
      { value: "24h", label: "24-hour" },
    ],
  }),
  workLog: choice({
    section: "conversation",
    group: "Work log",
    label: "Finished turns",
    description: "Folded puts a finished turn's tool calls and notes behind one row.",
    keywords: ["fold", "collapse", "expand", "worked for", "steps"],
    scope: "synced",
    default: "folded",
    options: [
      { value: "folded", label: "Folded" },
      { value: "expanded", label: "Expanded" },
    ],
  }),
  toolCalls: choice({
    section: "conversation",
    group: "Work log",
    label: "Tool calls",
    description: "How finished tool runs open: a summary line, the list of calls, or every call's details.",
    keywords: ["tools", "commands", "details", "expand", "collapse"],
    scope: "synced",
    default: "collapsed",
    options: [
      { value: "collapsed", label: "Summary" },
      { value: "list", label: "List" },
      { value: "details", label: "Details" },
    ],
  }),
  showThinking: boolean({
    section: "conversation",
    group: "Work log",
    label: "Show thinking",
    description: "The agent's reasoning between tool calls.",
    keywords: ["reasoning", "thoughts"],
    scope: "synced",
    default: true,
  }),
  turnChanges: boolean({
    section: "conversation",
    group: "After each turn",
    label: "Changed files card",
    description: "Files a turn edited, with the lines added and removed.",
    keywords: ["diff", "edits", "files changed"],
    scope: "synced",
    default: true,
  }),
  turnUndo: boolean({
    section: "conversation",
    group: "After each turn",
    label: "Undo button",
    description: "Puts the files back to how they were before the last turn.",
    keywords: ["rewind", "revert", "checkpoint"],
    scope: "synced",
    default: true,
    showIf: ["turnChanges", true],
  }),
  promptTimeline: boolean({
    section: "conversation",
    group: "Navigation",
    label: "Prompt timeline",
    description: "A strip along the right edge with a mark for each of your prompts. Click one to jump there.",
    keywords: ["minimap", "scrollbar", "jump", "prompts", "outline", "overview"],
    scope: "device",
    default: false,
  }),
  autoScroll: choice({
    section: "conversation",
    group: "Streaming",
    label: "Auto-scroll",
    description: "Follow pauses while you read above and picks up again at the bottom. Stop waits for Jump to latest.",
    keywords: ["scroll", "follow", "pin", "bottom", "jump"],
    scope: "synced",
    default: "follow",
    control: "select",
    options: [
      { value: "follow", label: "Follow" },
      { value: "stop", label: "Stop when I scroll up" },
      { value: "never", label: "Never" },
    ],
  }),
  streamText: choice({
    section: "conversation",
    group: "Streaming",
    label: "Replies",
    description: "Live shows text as it's written.",
    keywords: ["streaming", "typing", "live text", "complete"],
    scope: "synced",
    default: "live",
    options: [
      { value: "live", label: "Live" },
      { value: "complete", label: "When complete" },
    ],
  }),
  codeLineNumbers: boolean({
    section: "conversation",
    group: "Code blocks",
    label: "Line numbers",
    keywords: ["gutter", "code"],
    scope: "synced",
    default: true,
  }),
  codeWrap: boolean({
    section: "conversation",
    group: "Code blocks",
    label: "Wrap long lines",
    description: "Off scrolls long lines sideways.",
    keywords: ["soft wrap", "overflow", "code"],
    scope: "device",
    default: false,
  }),
  codeCollapse: choice({
    section: "conversation",
    group: "Code blocks",
    label: "Collapse long blocks",
    description: "Longer blocks show their first lines and a Show all button.",
    keywords: ["fold", "long code", "lines", "code"],
    scope: "synced",
    default: "40",
    options: [
      { value: "off", label: "Never" },
      { value: "20", label: "20 lines" },
      { value: "40", label: "40 lines" },
      { value: "100", label: "100 lines" },
    ],
  }),

  /* notifications: what notifies is synced (push reaches every device and follows it), how this device alerts isn't */
  notifyDnd: boolean({
    section: "notifications",
    label: "Do not disturb",
    description: "Pauses alerts, sounds and push on every device. Tab badges still count.",
    keywords: ["mute", "quiet", "silence", "pause", "focus"],
    scope: "synced",
    default: false,
  }),
  notifyDone: boolean({
    section: "notifications",
    group: "Notify me when",
    label: "A turn finishes",
    description: "The agent is done and waiting for your next message.",
    keywords: ["finished", "done", "complete", "alerts"],
    scope: "synced",
    default: true,
  }),
  notifyNeeds: boolean({
    section: "notifications",
    group: "Notify me when",
    label: "An agent needs approval",
    description: "It wants to run something or has a question for you.",
    keywords: ["permission", "question", "ask", "alerts"],
    scope: "synced",
    default: true,
  }),
  notifyFailed: boolean({
    section: "notifications",
    group: "Notify me when",
    label: "A turn fails",
    keywords: ["error", "failure", "alerts"],
    scope: "synced",
    default: true,
  }),
  notifyToasts: boolean({
    section: "notifications",
    group: "On this device",
    label: "In-app alerts",
    description: "A small card with a link to the session.",
    keywords: ["toast", "popup", "banner"],
    scope: "device",
    default: true,
  }),
  notifySound: boolean({
    section: "notifications",
    group: "On this device",
    label: "Sounds",
    description: "A short tone for each kind of event.",
    keywords: ["audio", "chime", "beep", "ding"],
    scope: "device",
    default: false,
  }),
  notifyVolume: number({
    section: "notifications",
    group: "On this device",
    label: "Volume",
    keywords: ["sound", "loud", "quiet"],
    scope: "device",
    default: 60,
    min: 5,
    max: 100,
    step: 5,
    unit: "%",
    control: "slider",
    showIf: ["notifySound", true],
  }),
  notifyWhen: choice({
    section: "notifications",
    group: "On this device",
    label: "Alert me",
    description: "Alerts and sounds. The session on screen never alerts.",
    keywords: ["hidden", "background", "away", "focus"],
    scope: "device",
    default: "always",
    options: [
      { value: "always", label: "Always" },
      { value: "away", label: "Only when away" },
    ],
  }),
  notifyBadge: choice({
    section: "notifications",
    group: "On this device",
    label: "Tab badge",
    description: "Marks the tab icon and title while sessions need you.",
    keywords: ["favicon", "title", "count", "unread", "dot"],
    scope: "device",
    default: "count",
    options: [
      { value: "off", label: "Off" },
      { value: "dot", label: "Dot" },
      { value: "count", label: "Count" },
    ],
  }),

  /* git */
  newSessionWorktree: boolean({
    section: "git",
    group: "Sessions",
    label: "New sessions in a worktree",
    description: "Start each new session on its own branch and folder, so parallel sessions don't share files.",
    keywords: ["branch", "isolate", "parallel"],
    scope: "device",
    default: false,
    /* the new session screen keeps its own toggle under this key */
    storage: { key: "cui:worktree", ...bit },
  }),
  /* the diff viewer's toggles write these too; they keep the keys and formats it used before */
  diffLayout: choice({
    section: "git",
    group: "Diffs",
    label: "Layout",
    description: "Split shows old and new side by side on wide screens.",
    keywords: ["side by side", "unified", "split", "diff"],
    scope: "device",
    default: "unified",
    options: [
      { value: "unified", label: "Unified" },
      { value: "split", label: "Split" },
    ],
    storage: { key: "agent-u:diff-layout", parse: (raw) => (raw === "split" ? "split" : "unified"), format: (v) => v },
  }),
  diffIgnoreWhitespace: boolean({
    section: "git",
    group: "Diffs",
    label: "Hide whitespace changes",
    keywords: ["ignore whitespace", "indentation", "spaces", "diff"],
    scope: "device",
    default: false,
    storage: { key: "agent-u:diff-whitespace", parse: (raw) => raw === "hide", format: (v) => (v ? "hide" : "show") },
  }),
  diffWrap: boolean({
    section: "git",
    group: "Diffs",
    label: "Wrap long lines",
    description: "Split columns always wrap.",
    keywords: ["soft wrap", "overflow", "diff"],
    scope: "device",
    default: false,
    touchDefault: true,
    storage: { key: "agent-u:diff-wrap", parse: (raw) => raw === "on", format: (v) => (v ? "on" : "off") },
  }),
  diffColors: choice({
    section: "git",
    group: "Diffs",
    label: "Colors",
    description: "Blue and orange are easier to tell apart with red-green color blindness.",
    keywords: ["color blind", "colorblind", "deuteranopia", "protanopia", "accessibility", "added", "removed", "diff"],
    scope: "synced",
    default: "red-green",
    options: [
      { value: "red-green", label: "Red and green" },
      { value: "blue-orange", label: "Blue and orange" },
    ],
    dom: { attr: "data-diff-colors" },
  }),
  gitFetchInterval: choice({
    section: "git",
    group: "Remote",
    label: "Check the remote",
    description: "Fetches in the background while a session's Git panel is open, so new commits show up.",
    keywords: ["fetch", "background", "poll", "upstream", "behind"],
    scope: "synced",
    default: "server",
    options: [
      { value: "server", label: "Server default" },
      { value: "off", label: "Off" },
      { value: "1", label: "Every minute" },
      { value: "5", label: "Every 5 minutes" },
      { value: "15", label: "Every 15 minutes" },
    ],
    control: "select",
  }),
  confirmDefaultPush: boolean({
    section: "git",
    group: "Remote",
    label: "Confirm pushes to the default branch",
    description: "Asks before pushing straight to main or master.",
    keywords: ["main", "master", "protect", "push"],
    scope: "synced",
    default: true,
  }),
  commitMessageAgent: choice({
    section: "git",
    group: "Commit messages",
    label: "Generated by",
    description: "Auto tries Claude, then Codex, then Gemini. Off hides Generate.",
    keywords: ["commit message", "generate", "ai", "claude", "codex", "gemini"],
    scope: "synced",
    default: "auto",
    control: "select",
    options: [
      { value: "auto", label: "Auto" },
      { value: "claude", label: "Claude" },
      { value: "codex", label: "Codex" },
      { value: "gemini", label: "Gemini" },
      { value: "off", label: "Off" },
    ],
  }),
  commitMessageStyle: choice({
    section: "git",
    group: "Commit messages",
    label: "Style",
    keywords: ["conventional commits", "feat", "fix", "commit message", "format"],
    scope: "synced",
    default: "repo",
    control: "select",
    options: [
      { value: "repo", label: "Match the repository" },
      { value: "conventional", label: "Conventional commits" },
      { value: "plain", label: "Plain sentence" },
    ],
  }),

  /* sidebar: size */
  sidebarWidth: number({
    section: "sidebar",
    group: "Size",
    label: "Sidebar width",
    description: "On desktop, drag the sidebar's edge to change it. Double-click the edge to reset.",
    keywords: ["resize", "wide", "narrow", "drag", "panel"],
    scope: "device",
    default: SIDEBAR_DEFAULT,
    min: SIDEBAR_MIN,
    max: SIDEBAR_MAX,
    step: 1,
    unit: "px",
    control: "slider",
    dom: { cssVar: "--sidebar-w", unit: "px" },
  }),

  /* workflow */
  autoOpenDiff: boolean({
    section: "git",
    group: "Diffs",
    label: "Open changes after a turn",
    description: "When a turn sent from here edits files, the Changes panel opens on its own.",
    keywords: ["diff", "panel", "auto open", "proactive", "review", "files changed", "last turn"],
    scope: "synced",
    default: false,
  }),
  diffFileState: choice({
    section: "git",
    group: "Diffs",
    label: "Files in a diff",
    description: "How each file starts out. Large files are over 400 lines.",
    keywords: ["collapse", "expand", "fold", "large files", "diff"],
    scope: "device",
    default: "large",
    control: "select",
    options: [
      { value: "large", label: "Collapse large files" },
      { value: "expanded", label: "Expanded" },
      { value: "collapsed", label: "Collapsed" },
    ],
  }),
  limitAction: choice({
    section: "agents",
    group: "Usage limits",
    label: "When a turn hits a usage limit",
    description: "Waiting needs the agent to say when the limit resets; when it doesn't, the fallback profile takes over. Fallbacks are set per profile.",
    keywords: ["rate limit", "quota", "fallback", "resume", "retry", "wait", "resets", "429"],
    scope: "synced",
    default: "fallback",
    control: "select",
    options: [
      { value: "fallback", label: "Switch to the fallback profile" },
      { value: "wait", label: "Wait and resend when the limit resets" },
      { value: "stop", label: "Stop" },
    ],
  }),
  favoriteModels: text({
    section: "agents",
    group: "Models",
    label: "Favorite models",
    description: "Listed first in the model picker. Star them there, or type model ids here, separated by commas.",
    keywords: ["star", "pin", "model picker", "favourite", "models"],
    scope: "synced",
    default: "",
    maxLength: 4000,
    placeholder: "gpt-5.5, opus",
  }),
  hiddenModels: text({
    section: "agents",
    group: "Models",
    label: "Hidden models",
    description: "Left out of the model picker unless you filter for them or show hidden ones.",
    keywords: ["hide", "model picker", "declutter", "models"],
    scope: "synced",
    default: "",
    maxLength: 4000,
    placeholder: "haiku",
  }),
  editorLink: choice({
    section: "general",
    group: "Open in editor",
    label: "Open files in",
    description: "Adds Open in links to the session menu and file paths. Your editor connects to this server over SSH.",
    keywords: ["vs code", "vscode", "cursor", "zed", "ssh", "remote", "ide", "editor"],
    scope: "synced",
    default: "none",
    control: "select",
    options: [
      { value: "none", label: "Nowhere" },
      { value: "vscode", label: "VS Code" },
      { value: "cursor", label: "Cursor" },
      { value: "zed", label: "Zed" },
    ],
  }),
  editorHost: text({
    section: "general",
    group: "Open in editor",
    label: "SSH host",
    description: "How your computer reaches this server: a Host from ~/.ssh/config, or user@host.",
    keywords: ["ssh", "remote", "hostname", "server", "editor"],
    scope: "synced",
    default: "",
    maxLength: 255,
    placeholder: "my-server",
    pattern: SSH_HOST,
    showIf: ["editorLink", ["vscode", "cursor", "zed"]],
  }),

  /* storage */
  worktreeCleanupDays: choice({
    section: "storage",
    group: "Cleanup",
    label: "Remove worktrees",
    description: "Once idle that long, or as soon as their branch is merged. Never ones with uncommitted changes or a running session. Unmerged branches stay.",
    keywords: ["worktree", "delete", "prune", "idle", "merged", "disk"],
    scope: "synced",
    default: "off",
    control: "select",
    options: [
      { value: "off", label: "Never" },
      { value: "7", label: "After 7 days" },
      { value: "14", label: "After 14 days" },
      { value: "30", label: "After 30 days" },
    ],
  }),
  attachmentCleanupDays: choice({
    section: "storage",
    group: "Cleanup",
    label: "Remove attachments",
    description: "Files uploaded with messages. Older messages show them as missing once they're gone.",
    keywords: ["attachments", "uploads", "images", "delete", "prune", "disk"],
    scope: "synced",
    default: "14",
    control: "select",
    options: [
      { value: "off", label: "Never" },
      { value: "14", label: "After 14 days" },
      { value: "30", label: "After 30 days" },
      { value: "90", label: "After 90 days" },
    ],
  }),

  /* touch */
  composerCollapseOnScroll: boolean({
    section: "composer",
    group: "Typing",
    label: "Shrink while reading back",
    description: "On phones, the message box folds to one line while you scroll up. Tap it to write.",
    keywords: ["collapse", "hide", "scroll", "phone", "mobile", "reading room", "pill"],
    scope: "device",
    default: false,
    touchDefault: true,
  }),
  touchGestures: boolean({
    section: "general",
    group: "Touch",
    label: "Swipe gestures",
    description: "Swipe from the left edge for sessions, swipe a session left to archive or right to pin, and swipe the title to switch tabs.",
    keywords: ["swipe", "gesture", "touch", "phone", "mobile", "drawer", "archive", "pin", "tabs"],
    scope: "device",
    default: true,
  }),
} as const satisfies Record<string, SettingDef>;

type ValueOf<D> = D extends BooleanSetting ? boolean : D extends NumberSetting ? number : D extends EnumSetting<infer T> ? T : string;

export type SettingKey = keyof typeof SETTINGS;
export type Settings = { -readonly [K in SettingKey]: ValueOf<(typeof SETTINGS)[K]> };
export type SettingWithKey = SettingDef & { key: SettingKey };

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];
export const DEFAULTS = Object.fromEntries(SETTING_KEYS.map((k) => [k, SETTINGS[k].default])) as Settings;

export const settingDef = (key: SettingKey): SettingWithKey => ({ ...(SETTINGS[key] as SettingDef), key });
export const isSettingKey = (key: string): key is SettingKey => Object.prototype.hasOwnProperty.call(SETTINGS, key);

/** The settings a section lists, in registry order: its own, then ones that also show there. */
export function settingsIn(section: SectionId): SettingWithKey[] {
  return SETTING_KEYS.map(settingDef).filter((d) => d.section === section || d.alsoIn?.includes(section));
}

export const sectionInfo = (id: SectionId) => SECTIONS.find((s) => s.id === id)!;

/** False while the setting's `showIf` doesn't hold. */
export function isShown(def: SettingDef, values: Settings): boolean {
  if (!def.showIf) return true;
  const [key, want] = def.showIf;
  const v = values[key as SettingKey];
  return Array.isArray(want) ? want.includes(v) : v === want;
}

/** What this server does for settings left at "Server default" (GET /api/settings sends it as `defaults`). */
export type ServerDefaults = { gitFetchIntervalMs?: number };

/** The `defaults` a server sent, keeping only fields this build understands. */
export function parseServerDefaults(raw: unknown): ServerDefaults {
  const ms = raw && typeof raw === "object" ? (raw as Record<string, unknown>).gitFetchIntervalMs : undefined;
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? { gitFetchIntervalMs: ms } : {};
}

/** A setting's options as its control shows them. "Server default" names what the server does, and the option
 * that does the same folds into it unless it's the one picked. */
export function shownOptions<T extends string>(key: SettingKey, options: readonly EnumOption<T>[], value: T, defaults: ServerDefaults): EnumOption<T>[] {
  if (key !== "gitFetchInterval" || defaults.gitFetchIntervalMs === undefined) return [...options];
  const ms = defaults.gitFetchIntervalMs;
  return options
    .filter((o) => o.value === "server" || o.value === value || choiceMs(o.value) !== ms)
    .map((o) => (o.value === "server" ? { ...o, label: `${fetchIntervalLabel(ms)} (default)` } : o));
}

/** The setting that holds an agent's default reasoning effort, for agents that have levels. */
export const EFFORT_SETTING: Partial<Record<AgentId, "effortClaude" | "effortCodex">> = { claude: "effortClaude", codex: "effortCodex" };

/** Settings files from older versions: renamed or replaced keys, read as their new form. Current keys win. */
export function migrateLegacy(obj: Record<string, unknown>): Record<string, unknown> {
  const out = { ...obj };
  if ("sendWithEnter" in out) {
    if (typeof out.sendWithEnter === "boolean" && !("sendShortcut" in out)) out.sendShortcut = out.sendWithEnter ? "enter" : "mod-enter";
    delete out.sendWithEnter;
  }
  return out;
}

export type SearchHit = { section: SectionId; settings: SettingKey[]; items: string[] };

/** Settings and section rows whose label, description or keywords contain every word of the query.
 * Each setting comes up once, under its own section. */
export function searchSettings(query: string): SearchHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hit = (...texts: (string | readonly string[] | undefined)[]) => {
    const hay = texts.flat().filter(Boolean).join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  };
  return SECTIONS.flatMap((s) => {
    const settings = SETTING_KEYS.filter((k) => {
      const d = SETTINGS[k] as SettingDef;
      return d.section === s.id && !d.hidden && hit(d.label, d.description, d.keywords, d.group, s.label);
    });
    const items = (s.items ?? []).filter((i) => hit(i.label, i.description, i.keywords, s.label)).map((i) => i.id);
    return settings.length || items.length ? [{ section: s.id, settings, items }] : [];
  });
}

/** localStorage key of a device setting */
export const storageKey = (key: SettingKey) => (SETTINGS[key] as SettingDef).storage?.key ?? `${DEVICE_PREFIX}${key}`;
export const DEVICE_PREFIX = "cui:set:";
/** localStorage copy of the synced settings, for first paint before the server answers */
export const SYNCED_CACHE_KEY = "cui:synced";

/* ── values ───────────────────────────────────────────────── */

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const roundTo = (v: number, step: number, min: number) => {
  const n = Math.round((v - min) / step) * step + min;
  const digits = (String(step).split(".")[1] ?? "").length;
  return Number(n.toFixed(digits));
};

/** Checks a value against its setting: numbers are clamped and snapped to the step, strings cut to length. */
export function parseValue(def: SettingDef, value: unknown): Parsed<unknown> {
  switch (def.type) {
    case "boolean":
      return typeof value === "boolean" ? { ok: true, value } : { ok: false, error: "must be true or false" };
    case "enum":
      return typeof value === "string" && def.options.some((o) => o.value === value) ? { ok: true, value } : { ok: false, error: `must be one of ${def.options.map((o) => o.value).join(", ")}` };
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, error: "must be a number" };
      return { ok: true, value: roundTo(Math.min(def.max, Math.max(def.min, value)), def.step, def.min) };
    case "string": {
      if (typeof value !== "string") return { ok: false, error: "must be text" };
      if (def.normalize) {
        const n = def.normalize(value);
        return n !== null && n.length <= def.maxLength ? { ok: true, value: n } : { ok: false, error: "isn't in the expected format" };
      }
      const v = value.slice(0, def.maxLength);
      if (def.pattern && !def.pattern.test(v)) return { ok: false, error: "isn't in the expected format" };
      const problem = def.check?.(v);
      return problem ? { ok: false, error: problem } : { ok: true, value: v };
    }
    case "color": {
      if (typeof value !== "string") return { ok: false, error: "must be a color" };
      const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
      if (!m) return { ok: false, error: "must be a hex color like #3b82f6" };
      const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
      return { ok: true, value: `#${hex.toLowerCase()}` };
    }
  }
}

export type PatchResult = { ok: true; values: Partial<Settings>; reset: SettingKey[] } | { ok: false; errors: string[]; rejected: string[] };

/**
 * Validates a partial update. Unknown keys and wrong values are errors; `null` resets a key when `allowNull`.
 * With `scope`, settings kept elsewhere are refused (the server only stores synced ones).
 */
export function validatePatch(patch: unknown, opts: { scope?: Scope; allowNull?: boolean } = {}): PatchResult {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return { ok: false, errors: ["Expected an object of settings."], rejected: [] };
  const values: Record<string, unknown> = {};
  const reset: SettingKey[] = [];
  const errors: string[] = [];
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!isSettingKey(key)) {
      errors.push(`Unknown setting "${key}".`);
      rejected.push(key);
      continue;
    }
    const def = SETTINGS[key] as SettingDef;
    if (opts.scope && def.scope !== opts.scope) {
      errors.push(`"${key}" is kept on each device, not on the server.`);
      rejected.push(key);
      continue;
    }
    if (value === null && opts.allowNull) {
      reset.push(key);
      continue;
    }
    const parsed = parseValue(def, value);
    if (parsed.ok) values[key] = parsed.value;
    else {
      errors.push(`"${key}" ${parsed.error}.`);
      rejected.push(key);
    }
  }
  return errors.length ? { ok: false, errors, rejected } : { ok: true, values: values as Partial<Settings>, reset };
}

/** Keeps the valid entries of a stored or imported object and names the rest. */
export function pickValid(obj: unknown, scope?: Scope): { values: Partial<Settings>; skipped: string[] } {
  const values: Record<string, unknown> = {};
  const skipped: string[] = [];
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { values: {}, skipped };
  for (const [key, value] of Object.entries(obj)) {
    const def = isSettingKey(key) ? (SETTINGS[key] as SettingDef) : null;
    const parsed = def && (!scope || def.scope === scope) ? parseValue(def, value) : null;
    if (parsed?.ok) values[key] = parsed.value;
    else skipped.push(key);
  }
  return { values: values as Partial<Settings>, skipped };
}

/** Reads a device setting's stored text (older formats included); anything unreadable is the default. */
export function decodeStored<K extends SettingKey>(key: K, raw: string | null): Settings[K] {
  if (raw === null) return DEFAULTS[key];
  const def = SETTINGS[key] as SettingDef;
  let value: unknown;
  if (def.storage) value = (def.storage as { parse(raw: string): unknown }).parse(raw);
  else {
    try {
      value = JSON.parse(raw);
    } catch {
      return DEFAULTS[key];
    }
  }
  const parsed = parseValue(def, value);
  return (parsed.ok ? parsed.value : DEFAULTS[key]) as Settings[K];
}

export function encodeStored<K extends SettingKey>(key: K, value: Settings[K]): string {
  const def = SETTINGS[key] as SettingDef;
  return def.storage ? (def.storage as { format(v: unknown): string }).format(value) : JSON.stringify(value);
}

export function formatValue(def: SettingDef, value: unknown): string {
  if (def.type === "boolean") return value ? "On" : "Off";
  if (def.type === "enum") return def.options.find((o) => o.value === value)?.label ?? String(value);
  if (def.type === "number") return `${value}${def.unit ?? ""}`;
  if (def.type === "string" && def.summary) return def.summary(String(value));
  return String(value);
}

/* ── export and import ────────────────────────────────────── */

export const EXPORT_KIND = "agent-u/settings";

export function serializeSettings(values: Settings, now = new Date()): string {
  return `${JSON.stringify({ kind: EXPORT_KIND, version: 1, exportedAt: now.toISOString(), settings: values }, null, 2)}\n`;
}

export type ImportParse = { ok: true; values: Partial<Settings>; skipped: string[] } | { ok: false; error: string };

/** Reads an exported file (or a bare object of settings). Unknown or invalid entries are skipped and listed. */
export function parseSettingsFile(text: string): ImportParse {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "That file isn't JSON." };
  }
  const root = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  if (!root) return { ok: false, error: "That file has no settings in it." };
  const body = root.kind === EXPORT_KIND || ("settings" in root && typeof root.settings === "object") ? root.settings : root;
  const { values, skipped } = pickValid(body && typeof body === "object" && !Array.isArray(body) ? migrateLegacy(body as Record<string, unknown>) : body);
  if (!Object.keys(values).length) return { ok: false, error: "That file has no agent-u settings in it." };
  return { ok: true, values, skipped };
}

export type SettingChange = { key: SettingKey; label: string; from: string; to: string };

export function diffSettings(current: Settings, next: Partial<Settings>): SettingChange[] {
  const out: SettingChange[] = [];
  for (const key of SETTING_KEYS) {
    if (!(key in next) || next[key] === current[key]) continue;
    const def = SETTINGS[key] as SettingDef;
    out.push({ key, label: def.label, from: formatValue(def, current[key]), to: formatValue(def, next[key]) });
  }
  return out;
}

/* ── <html> attributes ───────────────────────────────────── */

export type DomState = { dark: boolean; attrs: Record<string, string>; vars: Record<string, string>; themeColor: string };

/** The palette in effect: the light-mode choice while the theme is light, else the main one. */
export const activePalette = (values: Settings, dark: boolean): string => (!dark && values.lightPalette !== "same" ? values.lightPalette : values.palette);

const swatch = (id: string, dark: boolean) => {
  const p = PALETTES.find((x) => x.id === id) ?? PALETTES[0];
  return dark ? p.dark : p.light;
};

/** What the settings put on <html>: the same rules the pre-paint script follows. */
export function domState(values: Settings, prefersDark: boolean): DomState {
  return paint(values, values.theme === "system" ? prefersDark : values.theme === "dark");
}

function paint(values: Settings, dark: boolean): DomState {
  const attrs: Record<string, string> = {};
  const vars: Record<string, string> = {};
  for (const key of SETTING_KEYS) {
    const def = SETTINGS[key] as SettingDef;
    const dom = def.dom;
    if (!dom) continue;
    const value = values[key];
    if (dom.when && values[dom.when[0] as SettingKey] !== dom.when[1]) continue;
    if (!dom.when && value === def.default) continue;
    if (dom.attr) attrs[dom.attr] = value === true ? "on" : String(value);
    if (dom.cssVar) vars[dom.cssVar] = `${typeof value === "number" && dom.factor ? Number((value * dom.factor).toFixed(4)) : value}${dom.unit ?? ""}`;
  }
  /* a custom theme starts from its base palette's stylesheet and overrides tokens inline; a named accent keeps its say */
  const chosen = activePalette(values, dark);
  let base = chosen;
  if (chosen === "custom") {
    const parsed = values.customTheme ? parseCustomTheme(values.customTheme, PALETTE_BASES) : null;
    base = parsed?.ok ? (parsed.theme.base ?? "default") : "default";
    if (parsed?.ok) {
      for (const [k, v] of Object.entries(themeVars(parsed.theme, dark, swatch(base, dark).page))) {
        if (values.accent === "auto" || !ACCENT_TOKENS.includes(k.slice(2) as (typeof ACCENT_TOKENS)[number])) vars[k] = v;
      }
    }
  }
  if (base === "default") delete attrs["data-palette"];
  else attrs["data-palette"] = base;
  const page = vars["--page"] ?? swatch(base, dark).page;
  if (values.accent === "custom") Object.assign(vars, accentVars(values.accentColor, page, dark));
  return { dark, attrs, vars, themeColor: page };
}

/** Every attribute or variable any setting may set, so stale ones can be cleared. */
export const DOM_ATTRS = SETTING_KEYS.flatMap((k) => ((SETTINGS[k] as SettingDef).dom?.attr ? [(SETTINGS[k] as SettingDef).dom!.attr!] : []));
export const DOM_VARS = [...SETTING_KEYS.flatMap((k) => ((SETTINGS[k] as SettingDef).dom?.cssVar ? [(SETTINGS[k] as SettingDef).dom!.cssVar!] : [])), ...THEME_VARS];

/** localStorage copy of what the theme settings work out to in each mode (palette attribute, chrome color, token
 * variables), so the pre-paint script can apply custom themes and accents without parsing them. */
export const THEME_CACHE_KEY = "cui:theme";
type CacheEntry = [palette: string, themeColor: string, vars: Record<string, string>];

export function themeCache(values: Settings): { l: CacheEntry; d: CacheEntry } {
  const entry = (dark: boolean): CacheEntry => {
    const s = paint(values, dark);
    const vars = Object.fromEntries(Object.entries(s.vars).filter(([k]) => (THEME_VARS as readonly string[]).includes(k)));
    return [s.attrs["data-palette"] ?? "", s.themeColor, vars];
  };
  return { l: entry(false), d: entry(true) };
}

/* The pre-paint script, as a self-contained function so it can be both serialized into the page and unit tested.
 * Everything it reads is validated against the registry rows passed in; anything odd falls back to the default. */
type ScriptRow = [key: string, storage: string | 0, plain: 0 | 1, def: unknown, check: unknown[] | [number, number], attr: string | 0, cssVar: string | 0, unit: string, factor: number, when: [string, string] | 0];

function prePaint(rows: ScriptRow[], pages: Record<string, [string, string]>, syncedKey: string, themeKey: string) {
  var d = document.documentElement;
  var get = function (k: string) {
    try {
      return localStorage.getItem(k);
    } catch (e) {
      return null;
    }
  };
  var synced: Record<string, unknown> = {};
  try {
    synced = JSON.parse(get(syncedKey) || "{}") || {};
  } catch (e) {}
  var v: Record<string, unknown> = {};
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var x: unknown;
    if (r[1]) {
      var raw = get(r[1]);
      if (raw !== null) {
        if (r[2]) x = raw;
        else
          try {
            x = JSON.parse(raw);
          } catch (e) {}
      }
    } else x = synced[r[0]];
    var c = r[4];
    var ok = typeof c[0] === "number" ? typeof x === "number" && x >= (c[0] as number) && x <= (c[1] as number) : (c as unknown[]).indexOf(x) >= 0;
    v[r[0]] = ok ? x : r[3];
  }
  var t = v.theme;
  var dark = t === "system" ? matchMedia("(prefers-color-scheme: dark)").matches : t !== "light";
  d.classList.toggle("dark", dark);
  for (i = 0; i < rows.length; i++) {
    r = rows[i];
    x = v[r[0]];
    var w = r[9];
    if (w ? v[w[0]] !== w[1] : x === r[3]) continue;
    if (r[5]) d.setAttribute(r[5], x === true ? "on" : String(x));
    if (r[6]) d.style.setProperty(r[6], (r[8] ? Math.round((x as number) * r[8] * 1e4) / 1e4 : x) + r[7]);
  }
  var p = pages[String(v.palette)] || pages["default"];
  var color = p[dark ? 1 : 0];
  try {
    var e = (JSON.parse(get(themeKey) || "{}") || {})[dark ? "d" : "l"];
    if (e) {
      if (pages[e[0]] && e[0] !== "default") d.setAttribute("data-palette", e[0]);
      else d.removeAttribute("data-palette");
      color = String(e[1]);
      for (var k in e[2]) if (/^--[a-z0-9-]+$/.test(k)) d.style.setProperty(k, String(e[2][k]));
    }
  } catch (e) {}
  var m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute("content", color);
}

/** The inline script for <head>: applies the stored theme and appearance before first paint. */
export function prePaintScript(): string {
  const rows: ScriptRow[] = SETTING_KEYS.flatMap((key) => {
    const def = SETTINGS[key] as SettingDef;
    if (!def.dom && key !== "theme") return [];
    const check = def.type === "enum" ? def.options.map((o) => o.value) : def.type === "number" ? [def.min, def.max] : def.type === "boolean" ? [true, false] : [];
    const dom = def.dom ?? {};
    const row: ScriptRow = [key, def.scope === "device" ? storageKey(key) : 0, def.storage?.plain ? 1 : 0, def.default, check, dom.attr ?? 0, dom.cssVar ?? 0, dom.unit ?? "", dom.factor ?? 0, dom.when ? [dom.when[0], dom.when[1]] : 0];
    return [row];
  });
  const pages = Object.fromEntries(PALETTES.map((p) => [p.id, [p.light.page, p.dark.page]]));
  return `try{(${prePaint.toString()})(${JSON.stringify(rows)},${JSON.stringify(pages)},${JSON.stringify(SYNCED_CACHE_KEY)},${JSON.stringify(THEME_CACHE_KEY)})}catch(e){}`;
}
