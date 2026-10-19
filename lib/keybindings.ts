/* Keyboard commands and their shortcuts, shared by the browser and the server (no React, no DOM).
 *
 * A chord is a string like "Mod+Shift+K": modifiers then one key, joined by "+". "Mod" is Cmd on a Mac and Ctrl
 * elsewhere; "Ctrl" is Ctrl everywhere; "Meta" is Cmd on a Mac and the Windows or Super key elsewhere. Keys are a
 * letter or digit, a symbol ("`", ",", "?"), or a key name ("Enter", "Escape", "ArrowUp", "Tab", "F5").
 *
 * The handlers live with each feature and ask `matchesCommand(event, id, ...)`; what counts as focus in the terminal
 * or a text field stays with the handler, the same as before the shortcuts became rebindable. */

export type CommandGroup = "General" | "Sessions" | "Panels" | "Terminal" | "Composer";

/** Where a command listens, for conflicts: a terminal or composer command only clashes with global ones and its own kind. */
export type CommandScope = "global" | "terminal" | "composer";

export type Command = {
  id: string;
  label: string;
  group: CommandGroup;
  keys: readonly string[];
  scope?: CommandScope;
  /** shown in the list but not rebindable (its keys depend on another setting or on the text field) */
  fixed?: string;
  keywords?: readonly string[];
};

const tab = (n: number): Command => ({ id: `tab${n}`, label: `Go to tab ${n}`, group: "Sessions", keys: [`Alt+${n}`], keywords: ["switch"] });

export const COMMANDS = [
  { id: "palette", label: "Search sessions and actions", group: "General", keys: ["Mod+K"], keywords: ["command palette", "quick open"] },
  { id: "shortcuts", label: "Keyboard shortcuts", group: "General", keys: ["?"], keywords: ["help", "keys"] },
  { id: "settings", label: "Open settings", group: "General", keys: ["Mod+,"], keywords: ["preferences"] },
  { id: "sidebar", label: "Toggle sidebar", group: "General", keys: ["Mod+B", "Ctrl+Shift+S"], keywords: ["collapse", "drawer"] },
  { id: "newSession", label: "New session", group: "Sessions", keys: ["Alt+T"], keywords: ["new tab", "start"] },
  { id: "closeTab", label: "Close tab", group: "Sessions", keys: ["Alt+W"] },
  { id: "reopenTab", label: "Reopen closed tab", group: "Sessions", keys: ["Alt+Shift+T"], keywords: ["undo close"] },
  { id: "nextTab", label: "Next tab", group: "Sessions", keys: ["Ctrl+Tab", "Alt+ArrowRight"], keywords: ["switch"] },
  { id: "prevTab", label: "Previous tab", group: "Sessions", keys: ["Ctrl+Shift+Tab", "Alt+ArrowLeft"], keywords: ["switch"] },
  ...[1, 2, 3, 4, 5, 6, 7, 8].map(tab),
  { id: "lastTab", label: "Go to last tab", group: "Sessions", keys: ["Alt+9"], keywords: ["switch"] },
  { id: "find", label: "Find in session", group: "Sessions", keys: ["Mod+F"], keywords: ["search"] },
  { id: "sidePanel", label: "Toggle side panel", group: "Panels", keys: ["Mod+Alt+B"], keywords: ["changes", "usage", "git"] },
  { id: "terminal", label: "Toggle terminal", group: "Terminal", keys: ["Mod+J", "Ctrl+`"], keywords: ["shell", "show", "hide"] },
  { id: "newTerminal", label: "New terminal tab", group: "Terminal", keys: ["Ctrl+Shift+`"], keywords: ["shell"] },
  { id: "terminalFind", label: "Find in terminal", group: "Terminal", keys: ["Mod+Shift+F"], scope: "terminal", keywords: ["search"] },
  { id: "closeTerminal", label: "Close terminal", group: "Terminal", keys: ["Ctrl+Shift+X"], keywords: ["shell"] },
  { id: "send", label: "Send message", group: "Composer", keys: ["Mod+Enter"], scope: "composer", fixed: "Change it under Composer > Send with." },
  { id: "recall", label: "Edit last message", group: "Composer", keys: ["ArrowUp"], scope: "composer", fixed: "In an empty composer." },
  { id: "stash", label: "Stash the draft", group: "Composer", keys: ["Mod+S"], scope: "composer", keywords: ["save", "later"] },
  { id: "stop", label: "Stop the turn", group: "Composer", keys: ["Escape"], scope: "composer", keywords: ["interrupt", "cancel"] },
] as const satisfies readonly Command[];

export type CommandId = (typeof COMMANDS)[number]["id"];

export const COMMAND_GROUPS: readonly CommandGroup[] = ["General", "Sessions", "Panels", "Terminal", "Composer"];

const BY_ID = new Map<string, Command>(COMMANDS.map((c) => [c.id, c]));
export const commandById = (id: string): Command | undefined => BY_ID.get(id);
export const isCommandId = (id: string): id is CommandId => BY_ID.has(id);

/* ── chords ───────────────────────────────────────────────── */

export type Chord = { key: string; mod: boolean; ctrl: boolean; meta: boolean; alt: boolean; shift: boolean };

/** physical keys for symbols, so Shift or Option layers and other layouts still find them */
const CODE_KEYS: Readonly<Record<string, string>> = {
  Backquote: "`",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Equal: "=",
  Minus: "-",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
  Space: " ",
};

const NAMED: Readonly<Record<string, string>> = {
  esc: "Escape",
  escape: "Escape",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  space: " ",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  plus: "+",
};

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "AltGraph", "Meta", "OS", "Super", "Hyper", "CapsLock", "Fn", "FnLock", "NumLock", "ScrollLock", "Dead", "Process", "Unidentified", "Compose"]);

/** A key name in its canonical form: letters upper case, named keys spelled like KeyboardEvent.key; null if unknown. */
export function normalizeKey(raw: string): string | null {
  if (raw === " ") return " ";
  const t = raw.trim();
  if (!t) return null;
  if (t.length === 1) return t.toUpperCase();
  const named = NAMED[t.toLowerCase()];
  if (named) return named;
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(t)) return t.toUpperCase();
  return null;
}

/** "Mod+Shift+K" as a chord, or null when it isn't one (no key, two keys, unknown names). */
export function parseChord(text: string): Chord | null {
  if (typeof text !== "string" || !text || text.length > 40) return null;
  /* "Mod++" is Mod and the plus key */
  let rest = text;
  let plus = false;
  if (rest === "+" || rest.endsWith("++")) {
    plus = true;
    rest = rest.slice(0, rest === "+" ? 0 : -2);
  }
  const tokens = rest ? rest.split("+") : [];
  if (tokens.some((t) => !t.trim())) return null;
  if (plus) tokens.push("+");
  const c: Chord = { key: "", mod: false, ctrl: false, meta: false, alt: false, shift: false };
  for (const tok of tokens) {
    switch (tok.trim().toLowerCase()) {
      case "mod":
      case "cmdorctrl":
        c.mod = true;
        continue;
      case "ctrl":
      case "control":
        c.ctrl = true;
        continue;
      case "meta":
      case "cmd":
      case "command":
      case "super":
      case "win":
        c.meta = true;
        continue;
      case "alt":
      case "option":
      case "opt":
        c.alt = true;
        continue;
      case "shift":
        c.shift = true;
        continue;
    }
    if (c.key) return null;
    const key = normalizeKey(tok);
    if (!key) return null;
    c.key = key;
  }
  return c.key ? c : null;
}

/** The canonical text of a chord: modifiers in a fixed order, then the key. */
export function formatChord(c: Chord): string {
  const out: string[] = [];
  if (c.mod) out.push("Mod");
  if (c.ctrl) out.push("Ctrl");
  if (c.meta) out.push("Meta");
  if (c.alt) out.push("Alt");
  if (c.shift) out.push("Shift");
  out.push(c.key === " " ? "Space" : c.key === "+" ? "Plus" : c.key);
  return out.join("+");
}

export const canonicalChord = (text: string): string | null => {
  const c = parseChord(text);
  return c ? formatChord(c) : null;
};

/** The modifiers a chord needs on this platform, with "Mod" resolved. */
export function resolveMods(c: Chord, mac: boolean) {
  return { ctrl: c.ctrl || (c.mod && !mac), meta: c.meta || (c.mod && mac), alt: c.alt, shift: c.shift };
}

/** Two chords that are the same keys on this platform share a conflict key ("Mod+B" and "Ctrl+B" off a Mac). */
export function conflictKey(c: Chord, mac: boolean): string {
  const m = resolveMods(c, mac);
  return [m.ctrl && "ctrl", m.meta && "meta", m.alt && "alt", m.shift && "shift", c.key].filter(Boolean).join("+");
}

/* ── events ───────────────────────────────────────────────── */

export type KeyEventLike = {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
  getModifierState?: (key: string) => boolean;
};

/** The key a chord names for this event: the layout's letter, else the physical key for letters, digits and symbols. */
export function eventKey(e: Pick<KeyEventLike, "key" | "code">): string | null {
  const layout = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (/^[A-Z]$/.test(layout)) return layout;
  const code = e.code ?? "";
  const letter = /^Key([A-Z])$/.exec(code)?.[1];
  if (letter) return letter;
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code)?.[1];
  if (digit) return digit;
  if (CODE_KEYS[code]) return CODE_KEYS[code];
  return normalizeKey(e.key);
}

/** True while an input method is composing: its keys pick characters, they aren't shortcuts. */
export const composing = (e: KeyEventLike) => Boolean(e.isComposing) || e.keyCode === 229;

/** AltGr types characters on Windows and Linux layouts, where it arrives as Ctrl+Alt. */
const altGraph = (e: KeyEventLike, mac: boolean) => !mac && Boolean(e.getModifierState?.("AltGraph"));

/** Whether an event is this chord. Never while composing; AltGr text never counts as Ctrl or Alt off a Mac. */
export function matchesChord(e: KeyEventLike, c: Chord, mac: boolean): boolean {
  if (composing(e) || MODIFIER_KEYS.has(e.key)) return false;
  const m = resolveMods(c, mac);
  let { ctrlKey, altKey } = e;
  if (altGraph(e, mac)) {
    if (m.ctrl || m.alt) return false;
    ctrlKey = false;
    altKey = false;
  }
  if (ctrlKey !== m.ctrl || e.metaKey !== m.meta || altKey !== m.alt) return false;
  if (eventKey(e) === c.key && e.shiftKey === m.shift) return true;
  /* a symbol named without Shift ("?") matches however the layout types it */
  if (!m.shift && c.key.length === 1 && !/[A-Z0-9 ]/.test(c.key)) return e.key === c.key;
  return false;
}

/** The chord an event would record as, or null for a lone modifier or a composing key. */
export function chordFromEvent(e: KeyEventLike, mac: boolean): string | null {
  if (composing(e) || MODIFIER_KEYS.has(e.key)) return null;
  const key = eventKey(e);
  if (!key) return null;
  const ag = altGraph(e, mac);
  const ctrl = e.ctrlKey && !ag;
  const alt = e.altKey && !ag;
  const c: Chord = { key, mod: mac ? e.metaKey : ctrl, ctrl: mac ? e.ctrlKey : false, meta: mac ? false : e.metaKey, alt, shift: e.shiftKey };
  return formatChord(c);
}

/** Ctrl+letter (and Ctrl+[ \ ] and friends) inside a terminal are control characters the shell needs. */
export function terminalKey(e: KeyEventLike): boolean {
  if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
  const k = eventKey(e);
  return k !== null && /^[A-Z@[\\\]^_ ]$/.test(k);
}

/* ── user bindings ────────────────────────────────────────── */

/** Per command, the chords that replace its defaults (an empty list turns it off). */
export type Bindings = Partial<Record<CommandId, string[]>>;

export const MAX_CHORDS = 4;

/** Keeps known, rebindable commands with valid chords, in canonical form. */
export function cleanBindings(input: unknown): Bindings {
  const out: Bindings = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  for (const [id, list] of Object.entries(input)) {
    const cmd = BY_ID.get(id);
    if (!cmd || cmd.fixed || !Array.isArray(list)) continue;
    const chords = [...new Set(list.map((k) => (typeof k === "string" ? canonicalChord(k) : null)).filter((k): k is string => k !== null))].slice(0, MAX_CHORDS);
    if (chords.length || !list.length) out[id as CommandId] = chords;
  }
  return out;
}

/** Stored text of a bindings object: sorted JSON with only overrides, "{}" for none. */
export function serializeBindings(b: Bindings): string {
  const clean = cleanBindings(b);
  const sorted = Object.fromEntries(
    Object.entries(clean)
      .filter(([id, keys]) => keys && !sameKeys(keys, BY_ID.get(id)!.keys))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  return JSON.stringify(sorted);
}

/** Validates stored text; returns its canonical form, or null if it isn't a bindings object. */
export function normalizeBindingsText(text: string): string | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  return serializeBindings(data as Bindings);
}

export function parseBindings(text: string): Bindings {
  try {
    return cleanBindings(JSON.parse(text));
  } catch {
    return {};
  }
}

const sameKeys = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((k, i) => canonicalChord(k) === canonicalChord(b[i]));

/** The chords a command answers to with these bindings. */
export function keysFor(id: CommandId | string, bindings: Bindings): readonly string[] {
  const own = (bindings as Record<string, string[] | undefined>)[id];
  return own ?? BY_ID.get(id)?.keys ?? [];
}

export const isCustom = (id: CommandId, bindings: Bindings) => id in bindings && !sameKeys(bindings[id]!, BY_ID.get(id)!.keys);

/** Bindings with one command set to `keys` (its defaults drop the override). */
export function withKeys(bindings: Bindings, id: CommandId, keys: readonly string[]): Bindings {
  const next: Bindings = { ...bindings };
  if (sameKeys(keys, BY_ID.get(id)!.keys)) delete next[id];
  else next[id] = [...keys];
  return next;
}

const parsedCache = new Map<string, Chord | null>();
const chord = (text: string) => {
  let c = parsedCache.get(text);
  if (c === undefined) {
    c = parseChord(text);
    if (parsedCache.size > 500) parsedCache.clear();
    parsedCache.set(text, c);
  }
  return c;
};

/** Whether an event is one of the command's chords. */
export function matchesCommand(e: KeyEventLike, id: CommandId, bindings: Bindings, mac: boolean): boolean {
  for (const k of keysFor(id, bindings)) {
    const c = chord(k);
    if (c && matchesChord(e, c, mac)) return true;
  }
  return false;
}

/** The command (of `ids`, or all) an event triggers. */
export function commandForEvent(e: KeyEventLike, bindings: Bindings, mac: boolean, ids: readonly CommandId[] = COMMANDS.map((c) => c.id)): CommandId | null {
  return ids.find((id) => matchesCommand(e, id, bindings, mac)) ?? null;
}

const overlaps = (a: CommandScope = "global", b: CommandScope = "global") => a === "global" || b === "global" || a === b;

/** Other commands that answer to the same keys as `chordText` would for `id`. */
export function conflictsFor(id: CommandId, chordText: string, bindings: Bindings, mac: boolean): CommandId[] {
  const c = parseChord(chordText);
  if (!c) return [];
  const key = conflictKey(c, mac);
  const scope = BY_ID.get(id)?.scope;
  return COMMANDS.filter((other) => other.id !== id && overlaps(scope, (other as Command).scope) && keysFor(other.id, bindings).some((k) => {
    const o = chord(k);
    return o !== null && conflictKey(o, mac) === key;
  })).map((o) => o.id);
}

/** Every pair of commands sharing keys, as "command -> the others". */
export function allConflicts(bindings: Bindings, mac: boolean): Map<CommandId, CommandId[]> {
  const out = new Map<CommandId, CommandId[]>();
  for (const cmd of COMMANDS) {
    const hits = new Set<CommandId>();
    for (const k of keysFor(cmd.id, bindings)) for (const o of conflictsFor(cmd.id, k, bindings, mac)) hits.add(o);
    if (hits.size) out.set(cmd.id, [...hits]);
  }
  return out;
}

/** Chords the browser or the OS usually keeps for itself; a page never sees them. */
export function reservedBy(chordText: string, mac: boolean): string | null {
  const c = parseChord(chordText);
  if (!c) return null;
  const k = conflictKey(c, mac);
  const browser = mac ? ["meta+T", "meta+W", "meta+N", "meta+Q", "meta+shift+T", "meta+shift+N", "meta+`", "meta+Tab", "meta+H", "meta+M"] : ["ctrl+T", "ctrl+W", "ctrl+N", "ctrl+shift+T", "ctrl+shift+N", "ctrl+shift+W", "ctrl+Tab", "ctrl+shift+Tab", "alt+F4"];
  return browser.includes(k) ? "Your browser or system may keep this one for itself." : null;
}

/* ── labels ───────────────────────────────────────────────── */

const KEY_LABEL: Record<string, string> = { Enter: "Enter", Escape: "Esc", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", " ": "Space", Backspace: "Backspace", Delete: "Delete", PageUp: "PgUp", PageDown: "PgDn" };
const MAC_KEY: Record<string, string> = { Enter: "↵", Backspace: "⌫", Delete: "⌦", Tab: "⇥" };

/** A chord as key caps for this platform: glyphs on a Mac (in Apple's order), words elsewhere. */
export function chordParts(text: string, mac: boolean): string[] {
  const c = parseChord(text);
  if (!c) return [text];
  const key = (mac && MAC_KEY[c.key]) || KEY_LABEL[c.key] || c.key;
  if (mac) {
    const m = resolveMods(c, true);
    return [...(m.ctrl ? ["⌃"] : []), ...(m.alt ? ["⌥"] : []), ...(m.shift ? ["⇧"] : []), ...(m.meta ? ["⌘"] : []), key];
  }
  const m = resolveMods(c, false);
  return [...(m.ctrl ? ["Ctrl"] : []), ...(m.meta ? ["Meta"] : []), ...(m.alt ? ["Alt"] : []), ...(m.shift ? ["Shift"] : []), key];
}

export const chordLabel = (text: string, mac: boolean) => chordParts(text, mac).join(mac ? "" : "+");
