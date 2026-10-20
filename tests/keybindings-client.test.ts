import { beforeEach, describe, expect, it } from "vitest";

/* The browser side: shortcuts read the keybindings device setting as it changes, and stay quiet while recording. */

class MemStorage {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

const g = globalThis as Record<string, unknown>;
g.localStorage = new MemStorage();
const { getSetting, resetSettings, setSetting } = await import("@/lib/client/settings");
const { comboFor, commandFor, isCommand, setRecording } = await import("@/lib/client/shortcuts");

const key = (key: string, mods: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean } = {}) => ({
  key,
  code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : undefined,
  ctrlKey: Boolean(mods.ctrl),
  metaKey: Boolean(mods.meta),
  altKey: Boolean(mods.alt),
  shiftKey: Boolean(mods.shift),
});

describe("shortcuts in the browser", () => {
  beforeEach(() => {
    (g.localStorage as MemStorage).m.clear();
    setRecording(false);
  });

  it("start with the defaults", () => {
    expect(isCommand(key("k", { ctrl: true }), "palette", false)).toBe(true);
    expect(comboFor("palette", false)).toBe("Ctrl+K");
  });

  it("follow a rebind at once, and a reset", () => {
    setSetting("keybindings", '{"palette":["Mod+P"]}');
    expect(localStorage.getItem("cui:keys")).toBe('{"palette":["Mod+P"]}');
    expect(isCommand(key("p", { ctrl: true }), "palette", false)).toBe(true);
    expect(isCommand(key("k", { ctrl: true }), "palette", false)).toBe(false);
    expect(comboFor("palette", true)).toBe("⌘P");
    resetSettings(["keybindings"]);
    expect(getSetting("keybindings")).toBe("{}");
    expect(isCommand(key("k", { ctrl: true }), "palette", false)).toBe(true);
  });

  it("ignore a broken stored value", () => {
    localStorage.setItem("cui:keys", "{nope");
    expect(getSetting("keybindings")).toBe("{}");
    expect(isCommand(key("b", { ctrl: true }), "sidebar", false)).toBe(true);
  });

  it("never fire while a new shortcut is being recorded", () => {
    setRecording(true);
    expect(isCommand(key("k", { ctrl: true }), "palette", false)).toBe(false);
    expect(commandFor(key("t", { alt: true }), ["newSession"], false)).toBeNull();
    setRecording(false);
    expect(commandFor(key("t", { alt: true }), ["newSession", "closeTab"], false)).toBe("newSession");
  });
});
