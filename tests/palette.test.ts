import { describe, expect, it } from "vitest";
import { actionRank, filterActions, parsePaletteQuery, PALETTE_SETTINGS_MAX, settingRows } from "@/lib/palette-search";
import { allConflicts, canonicalChord, COMMANDS, conflictsFor, keysFor, matchesCommand, reservedBy, type CommandId, type KeyEventLike } from "@/lib/keybindings";
import { nextNeedingYou, sidebarOrder, stepIn, type Attention } from "@/lib/client/sidebar";
import { actionFor, paletteActions, palettePicker, setPaletteSource } from "@/lib/client/palette-actions";
import type { AgentId } from "@/lib/types";

const actions = [
  { id: "new", label: "New session", keywords: "new start create chat" },
  { id: "git", label: "Git and checkpoints", keywords: "git branch commit push" },
  { id: "pin", label: "Pin session", keywords: "pin favorite" },
  { id: "files", label: "Files", keywords: "files folder browse" },
  { id: "model", label: "Switch model…", keywords: "model opus sonnet" },
];
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("palette query", () => {
  it('reads a leading ">" as actions only, with the words after it', () => {
    expect(parsePaletteQuery(">")).toEqual({ actionsOnly: true, words: [] });
    expect(parsePaletteQuery("> Pin  Sess")).toEqual({ actionsOnly: true, words: ["pin", "sess"] });
    expect(parsePaletteQuery("  >git")).toEqual({ actionsOnly: true, words: ["git"] });
    expect(parsePaletteQuery("fix > tests")).toEqual({ actionsOnly: false, words: ["fix", ">", "tests"] });
    expect(parsePaletteQuery("")).toEqual({ actionsOnly: false, words: [] });
  });

  it('lists every action for a bare ">" and filters by label and keywords after it', () => {
    expect(ids(filterActions(actions, parsePaletteQuery(">").words))).toEqual(["new", "git", "pin", "files", "model"]);
    expect(ids(filterActions(actions, parsePaletteQuery(">commit").words))).toEqual(["git"]);
    expect(ids(filterActions(actions, parsePaletteQuery("> opus").words))).toEqual(["model"]);
    expect(ids(filterActions(actions, parsePaletteQuery(">nothing here").words))).toEqual([]);
  });

  it("puts labels that start with the typed text first, keeping order otherwise", () => {
    /* "s" starts "Switch model", starts a word in two labels, and is only inside the others */
    expect(ids(filterActions(actions, ["s"]))).toEqual(["model", "new", "pin", "git", "files"]);
    expect(actionRank({ label: "Pin session" }, "pin")).toBe(0);
    expect(actionRank({ label: "Pin session" }, "session")).toBe(0.5);
    expect(actionRank({ label: "Pin session" }, "")).toBe(1);
  });

  it("needs every word to land somewhere", () => {
    expect(ids(filterActions(actions, ["pin", "favorite"]))).toEqual(["pin"]);
    expect(ids(filterActions(actions, ["pin", "opus"]))).toEqual([]);
  });
});

describe("palette settings group", () => {
  it("finds settings by label, description and keywords, with their section", () => {
    const rows = settingRows(["send", "with"]);
    expect(rows[0]).toMatchObject({ id: "set:sendShortcut", label: "Send with", section: "composer", sectionLabel: "Composer" });
  });

  it(`shows at most ${PALETTE_SETTINGS_MAX} and puts label matches first`, () => {
    const rows = settingRows(["theme"]);
    expect(rows.length).toBeLessThanOrEqual(PALETTE_SETTINGS_MAX);
    expect(rows.length).toBeGreaterThan(0);
    const inLabel = rows.map((r) => r.label.toLowerCase().includes("theme"));
    expect(inLabel).toEqual([...inLabel].sort((a, b) => Number(b) - Number(a)));
    expect(settingRows(["theme"], 2)).toHaveLength(2);
  });

  it("stays quiet for one letter or nothing that matches", () => {
    expect(settingRows([])).toEqual([]);
    expect(settingRows(["t"])).toEqual([]);
    expect(settingRows(["zzzqqq"])).toEqual([]);
  });
});

describe("palette registry", () => {
  it("collects actions and pickers from every source, newest builder per key", () => {
    let pinned = false;
    setPaletteSource("a", () => ({ actions: [{ id: "pin", label: pinned ? "Unpin" : "Pin", icon: "pin", command: "pin", run: () => undefined }] }));
    setPaletteSource("b", () => ({ actions: [], pickers: [{ id: "model", title: "Model", placeholder: "Choose a model…", choices: [{ value: "opus", label: "Opus" }], pick: () => undefined }] }));
    expect(paletteActions().map((a) => a.label)).toEqual(["Pin"]);
    /* builders run at read time, so a row follows the state it was built from */
    pinned = true;
    expect(actionFor("pin")?.label).toBe("Unpin");
    expect(palettePicker("model")?.choices.map((c) => c.value)).toEqual(["opus"]);
    expect(palettePicker("effort")).toBeNull();
    setPaletteSource("a", null);
    setPaletteSource("b", null);
    expect(paletteActions()).toEqual([]);
    expect(actionFor("pin")).toBeNull();
  });
});

const NEW: CommandId[] = ["gitPanel", "changesPanel", "prevSession", "nextSession", "nextNeedsYou", "pin", "archive", "back", "forward", "modelPicker", "modePicker", "effortPicker"];

type Ev = Partial<KeyEventLike> & { key: string };
const ev = (e: Ev): KeyEventLike => ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, code: e.key.length === 1 && /[a-z]/i.test(e.key) ? `Key${e.key.toUpperCase()}` : undefined, ...e });

describe("new session commands", () => {
  it("are registered, rebindable, and have canonical defaults", () => {
    for (const id of NEW) {
      const c = COMMANDS.find((x) => x.id === id);
      expect(c, id).toBeDefined();
      expect(c && "fixed" in c, id).toBe(false);
      expect(c!.keys.length, id).toBeGreaterThan(0);
      for (const k of c!.keys) expect(canonicalChord(k), `${id} ${k}`).toBe(k);
    }
  });

  it("clash with nothing, on a Mac or elsewhere", () => {
    for (const mac of [true, false]) {
      for (const id of NEW) for (const k of keysFor(id, {})) expect(conflictsFor(id, k, {}, mac), `${id} ${k} mac=${mac}`).toEqual([]);
      expect([...allConflicts({}, mac)]).toEqual([]);
    }
  });

  it("avoid keys the browser keeps for itself", () => {
    for (const mac of [true, false]) for (const id of NEW) for (const k of keysFor(id, {})) expect(reservedBy(k, mac), `${id} ${k}`).toBeNull();
  });

  it("fire for the keys they name", () => {
    expect(matchesCommand(ev({ key: "G", metaKey: true, shiftKey: true }), "gitPanel", {}, true)).toBe(true);
    expect(matchesCommand(ev({ key: "D", ctrlKey: true, shiftKey: true }), "changesPanel", {}, false)).toBe(true);
    /* Shift+] types "}" on a US layout; the physical key still counts */
    expect(matchesCommand(ev({ key: "}", code: "BracketRight", ctrlKey: true, shiftKey: true }), "nextSession", {}, false)).toBe(true);
    expect(matchesCommand(ev({ key: "{", code: "BracketLeft", ctrlKey: true, shiftKey: true }), "prevSession", {}, false)).toBe(true);
    expect(matchesCommand(ev({ key: "ArrowDown", altKey: true, shiftKey: true }), "nextSession", {}, true)).toBe(true);
    /* Option+Shift+N types "˜" on a Mac */
    expect(matchesCommand(ev({ key: "˜", code: "KeyN", altKey: true, shiftKey: true }), "nextNeedsYou", {}, true)).toBe(true);
    expect(matchesCommand(ev({ key: "[", code: "BracketLeft", metaKey: true }), "back", {}, true)).toBe(true);
    expect(matchesCommand(ev({ key: "M", ctrlKey: true, shiftKey: true }), "modelPicker", {}, false)).toBe(true);
  });

  it("work from a text field only with Ctrl or Cmd, or Alt keys that don't type ASCII", () => {
    expect(matchesCommand(ev({ key: "M", metaKey: true, shiftKey: true }), "modelPicker", {}, true, true)).toBe(true);
    expect(matchesCommand(ev({ key: "∏", code: "KeyP", altKey: true, shiftKey: true }), "pin", {}, true, true)).toBe(true);
  });
});

type S = { id: string; title: string; mtime: number; cwd: string; project: string; agent: AgentId; pinned?: boolean; archived?: boolean };
const s = (id: string, over: Partial<S> = {}): S => ({ id, title: id, mtime: 0, cwd: "/w/a", project: "a", agent: "claude", ...over });

describe("sidebar order", () => {
  const rows = [
    s("a1", { mtime: 100 }),
    s("b1", { mtime: 400, cwd: "/w/b", project: "b" }),
    s("a2", { mtime: 300 }),
    s("p", { mtime: 50, pinned: true }),
    s("gone", { mtime: 999, archived: true }),
    s("zz", { mtime: 500, cwd: "/w/c", project: "c" }),
  ];

  it("lists Pinned, then projects in their order, without archived ones", () => {
    expect(ids(sidebarOrder(rows, { view: "project", sort: "activity" }))).toEqual(["p", "zz", "b1", "a2", "a1"]);
  });

  it("follows the flat list and its grouping", () => {
    expect(ids(sidebarOrder(rows, { view: "flat", sort: "activity" }))).toEqual(["p", "zz", "b1", "a2", "a1"]);
    expect(ids(sidebarOrder(rows, { view: "flat", sort: "title" }))).toEqual(["p", "a1", "a2", "b1", "zz"]);
  });

  it("leaves out snoozed sessions", () => {
    expect(ids(sidebarOrder(rows, { view: "flat", sort: "activity", asleep: (x) => x.id === "zz" }))).toEqual(["p", "b1", "a2", "a1"]);
  });

  it("steps to the next and previous session, wrapping at the ends", () => {
    const order = ["p", "zz", "b1"];
    expect(stepIn(order, "zz", 1)).toBe("b1");
    expect(stepIn(order, "b1", 1)).toBe("p");
    expect(stepIn(order, "p", -1)).toBe("b1");
    expect(stepIn(order, null, 1)).toBe("p");
    expect(stepIn(order, "elsewhere", -1)).toBe("b1");
    expect(stepIn([], "p", 1)).toBeNull();
  });
});

describe("next session that needs you", () => {
  const order = ["a", "b", "c", "d", "e"];
  const marks: Record<string, Attention> = { a: "later", c: "now", e: "now" };
  const of = (id: string) => marks[id] ?? null;

  it("takes the next approval or question after the open session, wrapping around", () => {
    expect(nextNeedingYou(order, "a", of)).toBe("c");
    expect(nextNeedingYou(order, "c", of)).toBe("e");
    expect(nextNeedingYou(order, "e", of)).toBe("c");
    expect(nextNeedingYou(order, null, of)).toBe("c");
  });

  it("falls back to failed or finished turns once nothing asks", () => {
    expect(nextNeedingYou(order, "b", (id) => (id === "a" || id === "d" ? "later" : null))).toBe("d");
    expect(nextNeedingYou(order, "d", (id) => (id === "a" || id === "d" ? "later" : null))).toBe("a");
  });

  it("never picks the open session itself, and says so when nothing else needs you", () => {
    expect(nextNeedingYou(order, "c", (id) => (id === "c" ? "now" : null))).toBeNull();
    expect(nextNeedingYou([], null, of)).toBeNull();
  });
});
