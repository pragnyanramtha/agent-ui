import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS, SETTINGS, SETTING_KEYS, type SettingDef } from "@/lib/settings-schema";

/* Settings that default otherwise on touch screens: the registry keeps one default, the device decides until the
 * user picks a value. */

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
let coarse = false;

beforeEach(() => {
  const win = new EventTarget() as EventTarget & Record<string, unknown>;
  win.matchMedia = (q: string) => ({ matches: q === "(pointer: coarse)" ? coarse : false, addEventListener() {}, removeEventListener() {} });
  win.location = { pathname: "/" };
  g.window = win;
  g.localStorage = new MemStorage();
  g.document = { documentElement: { classList: { add() {}, remove() {}, contains: () => false, toggle() {} }, getAttribute: () => null, setAttribute() {}, removeAttribute() {}, style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => "" } }, querySelector: () => null };
  g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
  g.fetch = vi.fn(async () => Response.json({ settings: {} }));
});

async function load() {
  vi.resetModules();
  return import("@/lib/client/settings");
}

describe("touch defaults", () => {
  it("only device settings have them, and the registry default stays the plain one", () => {
    for (const key of SETTING_KEYS) {
      const d = SETTINGS[key] as SettingDef;
      if (d.touchDefault !== undefined) expect(d.scope).toBe("device");
    }
    expect(DEFAULTS.diffWrap).toBe(false);
    expect(DEFAULTS.composerCollapseOnScroll).toBe(false);
    expect(DEFAULTS.touchGestures).toBe(true);
  });

  it("pick the touch default on a coarse pointer and the registry's otherwise", async () => {
    const s = await load();
    expect(s.effectiveDefault("diffWrap", true)).toBe(true);
    expect(s.effectiveDefault("diffWrap", false)).toBe(false);
    expect(s.effectiveDefault("composerCollapseOnScroll", true)).toBe(true);
    expect(s.effectiveDefault("sendShortcut", true)).toBe(DEFAULTS.sendShortcut);
  });

  it("wrap diffs on a phone until the user turns it off", async () => {
    coarse = true;
    const s = await load();
    expect(s.getSetting("diffWrap")).toBe(true);
    s.setSetting("diffWrap", false);
    expect(s.getSetting("diffWrap")).toBe(false);
    expect((g.localStorage as MemStorage).getItem("agent-u:diff-wrap")).toBe("off");
    /* reset goes back to what this device defaults to, and the section reads as default again */
    s.resetSettings(["diffWrap"]);
    expect(s.getSetting("diffWrap")).toBe(true);
    expect(s.sectionIsDefault(s.getSettings(), "git")).toBe(true);
  });

  it("leave a desktop as it was, and keep a choice made on it", async () => {
    coarse = false;
    const s = await load();
    expect(s.getSetting("diffWrap")).toBe(false);
    expect(s.getSetting("composerCollapseOnScroll")).toBe(false);
    (g.localStorage as MemStorage).setItem("agent-u:diff-wrap", "on");
    expect(s.getSetting("diffWrap")).toBe(true);
    expect(s.sectionIsDefault(s.getSettings(), "git")).toBe(false);
  });
});
