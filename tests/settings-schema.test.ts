import vm from "node:vm";
import { describe, expect, it } from "vitest";
import {
  DEFAULTS,
  SECTIONS,
  SETTING_KEYS,
  SETTINGS,
  SYNCED_CACHE_KEY,
  decodeStored,
  diffSettings,
  domState,
  encodeStored,
  parseSettingsFile,
  parseValue,
  pickValid,
  prePaintScript,
  searchSettings,
  serializeSettings,
  settingDef,
  settingsIn,
  storageKey,
  validatePatch,
  type SettingDef,
} from "@/lib/settings-schema";

describe("settings registry", () => {
  it("has a valid default, a known section and a label for every setting", () => {
    const sections = new Set(SECTIONS.map((s) => s.id));
    for (const key of SETTING_KEYS) {
      const def = SETTINGS[key] as SettingDef;
      expect(sections.has(def.section), key).toBe(true);
      for (const s of def.alsoIn ?? []) expect(sections.has(s), `${key} alsoIn ${s}`).toBe(true);
      expect(def.label.length, key).toBeGreaterThan(0);
      expect(parseValue(def, def.default), key).toEqual({ ok: true, value: def.default });
      /* UI copy: no em dashes */
      expect(`${def.label} ${def.description ?? ""}`, key).not.toMatch(/\u2014/);
    }
  });

  it("keeps device and synced storage apart", () => {
    const keys = SETTING_KEYS.filter((k) => SETTINGS[k].scope === "device").map(storageKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain(SYNCED_CACHE_KEY);
  });

  it("lists a setting in its own section and the ones it also shows in", () => {
    expect(settingsIn("composer").map((d) => d.key)).toEqual(["sendWithEnter"]);
    expect(settingsIn("conversation").map((d) => d.key)).toEqual([
      "conversationWidth",
      "showTimestamps",
      "timeFormat",
      "workLog",
      "toolCalls",
      "showThinking",
      "turnChanges",
      "turnUndo",
      "autoScroll",
      "streamText",
      "codeLineNumbers",
      "codeWrap",
      "codeCollapse",
    ]);
    expect(settingsIn("general").map((d) => d.key)).toContain("theme");
  });
});

describe("parseValue", () => {
  it("clamps numbers and snaps them to the step", () => {
    const size = settingDef("codeSize");
    expect(parseValue(size, 40)).toEqual({ ok: true, value: 16 });
    expect(parseValue(size, 2)).toEqual({ ok: true, value: 11 });
    expect(parseValue(size, 13.26)).toEqual({ ok: true, value: 13.5 });
    expect(parseValue(settingDef("uiScale"), 113)).toEqual({ ok: true, value: 110 });
    expect(parseValue(size, Number.NaN).ok).toBe(false);
    expect(parseValue(size, "13").ok).toBe(false);
  });

  it("only takes listed choices and real booleans", () => {
    expect(parseValue(settingDef("palette"), "nord")).toEqual({ ok: true, value: "nord" });
    expect(parseValue(settingDef("palette"), "dracula").ok).toBe(false);
    expect(parseValue(settingDef("sendWithEnter"), "true").ok).toBe(false);
    expect(parseValue(settingDef("sendWithEnter"), false)).toEqual({ ok: true, value: false });
  });

  it("normalizes colors and cuts strings to length", () => {
    const color: SettingDef = { type: "color", section: "appearance", label: "c", scope: "synced", default: "#000000" };
    expect(parseValue(color, "#ABC")).toEqual({ ok: true, value: "#aabbcc" });
    expect(parseValue(color, "3b82f6")).toEqual({ ok: true, value: "#3b82f6" });
    expect(parseValue(color, "blue").ok).toBe(false);
    const text: SettingDef = { type: "string", section: "general", label: "s", scope: "synced", default: "", maxLength: 4 };
    expect(parseValue(text, "abcdef")).toEqual({ ok: true, value: "abcd" });
  });
});

describe("validatePatch", () => {
  it("rejects unknown keys and bad values with a reason each", () => {
    const res = validatePatch({ palette: "nope", bogus: 1, accent: "violet" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors).toHaveLength(2);
      expect(res.errors.join(" ")).toMatch(/Unknown setting "bogus"/);
      expect(res.errors.join(" ")).toMatch(/"palette" must be one of/);
    }
  });

  it("refuses settings of the other scope and non-objects", () => {
    expect(validatePatch({ uiScale: 110 }, { scope: "synced" }).ok).toBe(false);
    expect(validatePatch([1, 2]).ok).toBe(false);
    expect(validatePatch(null).ok).toBe(false);
    expect(validatePatch("palette").ok).toBe(false);
  });

  it("clamps numbers and turns null into a reset when allowed", () => {
    expect(validatePatch({ accentHue: 500, accent: null }, { scope: "synced", allowNull: true })).toEqual({ ok: true, values: { accentHue: 360 }, reset: ["accent"] });
    expect(validatePatch({ accent: null }).ok).toBe(false);
  });
});

describe("stored values from earlier versions", () => {
  it("reads the old send-with-Enter, terminal panel and theme formats", () => {
    expect(storageKey("sendWithEnter")).toBe("cui:send-enter");
    expect(decodeStored("sendWithEnter", "1")).toBe(true);
    expect(decodeStored("sendWithEnter", "0")).toBe(false);
    expect(decodeStored("sendWithEnter", null)).toBe(false);

    expect(storageKey("terminalDocked")).toBe("cui:term-docked");
    expect(decodeStored("terminalDocked", "sheet")).toBe(false);
    expect(decodeStored("terminalDocked", "dock")).toBe(true);
    expect(decodeStored("terminalDocked", "anything")).toBe(true);
    expect(decodeStored("terminalDocked", null)).toBe(true);

    expect(storageKey("theme")).toBe("bui-theme");
    expect(decodeStored("theme", "light")).toBe("light");
    expect(decodeStored("theme", "system")).toBe("system");
    expect(decodeStored("theme", "dark")).toBe("dark");
    expect(decodeStored("theme", "sepia")).toBe("dark");

    expect(storageKey("newSessionWorktree")).toBe("cui:worktree");
    expect(decodeStored("newSessionWorktree", "1")).toBe(true);
  });

  it("writes those keys back in their old format", () => {
    expect(encodeStored("sendWithEnter", true)).toBe("1");
    expect(encodeStored("terminalDocked", false)).toBe("sheet");
    expect(encodeStored("terminalDocked", true)).toBe("dock");
    expect(encodeStored("theme", "light")).toBe("light");
  });

  it("stores new device settings as JSON and falls back on anything unreadable", () => {
    expect(storageKey("uiScale")).toBe("cui:set:uiScale");
    expect(encodeStored("uiScale", 110)).toBe("110");
    expect(decodeStored("uiScale", "110")).toBe(110);
    expect(decodeStored("uiScale", "{oops")).toBe(100);
    expect(decodeStored("uiScale", "999")).toBe(120);
    expect(decodeStored("density", '"cozy"')).toBe("comfortable");
  });

  it("drops what an older or newer build can't read", () => {
    expect(pickValid({ palette: "nord", zoom: 3, accent: 7 }, "synced")).toEqual({ values: { palette: "nord" }, skipped: ["zoom", "accent"] });
    expect(pickValid({ uiScale: 110 }, "synced")).toEqual({ values: {}, skipped: ["uiScale"] });
  });
});

describe("export and import", () => {
  it("round-trips every setting", () => {
    const values = { ...DEFAULTS, palette: "nord", accent: "custom", accentHue: 140, uiScale: 120, sendWithEnter: true, theme: "light" } as const;
    const parsed = parseSettingsFile(serializeSettings(values, new Date(0)));
    expect(parsed).toEqual({ ok: true, values, skipped: [] });
  });

  it("takes a bare object, skips what it doesn't know, and refuses non-settings files", () => {
    expect(parseSettingsFile('{"palette":"github","later":true}')).toEqual({ ok: true, values: { palette: "github" }, skipped: ["later"] });
    expect(parseSettingsFile("not json").ok).toBe(false);
    expect(parseSettingsFile("[1]").ok).toBe(false);
    expect(parseSettingsFile('{"hello":"world"}').ok).toBe(false);
  });

  it("describes changes in words", () => {
    expect(diffSettings(DEFAULTS, { palette: "nord", sendWithEnter: false, uiScale: 110 })).toEqual([
      { key: "palette", label: "Palette", from: "Default", to: "Nord" },
      { key: "uiScale", label: "Interface size", from: "100%", to: "110%" },
    ]);
  });
});

describe("search", () => {
  it("matches labels, descriptions, keywords and section items", () => {
    expect(searchSettings("dark mode")).toEqual([{ section: "appearance", settings: ["theme"], items: [] }]);
    expect(searchSettings("zoom")[0].settings).toEqual(["uiScale"]);
    expect(searchSettings("logout")).toEqual([{ section: "general", settings: [], items: ["sign-out", "sign-out-everywhere"] }]);
    expect(searchSettings("revoke")).toEqual([{ section: "general", settings: [], items: ["sign-out-everywhere"] }]);
    expect(searchSettings("export").map((h) => h.section)).toContain("data");
    expect(searchSettings("   ")).toEqual([]);
    expect(searchSettings("zzzz")).toEqual([]);
  });
});

describe("appearance on <html>", () => {
  it("sets nothing for defaults", () => {
    const s = domState(DEFAULTS, false);
    expect(s).toEqual({ dark: true, attrs: {}, vars: {}, themeColor: "#151619" });
  });

  it("maps values to attributes and variables", () => {
    const s = domState({ ...DEFAULTS, theme: "system", palette: "nord", accent: "custom", accentHue: 140, uiScale: 110, codeSize: 14, increaseContrast: true }, false);
    expect(s.dark).toBe(false);
    expect(s.themeColor).toBe("#eceff4");
    expect(s.attrs).toEqual({ "data-palette": "nord", "data-accent": "custom", "data-ui-scale": "110", "data-code-size": "14", "data-contrast": "on" });
    expect(s.vars).toEqual({ "--ah": "140", "--ui-scale": "1.1", "--code-size": "14px" });
  });

  it("keeps the custom hue off unless the accent is custom", () => {
    expect(domState({ ...DEFAULTS, accent: "violet", accentHue: 10 }, true).vars).toEqual({});
  });
});

describe("pre-paint script", () => {
  function run(storage: Record<string, string>, prefersDark = false, throwing = false) {
    const attrs: Record<string, string> = {};
    const vars: Record<string, string> = {};
    const classes = new Set<string>();
    const meta = { content: "" };
    const ctx = {
      localStorage: {
        getItem: (k: string) => {
          if (throwing) throw new Error("denied");
          return k in storage ? storage[k] : null;
        },
      },
      matchMedia: () => ({ matches: prefersDark }),
      document: {
        documentElement: {
          classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)) },
          setAttribute: (k: string, v: string) => (attrs[k] = v),
          style: { setProperty: (k: string, v: string) => (vars[k] = v) },
        },
        querySelector: () => ({ setAttribute: (_: string, v: string) => (meta.content = v) }),
      },
    };
    vm.runInNewContext(prePaintScript(), ctx);
    return { attrs, vars, dark: classes.has("dark"), theme: meta.content };
  }

  it("applies the defaults when nothing is stored", () => {
    expect(run({})).toEqual({ attrs: {}, vars: {}, dark: true, theme: "#151619" });
  });

  it("reads the old theme key, device keys and the synced cache", () => {
    const out = run({
      "bui-theme": "system",
      "cui:set:uiScale": "120",
      "cui:set:density": '"compact"',
      [SYNCED_CACHE_KEY]: JSON.stringify({ palette: "github", accent: "custom", accentHue: 30, showTimestamps: true }),
    });
    expect(out.dark).toBe(false);
    expect(out.theme).toBe("#ffffff");
    expect(out.attrs).toEqual({ "data-palette": "github", "data-accent": "custom", "data-ui-scale": "120", "data-density": "compact", "data-timestamps": "on" });
    expect(out.vars).toEqual({ "--ah": "30", "--ui-scale": "1.2" });
  });

  it("matches domState for the same values", () => {
    const values = { ...DEFAULTS, theme: "dark", palette: "rose-pine", codeSize: 15, corners: "round", reduceMotion: "on" } as const;
    const storage: Record<string, string> = { [SYNCED_CACHE_KEY]: JSON.stringify(Object.fromEntries(SETTING_KEYS.filter((k) => SETTINGS[k].scope === "synced").map((k) => [k, values[k]]))) };
    for (const k of SETTING_KEYS) if (SETTINGS[k].scope === "device") storage[storageKey(k)] = encodeStored(k, values[k]);
    const s = domState(values, false);
    expect(run(storage)).toEqual({ attrs: s.attrs, vars: s.vars, dark: s.dark, theme: s.themeColor });
  });

  it("ignores garbage and survives storage that throws", () => {
    expect(run({ "bui-theme": "light", "cui:set:uiScale": "500", "cui:set:codeSize": "x", [SYNCED_CACHE_KEY]: '{"palette":"evil\\"><script>"}' })).toEqual({ attrs: {}, vars: {}, dark: false, theme: "#fcfcfd" });
    expect(run({ [SYNCED_CACHE_KEY]: "{broken" }).attrs).toEqual({});
    expect(run({}, false, true).dark).toBe(true);
  });

  it("stays small", () => {
    expect(prePaintScript().length).toBeLessThan(4000);
  });
});
