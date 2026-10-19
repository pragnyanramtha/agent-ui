/* "Send to chat" from places that don't own the composer (the terminal): a window event the
 * mounted session screen answers by appending to its draft. */

export const INSERT_INTO_COMPOSER_EVENT = "cui:insert-into-composer";
export type InsertIntoComposer = { text: string };

/** Text as a fenced code block, with a fence longer than any backtick run inside it */
export function fenceBlock(text: string, lang = ""): string {
  const body = text.replace(/[ \t]+$/gm, "").replace(/^\n+|\n+$/g, "");
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((m) => m.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${body}\n${fence}`;
}

/** The draft with `text` added on its own paragraph */
export function appendToDraft(draft: string, text: string): string {
  const head = draft.replace(/\s+$/, "");
  return head ? `${head}\n\n${text}\n` : `${text}\n`;
}

/** Asks the composer to take `text`; false when no composer is listening */
export function sendToComposer(text: string): boolean {
  const e = new CustomEvent<InsertIntoComposer>(INSERT_INTO_COMPOSER_EVENT, { detail: { text }, cancelable: true });
  return !window.dispatchEvent(e);
}

/** Sets a React-controlled textarea's value so its onChange runs, then puts the caret at the end */
export function fillTextarea(el: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus({ preventScroll: true });
  el.setSelectionRange(value.length, value.length);
  el.scrollTop = el.scrollHeight;
}
