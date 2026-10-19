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

export type Scope = "device" | "synced";

export type SectionId = "general" | "appearance" | "composer" | "conversation" | "terminal" | "notifications" | "keyboard" | "agents" | "git" | "data" | "about";

export type SectionInfo = {
  id: SectionId;
  label: string;
  description: string;
  /** rows that aren't settings (buttons, lists) but should still come up in search */
  items?: { id: string; label: string; description?: string; keywords?: string[] }[];
};

export const SECTIONS: readonly SectionInfo[] = [
  { id: "general", label: "General", description: "Theme and your account on this server.", items: [
      { id: "sign-out", label: "Sign out", description: "Ends this browser's session.", keywords: ["log out", "logout", "account"] },
      { id: "sign-out-everywhere", label: "Sign out everywhere", description: "Ends the session on every device.", keywords: ["log out", "logout", "revoke", "devices", "account"] },
    ],
  },
  { id: "appearance", label: "Appearance", description: "Colors, fonts, sizes and spacing." },
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
  { id: "keyboard", label: "Keyboard", description: "Shortcuts on devices with a keyboard.", items: [{ id: "shortcuts", label: "Keyboard shortcuts", keywords: ["keys", "hotkeys", "bindings"] }] },
  { id: "agents", label: "Agents", description: "Agent CLIs, accounts and running terminals.", items: [{ id: "profiles", label: "Profiles and terminals", description: "Accounts, proxies, models and running agents.", keywords: ["claude", "codex", "models", "accounts", "proxy"] }] },
  { id: "git", label: "Git", description: "Checkpoints, worktrees and commits." },
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
  /** device settings only: the localStorage key (default `cui:set:<key>`) and how its stored text reads.
   * Older keys keep their own format so earlier choices survive. */
  storage?: { key: string; parse(raw: string): T | undefined; format(value: T): string; plain?: boolean };
  dom?: Dom;
  /** listed only while another setting has this value */
  showIf?: readonly [key: string, value: unknown];
};

export type BooleanSetting = Common<boolean> & { type: "boolean" };
export type EnumOption<T extends string = string> = { value: T; label: string; hint?: string };
export type EnumSetting<T extends string = string> = Common<T> & { type: "enum"; options: readonly EnumOption<T>[]; control?: "segmented" | "select" | "swatches" | "palette" };
export type NumberSetting = Common<number> & { type: "number"; min: number; max: number; step: number; unit?: string; control?: "slider" | "segmented" | "hue" };
export type StringSetting = Common<string> & { type: "string"; maxLength: number; placeholder?: string; pattern?: RegExp };
export type ColorSetting = Common<string> & { type: "color" };
export type SettingDef = BooleanSetting | EnumSetting | NumberSetting | StringSetting | ColorSetting;

const boolean = (d: Omit<BooleanSetting, "type">): BooleanSetting => ({ type: "boolean", ...d });
const choice = <const T extends string>(d: Omit<EnumSetting<T>, "type">): EnumSetting<T> => ({ type: "enum", ...d });
const number = (d: Omit<NumberSetting, "type">): NumberSetting => ({ type: "number", ...d });

/* ── palettes ─────────────────────────────────────────────── */

/** Swatch colors for the palette picker and the browser chrome color (`page`). The full token sets live in
 * app/globals.css under [data-palette=...]; tests/palettes.test.ts checks that `page` matches them. */
export type PaletteColors = { page: string; sidebar: string; surface: string; line: string; ink: string; ink3: string; accent: string };
export type Palette = { id: string; label: string; light: PaletteColors; dark: PaletteColors };

export const PALETTES = [
  {
    id: "default",
    label: "Default",
    light: { page: "#fcfcfd", sidebar: "#f6f7f9", surface: "#ffffff", line: "#e6e8eb", ink: "#26282d", ink3: "#6e7178", accent: "#2f74e0" },
    dark: { page: "#151619", sidebar: "#111214", surface: "#1d1e21", line: "#2b2c30", ink: "#f2f3f5", ink3: "#8f9196", accent: "#5fa0f7" },
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
    keywords: ["colors", "color theme", "nord", "solarized", "catppuccin", "rose pine", "github", "midnight", "graphite"],
    scope: "synced",
    default: "default",
    control: "palette",
    options: PALETTES.map((p) => ({ value: p.id, label: p.label })),
    dom: { attr: "data-palette" },
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
  accentHue: number({
    section: "appearance",
    group: "Theme",
    label: "Custom hue",
    scope: "synced",
    default: 256,
    min: 0,
    max: 360,
    step: 1,
    unit: "°",
    control: "hue",
    showIf: ["accent", "custom"],
    dom: { cssVar: "--ah", when: ["accent", "custom"] },
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

  /* composer */
  sendWithEnter: boolean({
    section: "composer",
    label: "Send with Enter",
    description: "On: Shift+Enter adds a new line. Off: Enter adds a new line and Ctrl+Enter sends.",
    keywords: ["submit", "newline", "return key"],
    scope: "device",
    default: false,
    storage: { key: "cui:send-enter", ...bit },
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
    label: "New sessions in a worktree",
    description: "Start each new session on its own branch and folder, so parallel sessions don't share files.",
    keywords: ["branch", "isolate", "parallel"],
    scope: "device",
    default: false,
    /* the new session screen keeps its own toggle under this key */
    storage: { key: "cui:worktree", ...bit },
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
      return d.section === s.id && hit(d.label, d.description, d.keywords, d.group, s.label);
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
      const v = value.slice(0, def.maxLength);
      return def.pattern && !def.pattern.test(v) ? { ok: false, error: "isn't in the expected format" } : { ok: true, value: v };
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
  const { values, skipped } = pickValid(body);
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

/** What the settings put on <html>: the same rules the pre-paint script follows. */
export function domState(values: Settings, prefersDark: boolean): DomState {
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
  const dark = values.theme === "system" ? prefersDark : values.theme === "dark";
  const palette = PALETTES.find((p) => p.id === values.palette) ?? PALETTES[0];
  return { dark, attrs, vars, themeColor: (dark ? palette.dark : palette.light).page };
}

/** Every attribute or variable any setting may set, so stale ones can be cleared. */
export const DOM_ATTRS = SETTING_KEYS.flatMap((k) => ((SETTINGS[k] as SettingDef).dom?.attr ? [(SETTINGS[k] as SettingDef).dom!.attr!] : []));
export const DOM_VARS = SETTING_KEYS.flatMap((k) => ((SETTINGS[k] as SettingDef).dom?.cssVar ? [(SETTINGS[k] as SettingDef).dom!.cssVar!] : []));

/* The pre-paint script, as a self-contained function so it can be both serialized into the page and unit tested.
 * Everything it reads is validated against the registry rows passed in; anything odd falls back to the default. */
type ScriptRow = [key: string, storage: string | 0, plain: 0 | 1, def: unknown, check: unknown[] | [number, number], attr: string | 0, cssVar: string | 0, unit: string, factor: number, when: [string, string] | 0];

function prePaint(rows: ScriptRow[], pages: Record<string, [string, string]>, syncedKey: string) {
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
  var m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute("content", p[dark ? 1 : 0]);
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
  return `try{(${prePaint.toString()})(${JSON.stringify(rows)},${JSON.stringify(pages)},${JSON.stringify(SYNCED_CACHE_KEY)})}catch(e){}`;
}
