import { describe, expect, it } from "vitest";
import { DIFF_PREF_KEYS, readDiffPrefs, writeDiffPrefs } from "@/lib/client/diff-prefs";

const store = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};

describe("diff prefs", () => {
  it("default to unified, whitespace shown, no wrap", () => {
    expect(readDiffPrefs(store())).toEqual({ split: false, ws: false, wrap: false });
  });

  it("round-trip through one key each", () => {
    const s = store();
    writeDiffPrefs(s, { split: true, ws: true, wrap: true });
    expect(Object.fromEntries(s.m)).toEqual({ [DIFF_PREF_KEYS.layout]: "split", [DIFF_PREF_KEYS.whitespace]: "hide", [DIFF_PREF_KEYS.wrap]: "on" });
    expect(readDiffPrefs(s)).toEqual({ split: true, ws: true, wrap: true });
    writeDiffPrefs(s, { split: false, ws: false, wrap: false });
    expect(readDiffPrefs(s)).toEqual({ split: false, ws: false, wrap: false });
  });

  it("carry over the old combined key until the new ones are written", () => {
    expect(readDiffPrefs(store({ "agent-u:diff": JSON.stringify({ ws: true, split: true }) }))).toEqual({ split: true, ws: true, wrap: false });
    expect(readDiffPrefs(store({ "agent-u:diff": JSON.stringify({ ws: true }), [DIFF_PREF_KEYS.whitespace]: "show" }))).toMatchObject({ ws: false });
    expect(readDiffPrefs(store({ "agent-u:diff": "{not json" }))).toEqual({ split: false, ws: false, wrap: false });
  });

  it("survive a storage that throws", () => {
    const bad = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(readDiffPrefs(bad)).toEqual({ split: false, ws: false, wrap: false });
    expect(() => writeDiffPrefs(bad, { split: true, ws: false, wrap: false })).not.toThrow();
  });
});
