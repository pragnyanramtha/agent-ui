import { describe, expect, it } from "vitest";
import { composing, enterAction, enterSends, sendHint, type KeyLike, type SendShortcut } from "@/lib/client/composer-keys";
import { lineCount, pasteAction } from "@/lib/client/composer-paste";

const key = (k: Partial<KeyLike> = {}): KeyLike => ({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...k });
const MODES: SendShortcut[] = ["enter", "mod-enter", "enter-always"];

describe("Enter in the composer", () => {
  it("Enter mode: Enter sends with a keyboard, adds a line on a phone", () => {
    expect(enterAction(key(), "enter", false)).toBe("send");
    expect(enterAction(key(), "enter", true)).toBe("newline");
    expect(enterAction(key({ shiftKey: true }), "enter", false)).toBe("newline");
  });

  it("Ctrl/Cmd+Enter mode: Enter adds a line everywhere, the modifier sends", () => {
    expect(enterAction(key(), "mod-enter", false)).toBe("newline");
    expect(enterAction(key(), "mod-enter", true)).toBe("newline");
    expect(enterAction(key({ ctrlKey: true }), "mod-enter", false)).toBe("send");
    expect(enterAction(key({ metaKey: true }), "mod-enter", false)).toBe("send");
  });

  it("Enter everywhere: the phone's return key sends too", () => {
    expect(enterAction(key(), "enter-always", false)).toBe("send");
    expect(enterAction(key(), "enter-always", true)).toBe("send");
    expect(enterAction(key({ shiftKey: true }), "enter-always", true)).toBe("newline");
  });

  it("Ctrl/Cmd+Enter sends and Shift+Enter adds a line in every mode", () => {
    for (const mode of MODES) {
      for (const touch of [false, true]) {
        expect(enterAction(key({ ctrlKey: true }), mode, touch)).toBe("send");
        expect(enterAction(key({ metaKey: true }), mode, touch)).toBe("send");
        expect(enterAction(key({ shiftKey: true }), mode, touch)).toBe("newline");
        expect(enterAction(key({ shiftKey: true, ctrlKey: true }), mode, touch)).toBe("newline");
      }
    }
  });

  it("never sends while an input method composes", () => {
    for (const mode of MODES) {
      for (const touch of [false, true]) {
        expect(enterAction(key({ isComposing: true }), mode, touch)).toBeNull();
        /* Safari: the Enter that commits a candidate arrives as keyCode 229 with isComposing false */
        expect(enterAction(key({ keyCode: 229 }), mode, touch)).toBeNull();
        expect(enterAction(key({ isComposing: true, ctrlKey: true }), mode, touch)).toBeNull();
      }
    }
    expect(composing(key({ key: "a", isComposing: true }))).toBe(true);
    expect(composing(key({ key: "a", keyCode: 65 }))).toBe(false);
  });

  it("leaves other keys and Alt+Enter alone", () => {
    expect(enterAction(key({ key: "a" }), "enter", false)).toBeNull();
    expect(enterAction(key({ key: "Escape" }), "enter-always", true)).toBeNull();
    expect(enterAction(key({ altKey: true }), "enter", false)).toBeNull();
  });

  it("says when Enter sends, for the phone keyboard's key label", () => {
    expect(enterSends("enter", false)).toBe(true);
    expect(enterSends("enter", true)).toBe(false);
    expect(enterSends("mod-enter", false)).toBe(false);
    expect(enterSends("enter-always", true)).toBe(true);
  });

  it("names the active shortcut, and stays quiet on phones where Send is the way", () => {
    expect(sendHint("enter", false, false)).toBe("Enter to send, Shift+Enter for a new line");
    expect(sendHint("mod-enter", false, true)).toBe("⌘Enter to send");
    expect(sendHint("mod-enter", false, false)).toBe("Ctrl+Enter to send");
    expect(sendHint("enter", true, false)).toBeNull();
    expect(sendHint("mod-enter", true, false)).toBeNull();
    expect(sendHint("enter-always", true, false)).toBe("Return sends");
  });
});

describe("long pastes", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");

  it("counts lines whatever the line endings", () => {
    expect(lineCount("")).toBe(0);
    expect(lineCount("one")).toBe(1);
    expect(lineCount("a\nb\r\nc\rd")).toBe(4);
  });

  it("only acts on pastes over the limit", () => {
    expect(pasteAction(lines(200), "attach", 200)).toBe("text");
    expect(pasteAction(lines(201), "attach", 200)).toBe("attach");
    expect(pasteAction(lines(201), "confirm", 200)).toBe("flag");
    expect(pasteAction(lines(5000), "text", 200)).toBe("text");
  });
});
