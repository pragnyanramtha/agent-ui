import { composing, type KeyLike } from "./composer-keys";
import { isTyping } from "./shortcuts";

/** Where keyboard focus is when a key arrives. */
export type FocusSpot = "page" | "button" | "composer-empty" | "composer-text" | "field";

export type ApprovalKeyContext = {
  kind: "permission" | "question";
  focus: FocusSpot;
  canAlwaysAllow?: boolean;
  /** options of the question on screen */
  options?: number;
  /** the question on screen has an answer, so Enter can move on */
  canContinue?: boolean;
  /** a menu, dialog or popover is open and has the keys */
  overlay?: boolean;
};

export type ApprovalAction = { type: "allow" } | { type: "deny" } | { type: "always" } | { type: "pick"; index: number } | { type: "continue" };

/**
 * The single key answer for the request on screen, or null to leave the key alone.
 *
 * Precedence: an input method composing, a modifier, a held key or an open menu, dialog or popover
 * always wins. Text in the message box or any other field keeps every key. From an empty message box
 * only Enter (allow) and Esc (deny) answer, so typing a message never trips A or a digit; with an
 * approval waiting, Esc denies it instead of stopping the turn. A and 1-9 answer only when focus is
 * outside text fields. Enter on a focused button presses that button, not Allow.
 */
export function approvalKey(e: KeyLike & { repeat?: boolean }, c: ApprovalKeyContext): ApprovalAction | null {
  if (composing(e) || e.repeat || e.ctrlKey || e.metaKey || e.altKey || c.overlay) return null;
  const outside = c.focus === "page" || c.focus === "button";
  const enterOk = (c.focus === "page" || c.focus === "composer-empty") && e.key === "Enter" && !e.shiftKey;
  if (c.kind === "permission") {
    if (enterOk) return { type: "allow" };
    if (e.key === "Escape" && (outside || c.focus === "composer-empty")) return { type: "deny" };
    if (e.key.toLowerCase() === "a" && outside && c.canAlwaysAllow) return { type: "always" };
    return null;
  }
  if (/^[1-9]$/.test(e.key) && outside) {
    const index = Number(e.key) - 1;
    return index < (c.options ?? 0) ? { type: "pick", index } : null;
  }
  if (enterOk && c.canContinue) return { type: "continue" };
  return null;
}

const PRESSABLE = 'button, a[href], select, summary, [role="button"], [role="menuitem"], [role="option"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [role="link"]';

/** Classifies the event target for approvalKey. */
export function focusSpot(t: EventTarget | null): FocusSpot {
  if (typeof HTMLElement === "undefined" || !(t instanceof HTMLElement)) return "page";
  const box = t.tagName === "TEXTAREA" ? t.closest("[data-composer]") : null;
  if (box) return (t as HTMLTextAreaElement).value || box.querySelector('[aria-label="Attachments"]') ? "composer-text" : "composer-empty";
  if (isTyping(t)) return "field";
  return t.closest(PRESSABLE) ? "button" : "page";
}

/** The key landed in the card's session (or nowhere in particular), not in a side panel or another screen. */
export function keyInScope(t: EventTarget | null, card: Element | null): boolean {
  if (!card) return false;
  if (typeof Node === "undefined" || !(t instanceof Node) || t === document.body || t === document.documentElement) return true;
  return (card.closest("section") ?? document.body).contains(t);
}

/** A menu, list, dialog or the task popover is open; those own Enter and Escape. */
export const overlayOpen = () =>
  typeof document !== "undefined" && Boolean(document.querySelector('[role="menu"], [role="listbox"], [aria-modal="true"]:not([aria-hidden="true"]), [data-task-popover]'));
