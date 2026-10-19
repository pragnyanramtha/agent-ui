/**
 * Keyboard shortcuts in the browser: the commands and their default keys live in lib/keybindings.ts, the user's
 * changes in the `keybindings` device setting. Handlers stay with each feature and ask `isCommand(event, id)`.
 */
import { useMemo } from "react";
import { chordLabel, matchesCommand, parseBindings, terminalKey, keysFor, type Bindings, type CommandId, type KeyEventLike } from "@/lib/keybindings";
import { getSetting, useSetting } from "./settings";

export const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** The "Mod" key of a key event: Cmd alone on a Mac, Ctrl alone elsewhere. */
export const hasMod = (e: { ctrlKey: boolean; metaKey: boolean }, mac = isMac()) => (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);

let raw: string | null = null;
let cached: Bindings = {};

/** The user's bindings right now (parsed once per change). */
export function currentBindings(): Bindings {
  const next = getSetting("keybindings");
  if (next !== raw) {
    raw = next;
    cached = parseBindings(next);
  }
  return cached;
}

export function useBindings(): Bindings {
  const [text] = useSetting("keybindings");
  return useMemo(() => parseBindings(text), [text]);
}

let recording = false;

/** While Settings records a new shortcut, no command fires. */
export const setRecording = (on: boolean) => {
  recording = on;
};

/** Whether a key event is the command's shortcut (never while an input method composes or a shortcut is being recorded). */
export function isCommand(e: KeyEventLike, id: CommandId, mac = isMac()): boolean {
  return !recording && matchesCommand(e, id, currentBindings(), mac);
}

/** The first of `ids` whose shortcut this event is. */
export function commandFor<T extends CommandId>(e: KeyEventLike, ids: readonly T[], mac = isMac()): T | null {
  if (recording) return null;
  const b = currentBindings();
  return ids.find((id) => matchesCommand(e, id, b, mac)) ?? null;
}

/** Ctrl+letter inside a terminal: a control character for the shell, so app shortcuts leave it alone. */
export const terminalOwns = (e: KeyEventLike & { target: EventTarget | null }) => e.target instanceof Element && Boolean(e.target.closest(".xterm")) && terminalKey(e);

/** The label of a command's first shortcut ("⌘K", "Ctrl+K"), "" when it has none.
 * `inTerminal` picks the first one that still works from inside a terminal. */
export function comboFor(id: CommandId, mac = isMac(), opts: { inTerminal?: boolean; bindings?: Bindings } = {}): string {
  const keys = keysFor(id, opts.bindings ?? currentBindings());
  const pick = opts.inTerminal ? keys.find((k) => !ownedByTerminal(k, mac)) : keys[0];
  return pick ? chordLabel(pick, mac) : "";
}

const ownedByTerminal = (chord: string, mac: boolean) => {
  const c = /^(Mod|Ctrl)\+([A-Z@[\\\]^_]|Space)$/.exec(chord);
  return Boolean(c && (c[1] === "Ctrl" || !mac));
};

/** True while a dialog is up. The phone drawer and tab sheet stay in the DOM when closed, marked aria-hidden. */
export const modalOpen = () => typeof document !== "undefined" && Boolean(document.querySelector('[aria-modal="true"]:not([aria-hidden="true"])'));

/** True when keyboard focus is in a field, where single-key shortcuts must not fire. */
export const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.isContentEditable || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || (t.tagName === "INPUT" && !["checkbox", "radio", "button"].includes((t as HTMLInputElement).type)) || Boolean(t.closest(".xterm")));
