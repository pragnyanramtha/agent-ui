import { describe, expect, it } from "vitest";
import { enterAction, sendChords, sendNote, type KeyLike, type SendShortcut } from "@/lib/client/composer-keys";
import { chordLabel, parseChord } from "@/lib/keybindings";

const MODES: SendShortcut[] = ["enter", "mod-enter", "enter-always"];

const press = (chord: string): KeyLike => {
  const c = parseChord(chord)!;
  return { key: c.key, shiftKey: false, ctrlKey: Boolean(c.mod), metaKey: false, altKey: false };
};

describe("Send message in the shortcut lists", () => {
  it("shows the keys Send with picks", () => {
    expect(sendChords("mod-enter")).toEqual(["Mod+Enter"]);
    expect(sendChords("enter")).toEqual(["Enter", "Mod+Enter"]);
    expect(sendChords("enter-always")).toEqual(["Enter", "Mod+Enter"]);
  });

  it("every key it shows really sends with a keyboard", () => {
    for (const mode of MODES) for (const chord of sendChords(mode)) expect(enterAction(press(chord), mode, false)).toBe("send");
    expect(enterAction(press("Enter"), "mod-enter", false)).toBe("newline");
  });

  it("reads as keys on both platforms", () => {
    expect(sendChords("enter").map((k) => chordLabel(k, false))).toEqual(["Enter", "Ctrl+Enter"]);
    expect(sendChords("mod-enter").map((k) => chordLabel(k, true))).toEqual(["⌘↵"]);
  });

  it("names the key that adds a line, and where to change it", () => {
    expect(sendNote("mod-enter")).toBe("Enter adds a new line. Change it under Composer > Send with.");
    expect(sendNote("enter")).toMatch(/^Shift\+Enter adds a new line\./);
    expect(sendNote("enter-always")).toMatch(/^Shift\+Enter/);
  });
});
