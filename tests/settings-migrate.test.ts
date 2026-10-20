import { describe, expect, it } from "vitest";
import { migrateDeviceSettings } from "@/lib/client/settings-migrate";
import { decodeStored, storageKey } from "@/lib/settings-schema";

const store = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
};
const read = (s: ReturnType<typeof store>) => ({
  layout: decodeStored("diffLayout", s.getItem(storageKey("diffLayout"))),
  ws: decodeStored("diffIgnoreWhitespace", s.getItem(storageKey("diffIgnoreWhitespace"))),
  wrap: decodeStored("diffWrap", s.getItem(storageKey("diffWrap"))),
});

describe("device settings migration", () => {
  it("moves the old combined diff key into the layout and whitespace settings, then drops it", () => {
    const s = store({ "agent-u:diff": JSON.stringify({ split: true, ws: true }) });
    migrateDeviceSettings(s);
    expect(read(s)).toEqual({ layout: "split", ws: true, wrap: false });
    expect(s.m.has("agent-u:diff")).toBe(false);
  });

  it("never overwrites a choice made since", () => {
    const s = store({ "agent-u:diff": JSON.stringify({ split: true, ws: true }), "agent-u:diff-whitespace": "show", "agent-u:diff-layout": "unified" });
    migrateDeviceSettings(s);
    expect(read(s)).toEqual({ layout: "unified", ws: false, wrap: false });
  });

  it("keeps the per-key values the diff viewer already wrote", () => {
    const s = store({ "agent-u:diff-layout": "split", "agent-u:diff-whitespace": "hide", "agent-u:diff-wrap": "on" });
    migrateDeviceSettings(s);
    expect(read(s)).toEqual({ layout: "split", ws: true, wrap: true });
    expect(Object.fromEntries(s.m)).toEqual({ "agent-u:diff-layout": "split", "agent-u:diff-whitespace": "hide", "agent-u:diff-wrap": "on" });
  });

  it("drops an unreadable old key and leaves defaults", () => {
    const s = store({ "agent-u:diff": "{not json" });
    migrateDeviceSettings(s);
    expect(read(s)).toEqual({ layout: "unified", ws: false, wrap: false });
    expect(s.m.size).toBe(0);
  });

  it("is safe to rerun and survives a storage that throws", () => {
    const s = store({ "agent-u:diff": JSON.stringify({ split: true }) });
    migrateDeviceSettings(s);
    migrateDeviceSettings(s);
    expect(read(s).layout).toBe("split");
    const bad = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };
    expect(() => migrateDeviceSettings(bad)).not.toThrow();
  });
});
