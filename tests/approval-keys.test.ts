import { describe, expect, it } from "vitest";
import { approvalKey, type ApprovalKeyContext, type FocusSpot } from "@/lib/client/approval-keys";

const key = (k: string, more: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean; isComposing: boolean; keyCode: number; repeat: boolean }> = {}) => ({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...more });
const perm = (focus: FocusSpot, more: Partial<ApprovalKeyContext> = {}): ApprovalKeyContext => ({ kind: "permission", focus, canAlwaysAllow: true, ...more });
const ask = (focus: FocusSpot, more: Partial<ApprovalKeyContext> = {}): ApprovalKeyContext => ({ kind: "question", focus, options: 3, canContinue: false, ...more });

describe("approvalKey: approvals", () => {
  it("Enter allows, Esc denies and A always allows with focus on the page", () => {
    expect(approvalKey(key("Enter"), perm("page"))).toEqual({ type: "allow" });
    expect(approvalKey(key("Escape"), perm("page"))).toEqual({ type: "deny" });
    expect(approvalKey(key("a"), perm("page"))).toEqual({ type: "always" });
    expect(approvalKey(key("A", { shiftKey: true }), perm("page"))).toEqual({ type: "always" });
  });

  it("A does nothing when always allow isn't offered", () => {
    expect(approvalKey(key("a"), perm("page", { canAlwaysAllow: false }))).toBeNull();
  });

  it("from an empty message box only Enter and Esc answer, so typing a message never trips A", () => {
    expect(approvalKey(key("Enter"), perm("composer-empty"))).toEqual({ type: "allow" });
    expect(approvalKey(key("Escape"), perm("composer-empty"))).toEqual({ type: "deny" });
    expect(approvalKey(key("a"), perm("composer-empty"))).toBeNull();
  });

  it("text in the message box or any other field keeps every key (Esc there is the box's own)", () => {
    for (const focus of ["composer-text", "field"] as const) {
      for (const k of ["Enter", "Escape", "a"]) expect(approvalKey(key(k), perm(focus))).toBeNull();
    }
  });

  it("Enter on a focused button presses that button, not Allow; Esc and A still answer", () => {
    expect(approvalKey(key("Enter"), perm("button"))).toBeNull();
    expect(approvalKey(key("Escape"), perm("button"))).toEqual({ type: "deny" });
    expect(approvalKey(key("a"), perm("button"))).toEqual({ type: "always" });
  });

  it("an input method composing, modifiers, a held key, Shift+Enter and open menus win", () => {
    expect(approvalKey(key("Enter", { isComposing: true }), perm("page"))).toBeNull();
    expect(approvalKey(key("Enter", { keyCode: 229 }), perm("composer-empty"))).toBeNull();
    expect(approvalKey(key("Enter", { ctrlKey: true }), perm("page"))).toBeNull();
    expect(approvalKey(key("Enter", { metaKey: true }), perm("page"))).toBeNull();
    expect(approvalKey(key("a", { altKey: true }), perm("page"))).toBeNull();
    expect(approvalKey(key("Enter", { repeat: true }), perm("page"))).toBeNull();
    expect(approvalKey(key("Enter", { shiftKey: true }), perm("page"))).toBeNull();
    expect(approvalKey(key("Escape"), perm("page", { overlay: true }))).toBeNull();
  });

  it("other keys pass through", () => {
    expect(approvalKey(key("1"), perm("page"))).toBeNull();
    expect(approvalKey(key("x"), perm("page"))).toBeNull();
  });
});

describe("approvalKey: questions", () => {
  it("1-9 pick the matching option outside text fields", () => {
    expect(approvalKey(key("1"), ask("page"))).toEqual({ type: "pick", index: 0 });
    expect(approvalKey(key("3"), ask("button"))).toEqual({ type: "pick", index: 2 });
    expect(approvalKey(key("4"), ask("page"))).toBeNull();
    expect(approvalKey(key("0"), ask("page"))).toBeNull();
  });

  it("digits type normally in the message box and the custom answer field", () => {
    expect(approvalKey(key("1"), ask("composer-empty"))).toBeNull();
    expect(approvalKey(key("1"), ask("field"))).toBeNull();
  });

  it("Enter moves on only once something is picked", () => {
    expect(approvalKey(key("Enter"), ask("page"))).toBeNull();
    expect(approvalKey(key("Enter"), ask("page", { canContinue: true }))).toEqual({ type: "continue" });
    expect(approvalKey(key("Enter"), ask("composer-empty", { canContinue: true }))).toEqual({ type: "continue" });
    expect(approvalKey(key("Enter"), ask("composer-text", { canContinue: true }))).toBeNull();
  });

  it("Esc doesn't throw away a half-answered question", () => {
    expect(approvalKey(key("Escape"), ask("page"))).toBeNull();
  });
});
