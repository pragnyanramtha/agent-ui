import { describe, expect, it } from "vitest";
import {
  allConflicts,
  canonicalChord,
  chordFromEvent,
  chordLabel,
  cleanBindings,
  COMMANDS,
  commandForEvent,
  conflictsFor,
  isCustom,
  keysFor,
  matchesChord,
  matchesCommand,
  normalizeBindingsText,
  parseBindings,
  parseChord,
  reservedBy,
  serializeBindings,
  terminalKey,
  withKeys,
  type KeyEventLike,
} from "@/lib/keybindings";
import { DEFAULTS, diffSettings, parseValue, searchSettings, settingDef, settingsIn } from "@/lib/settings-schema";

type Ev = Partial<KeyEventLike> & { key: string; altGraph?: boolean };
const ev = ({ altGraph, ...e }: Ev): KeyEventLike => ({
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  code: e.key.length === 1 && /[a-z]/i.test(e.key) ? `Key${e.key.toUpperCase()}` : undefined,
  getModifierState: (k: string) => k === "AltGraph" && Boolean(altGraph),
  ...e,
});
const chord = (s: string) => parseChord(s)!;

describe("chord parser", () => {
  it("reads modifiers in any order and spelling, and writes them in one order", () => {
    expect(canonicalChord("shift+mod+k")).toBe("Mod+Shift+K");
    expect(canonicalChord("Cmd+Option+b")).toBe("Meta+Alt+B");
    expect(canonicalChord("control+`")).toBe("Ctrl+`");
    expect(canonicalChord("Alt+right")).toBe("Alt+ArrowRight");
    expect(canonicalChord("esc")).toBe("Escape");
    expect(canonicalChord("Mod+Space")).toBe("Mod+Space");
    expect(canonicalChord("f5")).toBe("F5");
  });

  it("knows the plus key", () => {
    expect(canonicalChord("Mod++")).toBe("Mod+Plus");
    expect(canonicalChord("Mod+Plus")).toBe("Mod+Plus");
    expect(parseChord("+")?.key).toBe("+");
  });

  it("refuses chords without exactly one known key", () => {
    for (const bad of ["", "Mod", "Mod+Shift", "K+J", "Mod+Banana", "Mod++K", "Mod+ +K", "x".repeat(50)]) expect(parseChord(bad), bad).toBeNull();
  });
});

describe("matching", () => {
  it("resolves Mod to Cmd on a Mac and Ctrl elsewhere", () => {
    const modK = chord("Mod+K");
    expect(matchesChord(ev({ key: "k", metaKey: true }), modK, true)).toBe(true);
    expect(matchesChord(ev({ key: "k", ctrlKey: true }), modK, true)).toBe(false);
    expect(matchesChord(ev({ key: "k", ctrlKey: true }), modK, false)).toBe(true);
    expect(matchesChord(ev({ key: "k", metaKey: true }), modK, false)).toBe(false);
  });

  it("keeps Ctrl literal on a Mac", () => {
    expect(matchesChord(ev({ key: "`", code: "Backquote", ctrlKey: true }), chord("Ctrl+`"), true)).toBe(true);
    expect(matchesChord(ev({ key: "`", code: "Backquote", metaKey: true }), chord("Ctrl+`"), true)).toBe(false);
  });

  it("needs exactly the chord's modifiers", () => {
    expect(matchesChord(ev({ key: "K", ctrlKey: true, shiftKey: true }), chord("Mod+K"), false)).toBe(false);
    expect(matchesChord(ev({ key: "k", ctrlKey: true, altKey: true }), chord("Mod+K"), false)).toBe(false);
    expect(matchesChord(ev({ key: "k" }), chord("Mod+K"), false)).toBe(false);
  });

  it("finds keys typed through Option or another layer by their physical key", () => {
    /* Option+T on a Mac types a dagger, Option+1 an inverted exclamation mark */
    expect(matchesChord(ev({ key: "†", code: "KeyT", altKey: true }), chord("Alt+T"), true)).toBe(true);
    expect(matchesChord(ev({ key: "¡", code: "Digit1", altKey: true }), chord("Alt+1"), true)).toBe(true);
    /* Shift+` types ~ on a US layout */
    expect(matchesChord(ev({ key: "~", code: "Backquote", ctrlKey: true, shiftKey: true }), chord("Ctrl+Shift+`"), false)).toBe(true);
    /* a Cyrillic layout still reaches Mod+B through the key's position */
    expect(matchesChord(ev({ key: "и", code: "KeyB", ctrlKey: true }), chord("Mod+B"), false)).toBe(true);
  });

  it("follows the layout for letters (Dvorak's K is where QWERTY has V)", () => {
    expect(matchesChord(ev({ key: "k", code: "KeyV", ctrlKey: true }), chord("Mod+K"), false)).toBe(true);
    expect(matchesChord(ev({ key: "v", code: "KeyV", ctrlKey: true }), chord("Mod+K"), false)).toBe(false);
  });

  it("matches a symbol named without Shift however the layout types it", () => {
    const help = chord("?");
    expect(matchesChord(ev({ key: "?", code: "Slash", shiftKey: true }), help, false)).toBe(true);
    /* German layout: ? is Shift+ß */
    expect(matchesChord(ev({ key: "?", code: "Minus", shiftKey: true }), help, false)).toBe(true);
    expect(matchesChord(ev({ key: "/", code: "Slash" }), help, false)).toBe(false);
    expect(matchesChord(ev({ key: "?", code: "Slash", shiftKey: true, ctrlKey: true }), help, false)).toBe(false);
  });

  it("never fires while an input method composes", () => {
    expect(matchesChord(ev({ key: "k", metaKey: true, isComposing: true }), chord("Mod+K"), true)).toBe(false);
    expect(matchesChord(ev({ key: "Process", keyCode: 229, ctrlKey: true }), chord("Mod+K"), false)).toBe(false);
    expect(matchesChord(ev({ key: "Escape", isComposing: true }), chord("Escape"), false)).toBe(false);
    expect(chordFromEvent(ev({ key: "k", ctrlKey: true, isComposing: true }), false)).toBeNull();
  });

  it("treats AltGr as typing off a Mac, never as Ctrl+Alt", () => {
    /* Windows reports AltGr+B as Ctrl+Alt+B with the AltGraph state set */
    const altgr = ev({ key: "{", code: "KeyB", ctrlKey: true, altKey: true, altGraph: true });
    expect(matchesChord(altgr, chord("Mod+Alt+B"), false)).toBe(false);
    expect(matchesChord(ev({ key: "b", code: "KeyB", ctrlKey: true, altKey: true }), chord("Mod+Alt+B"), false)).toBe(true);
    /* a symbol typed with AltGr is still that symbol */
    expect(matchesChord(ev({ key: "?", code: "KeyQ", ctrlKey: true, altKey: true, altGraph: true }), chord("?"), false)).toBe(true);
    /* on a Mac there is no AltGr: the state is ignored */
    expect(matchesChord(ev({ key: "∫", code: "KeyB", metaKey: true, altKey: true, altGraph: true }), chord("Mod+Alt+B"), true)).toBe(true);
  });

  it("ignores lone modifier presses", () => {
    expect(matchesChord(ev({ key: "Shift", shiftKey: true }), chord("Shift+A"), false)).toBe(false);
    expect(chordFromEvent(ev({ key: "Control", ctrlKey: true }), false)).toBeNull();
    expect(chordFromEvent(ev({ key: "Meta", metaKey: true }), true)).toBeNull();
  });

  it("leaves keys that type text to a text field", () => {
    const n = withKeys({}, "newSession", ["N"]);
    expect(matchesCommand(ev({ key: "n" }), "newSession", n, false)).toBe(true);
    expect(matchesCommand(ev({ key: "n" }), "newSession", n, false, true)).toBe(false);
    expect(matchesCommand(ev({ key: "?", shiftKey: true }), "shortcuts", {}, false, true)).toBe(false);
    /* German Mac: Option+5 types "[" and Option+8 "{" */
    expect(matchesCommand(ev({ key: "[", code: "Digit5", altKey: true }), "tab5", {}, true)).toBe(true);
    expect(matchesCommand(ev({ key: "[", code: "Digit5", altKey: true }), "tab5", {}, true, true)).toBe(false);
    expect(matchesCommand(ev({ key: "{", code: "Digit8", altKey: true }), "tab8", {}, true, true)).toBe(false);
    /* US Mac: Option+1 types "¡", which nobody needs more than the tab */
    expect(matchesCommand(ev({ key: "¡", code: "Digit1", altKey: true }), "tab1", {}, true, true)).toBe(true);
    expect(matchesCommand(ev({ key: "∑", code: "KeyW", altKey: true }), "closeTab", {}, true, true)).toBe(true);
    /* Ctrl, Cmd and named keys still work in a field */
    expect(matchesCommand(ev({ key: "k", metaKey: true }), "palette", {}, true, true)).toBe(true);
    expect(matchesCommand(ev({ key: "t", altKey: true }), "newSession", {}, false, true)).toBe(true);
    expect(matchesCommand(ev({ key: "Escape" }), "stop", {}, false, true)).toBe(true);
  });
});

describe("recording", () => {
  it("writes Mod for Cmd on a Mac and for Ctrl elsewhere", () => {
    expect(chordFromEvent(ev({ key: "p", metaKey: true }), true)).toBe("Mod+P");
    expect(chordFromEvent(ev({ key: "p", ctrlKey: true }), true)).toBe("Ctrl+P");
    expect(chordFromEvent(ev({ key: "p", ctrlKey: true }), false)).toBe("Mod+P");
    expect(chordFromEvent(ev({ key: "p", metaKey: true }), false)).toBe("Meta+P");
  });

  it("records the physical key under Option and Shift, and round-trips through the matcher", () => {
    expect(chordFromEvent(ev({ key: "π", code: "KeyP", altKey: true }), true)).toBe("Alt+P");
    expect(chordFromEvent(ev({ key: "?", code: "Slash", shiftKey: true }), false)).toBe("Shift+/");
    expect(chordFromEvent(ev({ key: "ArrowUp", altKey: true }), false)).toBe("Alt+ArrowUp");
    for (const [e, mac] of [
      [ev({ key: "π", code: "KeyP", altKey: true }), true],
      [ev({ key: "?", code: "Slash", shiftKey: true }), false],
      [ev({ key: "~", code: "Backquote", ctrlKey: true, shiftKey: true }), false],
      [ev({ key: "Enter", metaKey: true }), true],
    ] as const) {
      const recorded = chordFromEvent(e, mac)!;
      expect(matchesChord(e, chord(recorded), mac), recorded).toBe(true);
    }
  });

  it("drops AltGr from what it records", () => {
    expect(chordFromEvent(ev({ key: "@", code: "KeyQ", ctrlKey: true, altKey: true, altGraph: true }), false)).toBe("Q");
  });
});

describe("labels", () => {
  it("uses glyphs in Apple's order on a Mac and words elsewhere", () => {
    expect(chordLabel("Mod+Shift+K", true)).toBe("⇧⌘K");
    expect(chordLabel("Mod+Alt+B", true)).toBe("⌥⌘B");
    expect(chordLabel("Ctrl+`", true)).toBe("⌃`");
    expect(chordLabel("Mod+Shift+K", false)).toBe("Ctrl+Shift+K");
    expect(chordLabel("Alt+ArrowRight", false)).toBe("Alt+→");
    expect(chordLabel("Escape", false)).toBe("Esc");
    expect(chordLabel("Mod+Enter", true)).toBe("⌘↵");
  });
});

describe("terminal keys", () => {
  it("leaves Ctrl+letter to the shell but not Ctrl+` or Ctrl+Shift chords", () => {
    expect(terminalKey(ev({ key: "k", ctrlKey: true }))).toBe(true);
    expect(terminalKey(ev({ key: "j", ctrlKey: true }))).toBe(true);
    expect(terminalKey(ev({ key: "[", code: "BracketLeft", ctrlKey: true }))).toBe(true);
    expect(terminalKey(ev({ key: "`", code: "Backquote", ctrlKey: true }))).toBe(false);
    expect(terminalKey(ev({ key: "X", ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(terminalKey(ev({ key: "k", metaKey: true }))).toBe(false);
  });
});

describe("the command registry", () => {
  it("has unique ids and valid default chords", () => {
    expect(new Set(COMMANDS.map((c) => c.id)).size).toBe(COMMANDS.length);
    for (const c of COMMANDS) for (const k of c.keys) expect(canonicalChord(k), `${c.id} ${k}`).toBe(k);
  });

  it("ships without conflicts on either platform", () => {
    expect([...allConflicts({}, true)]).toEqual([]);
    expect([...allConflicts({}, false)]).toEqual([]);
  });

  it("keeps every shortcut the app had before they became rebindable", () => {
    const fires = (id: Parameters<typeof matchesCommand>[1], e: KeyEventLike, mac: boolean) => matchesCommand(e, id, {}, mac);
    expect(fires("palette", ev({ key: "k", metaKey: true }), true)).toBe(true);
    expect(fires("settings", ev({ key: ",", code: "Comma", ctrlKey: true }), false)).toBe(true);
    expect(fires("sidebar", ev({ key: "b", ctrlKey: true }), false)).toBe(true);
    expect(fires("sidebar", ev({ key: "S", ctrlKey: true, shiftKey: true }), true)).toBe(true);
    expect(fires("terminal", ev({ key: "`", code: "Backquote", ctrlKey: true }), true)).toBe(true);
    expect(fires("terminal", ev({ key: "j", metaKey: true }), true)).toBe(true);
    expect(fires("newTerminal", ev({ key: "~", code: "Backquote", ctrlKey: true, shiftKey: true }), false)).toBe(true);
    expect(fires("terminalFind", ev({ key: "F", ctrlKey: true, shiftKey: true }), false)).toBe(true);
    expect(fires("find", ev({ key: "f", metaKey: true }), true)).toBe(true);
    expect(fires("stash", ev({ key: "s", ctrlKey: true }), false)).toBe(true);
    expect(fires("stop", ev({ key: "Escape" }), false)).toBe(true);
    expect(fires("nextTab", ev({ key: "Tab", ctrlKey: true }), true)).toBe(true);
    expect(fires("prevTab", ev({ key: "Tab", ctrlKey: true, shiftKey: true }), false)).toBe(true);
    expect(fires("prevTab", ev({ key: "ArrowLeft", altKey: true }), false)).toBe(true);
    expect(fires("reopenTab", ev({ key: "T", altKey: true, shiftKey: true }), false)).toBe(true);
    expect(fires("lastTab", ev({ key: "9", code: "Digit9", altKey: true }), false)).toBe(true);
    expect(fires("sidePanel", ev({ key: "∫", code: "KeyB", metaKey: true, altKey: true }), true)).toBe(true);
    expect(fires("closeTerminal", ev({ key: "X", ctrlKey: true, shiftKey: true }), true)).toBe(true);
    expect(commandForEvent(ev({ key: "3", code: "Digit3", altKey: true }), {}, false)).toBe("tab3");
  });
});

describe("user bindings", () => {
  it("replace a command's defaults, and an empty list turns it off", () => {
    const b = withKeys({}, "palette", ["Mod+P"]);
    expect(keysFor("palette", b)).toEqual(["Mod+P"]);
    expect(matchesCommand(ev({ key: "p", ctrlKey: true }), "palette", b, false)).toBe(true);
    expect(matchesCommand(ev({ key: "k", ctrlKey: true }), "palette", b, false)).toBe(false);
    const off = withKeys({}, "sidebar", []);
    expect(matchesCommand(ev({ key: "b", ctrlKey: true }), "sidebar", off, false)).toBe(false);
    expect(isCustom("sidebar", off)).toBe(true);
  });

  it("drop the override when set back to the defaults", () => {
    expect(withKeys({ palette: ["Mod+P"] }, "palette", ["Mod+K"])).toEqual({});
    expect(serializeBindings({ palette: ["mod+k"] })).toBe("{}");
  });

  it("clean stored data: unknown commands, fixed ones, bad chords and duplicates go", () => {
    expect(cleanBindings({ palette: ["mod+p", "Mod+P", "Banana"], nope: ["Mod+X"], send: ["Enter"], sidebar: [], find: "Mod+F", settings: ["???+"] })).toEqual({ palette: ["Mod+P"], sidebar: [] });
    expect(cleanBindings(null)).toEqual({});
    expect(cleanBindings([["palette", ["Mod+P"]]])).toEqual({});
    expect(parseBindings("not json")).toEqual({});
  });

  it("serialize to sorted canonical JSON, so the same bindings are the same text", () => {
    const a = serializeBindings({ sidebar: ["ctrl+alt+s"], palette: ["mod+p"] });
    const b = serializeBindings({ palette: ["Mod+P"], sidebar: ["Ctrl+Alt+S"] });
    expect(a).toBe(b);
    expect(a).toBe('{"palette":["Mod+P"],"sidebar":["Ctrl+Alt+S"]}');
    expect(normalizeBindingsText("[]")).toBeNull();
    expect(normalizeBindingsText("{")).toBeNull();
    expect(normalizeBindingsText('{"palette":["shift+mod+o"]}')).toBe('{"palette":["Mod+Shift+O"]}');
  });
});

describe("conflicts", () => {
  it("finds commands that share keys on this platform", () => {
    const b = withKeys({}, "palette", ["Mod+B"]);
    expect(conflictsFor("palette", "Mod+B", b, false)).toEqual(["sidebar"]);
    expect(allConflicts(b, false).get("sidebar")).toEqual(["palette"]);
  });

  it("counts Mod and Ctrl as the same keys only where Mod is Ctrl", () => {
    const b = withKeys({}, "settings", ["Ctrl+B"]);
    expect(conflictsFor("settings", "Ctrl+B", b, false)).toEqual(["sidebar"]);
    expect(conflictsFor("settings", "Ctrl+B", b, true)).toEqual([]);
  });

  it("keeps terminal and composer commands apart, but not from global ones", () => {
    const b = withKeys({}, "stash", ["Mod+Shift+F"]);
    expect(conflictsFor("stash", "Mod+Shift+F", b, false)).toEqual([]);
    const g = withKeys({}, "settings", ["Mod+S"]);
    expect(conflictsFor("settings", "Mod+S", g, false)).toEqual(["stash"]);
  });

  it("warns about keys the browser keeps", () => {
    expect(reservedBy("Mod+W", false)).toMatch(/browser/);
    expect(reservedBy("Mod+W", true)).toMatch(/browser/);
    expect(reservedBy("Alt+W", false)).toBeNull();
  });
});

describe("the keybindings setting", () => {
  const def = settingDef("keybindings");

  it("is a device setting in the Keyboard section, reset with it", () => {
    expect(def.scope).toBe("device");
    expect(DEFAULTS.keybindings).toBe("{}");
    expect(settingsIn("keyboard").map((d) => d.key)).toContain("keybindings");
  });

  it("only accepts bindings, stored canonically", () => {
    expect(parseValue(def, '{"palette":["shift+mod+o"]}')).toEqual({ ok: true, value: '{"palette":["Mod+Shift+O"]}' });
    expect(parseValue(def, "hello").ok).toBe(false);
    expect(parseValue(def, 3).ok).toBe(false);
  });

  it("reads as a count in import summaries", () => {
    const changes = diffSettings(DEFAULTS, { keybindings: '{"palette":["Mod+P"],"sidebar":[]}' });
    expect(changes).toEqual([{ key: "keybindings", label: "Keyboard shortcuts", from: "Defaults", to: "2 changed" }]);
  });

  it("lets settings search find each command, not the raw setting", () => {
    const hit = searchSettings("sidebar").find((h) => h.section === "keyboard");
    expect(hit?.items).toContain("cmd:sidebar");
    expect(hit?.settings ?? []).not.toContain("keybindings");
  });
});
