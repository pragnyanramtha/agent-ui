/**
 * Every keyboard shortcut the app handles, for the shortcuts sheet, Settings and palette hints.
 * Keys: "Mod" is Cmd on a Mac and Ctrl elsewhere; "Ctrl" is Ctrl everywhere.
 * The handlers live with the feature (App, SessionScreen, Composer, Thread); keep this list in step.
 */
export type Shortcut = { id: string; keys: string[]; label: string; group: "General" | "Sessions" | "Panels" | "Composer" };

export const SHORTCUTS: Shortcut[] = [
  { id: "palette", keys: ["Mod", "K"], label: "Search sessions and actions", group: "General" },
  { id: "shortcuts", keys: ["?"], label: "Keyboard shortcuts", group: "General" },
  { id: "settings", keys: ["Mod", ","], label: "Settings", group: "General" },
  { id: "sidebar", keys: ["Mod", "B"], label: "Toggle sidebar", group: "General" },
  { id: "new", keys: ["Alt", "T"], label: "New session", group: "Sessions" },
  { id: "close", keys: ["Alt", "W"], label: "Close tab", group: "Sessions" },
  { id: "reopen", keys: ["Alt", "Shift", "T"], label: "Reopen closed tab", group: "Sessions" },
  { id: "next", keys: ["Ctrl", "Tab"], label: "Next tab", group: "Sessions" },
  { id: "jump", keys: ["Alt", "1–9"], label: "Go to tab", group: "Sessions" },
  { id: "find", keys: ["Mod", "F"], label: "Find in session", group: "Sessions" },
  { id: "terminal", keys: ["Mod", "J"], label: "Toggle terminal", group: "Panels" },
  { id: "terminal-anywhere", keys: ["Ctrl", "`"], label: "Toggle terminal (also from inside it)", group: "Panels" },
  { id: "panel", keys: ["Mod", "Alt", "B"], label: "Toggle side panel", group: "Panels" },
  { id: "close-terminal", keys: ["Ctrl", "Shift", "X"], label: "Close terminal", group: "Panels" },
  { id: "send", keys: ["Mod", "Enter"], label: "Send message", group: "Composer" },
  { id: "recall", keys: ["↑"], label: "Edit last message (empty composer)", group: "Composer" },
  { id: "stash", keys: ["Mod", "S"], label: "Stash the draft", group: "Composer" },
  { id: "stop", keys: ["Esc"], label: "Stop the turn (while working)", group: "Composer" },
];

export const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** The "Mod" key of a key event: Cmd alone on a Mac, Ctrl alone elsewhere. */
export const hasMod = (e: { ctrlKey: boolean; metaKey: boolean }, mac = isMac()) => (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);

const GLYPH: Record<string, string> = { Mod: "⌘", Alt: "⌥", Shift: "⇧", Ctrl: "⌃", Enter: "↵" };

/** Key labels for this platform: glyphs on a Mac, words elsewhere. */
export function keyLabels(keys: string[], mac = isMac()) {
  return keys.map((k) => (mac ? GLYPH[k] ?? k : k === "Mod" ? "Ctrl" : k));
}

export function comboFor(id: string, mac = isMac()) {
  const s = SHORTCUTS.find((x) => x.id === id);
  return s ? keyLabels(s.keys, mac).join(mac ? "" : "+") : "";
}

/** True while a dialog is up. The phone drawer and tab sheet stay in the DOM when closed, marked aria-hidden. */
export const modalOpen = () => typeof document !== "undefined" && Boolean(document.querySelector('[aria-modal="true"]:not([aria-hidden="true"])'));

/** True when keyboard focus is in a field, where single-key shortcuts must not fire. */
export const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.isContentEditable || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || (t.tagName === "INPUT" && !["checkbox", "radio", "button"].includes((t as HTMLInputElement).type)) || Boolean(t.closest(".xterm")));
