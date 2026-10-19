import { describe, expect, it } from "vitest";
import { BIG_FILE_LINES, fileStartsOpen } from "@/lib/client/diff-prefs";
import { autoOpenStep, editCount, type TurnStart } from "@/lib/client/useAutoOpenDiff";
import { DEFAULTS, searchSettings } from "@/lib/settings-schema";

describe("which diff files start open", () => {
  it("collapses only large files by default", () => {
    expect(DEFAULTS.diffFileState).toBe("large");
    expect(fileStartsOpen("large", BIG_FILE_LINES)).toBe(true);
    expect(fileStartsOpen("large", BIG_FILE_LINES + 1)).toBe(false);
  });

  it("opens or folds every file when asked", () => {
    expect(fileStartsOpen("expanded", 10_000)).toBe(true);
    expect(fileStartsOpen("collapsed", 1)).toBe(false);
  });
});

describe("opening changes after a turn", () => {
  const look = (start: TurnStart, busy: boolean, edits: number, session = "s1", on = true) => autoOpenStep(start, { session, busy, edits, on });

  it("opens when a running turn ends with more edits than it started with", () => {
    let s = look(null, true, 2);
    expect(s).toEqual({ start: { session: "s1", edits: 2 }, open: false });
    s = look(s.start, true, 5);
    expect(s.start).toEqual({ session: "s1", edits: 2 });
    expect(look(s.start, false, 5)).toEqual({ start: null, open: true });
  });

  it("stays shut for turns that edited nothing, when off, and on sessions it didn't see running", () => {
    expect(look(look(null, true, 3).start, false, 3).open).toBe(false);
    expect(look(look(null, true, 3).start, false, 4, "s1", false).open).toBe(false);
    expect(look(null, false, 9).open).toBe(false);
  });

  it("doesn't carry a turn over to another session", () => {
    const s = look(null, true, 1, "s1");
    expect(look(s.start, false, 4, "s2").open).toBe(false);
    expect(look(s.start, true, 0, "s2").start).toEqual({ session: "s2", edits: 0 });
  });

  it("counts edits across files", () => {
    const f = (n: number) => ({ path: `/f${n}`, edits: Array.from({ length: n }, () => ({})), added: 0, removed: 0, last: "" });
    expect(editCount([f(1), f(3)] as never)).toBe(4);
  });
});

describe("workflow settings in search", () => {
  it("finds the new rows by what people call them", () => {
    expect(searchSettings("vscode")[0].settings).toContain("editorLink");
    expect(searchSettings("rate limit").flatMap((h) => h.settings)).toContain("limitAction");
    expect(searchSettings("star").flatMap((h) => h.settings)).toContain("favoriteModels");
  });
});
