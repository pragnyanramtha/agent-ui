/* What Enter does in the composer, under each "Send shortcut" setting. No DOM here, so it can be unit tested.
 *  - "enter":        Enter sends, Shift+Enter adds a line. On phones Enter adds a line and the Send button sends.
 *  - "mod-enter":    Ctrl+Enter (Cmd+Enter on a Mac) sends, Enter adds a line.
 *  - "enter-always": Enter sends everywhere, the phone keyboard's return key too.
 * Ctrl/Cmd+Enter sends in every mode, and Shift+Enter always adds a line. */

export type SendShortcut = "enter" | "mod-enter" | "enter-always";

export type KeyLike = {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
};

/** True while an input method is composing (Enter picks a candidate then, it must never send). Safari reports
 * the Enter that ends a composition as keyCode 229 with isComposing already false. */
export const composing = (e: KeyLike) => Boolean(e.isComposing) || e.keyCode === 229;

/** Whether plain Enter sends on this device. */
export const enterSends = (mode: SendShortcut, touch: boolean) => mode === "enter-always" || (mode === "enter" && !touch);

/** "send" when the key sends the message, "newline" when it adds a line (left to the textarea), null for other keys. */
export function enterAction(e: KeyLike, mode: SendShortcut, touch: boolean): "send" | "newline" | null {
  if (e.key !== "Enter" || composing(e)) return null;
  if (e.shiftKey) return "newline";
  if (e.altKey) return null;
  if (e.ctrlKey || e.metaKey) return "send";
  return enterSends(mode, touch) ? "send" : "newline";
}

/** The hint under the composer, or null on phones where the Send button is the way to send. */
export function sendHint(mode: SendShortcut, touch: boolean, mac: boolean): string | null {
  const mod = mac ? "⌘Enter" : "Ctrl+Enter";
  if (touch) return mode === "enter-always" ? "Return sends" : null;
  return enterSends(mode, touch) ? "Enter to send, Shift+Enter for a new line" : `${mod} to send`;
}

/** The keys that send with a keyboard, as chords for the shortcut lists ("Mod+Enter" is Ctrl+Enter, or ⌘Enter on a Mac). */
export const sendChords = (mode: SendShortcut): string[] => (enterSends(mode, false) ? ["Enter", "Mod+Enter"] : ["Mod+Enter"]);

/** The line under Send message in the shortcut lists. */
export const sendNote = (mode: SendShortcut): string => `${enterSends(mode, false) ? "Shift+Enter" : "Enter"} adds a new line. Change it under Composer > Send with.`;
