import { describe, expect, it } from "vitest";
import { choiceMs, DEFAULT_FETCH_INTERVAL_MS, fetchIntervalLabel, parseFetchInterval } from "@/lib/git-interval";
import { DEFAULTS, parseServerDefaults, parseSettingsFile, serializeSettings, settingDef, shownOptions, formatValue, type EnumSetting } from "@/lib/settings-schema";

const def = settingDef("gitFetchInterval") as EnumSetting;
const shown = (value: string, ms?: number) => shownOptions("gitFetchInterval", def.options, value, ms === undefined ? {} : { gitFetchIntervalMs: ms }).map((o) => `${o.value}=${o.label}`);

describe("GIT_FETCH_INTERVAL_MS", () => {
  it("reads ms, falling back to a minute", () => {
    expect(parseFetchInterval(undefined)).toBe(DEFAULT_FETCH_INTERVAL_MS);
    expect(parseFetchInterval(" 300000 ")).toBe(300_000);
    expect(parseFetchInterval("0")).toBe(0);
    expect(parseFetchInterval("soon")).toBe(60_000);
    expect(parseFetchInterval("-5")).toBe(60_000);
  });

  it("maps choices to ms, and the server default to null", () => {
    expect(choiceMs("server")).toBeNull();
    expect(choiceMs("off")).toBe(0);
    expect(choiceMs("1")).toBe(60_000);
    expect(choiceMs("15")).toBe(900_000);
  });

  it("labels any interval the way the options do", () => {
    expect(fetchIntervalLabel(0)).toBe("Off");
    expect(fetchIntervalLabel(60_000)).toBe("Every minute");
    expect(fetchIntervalLabel(300_000)).toBe("Every 5 minutes");
    expect(fetchIntervalLabel(30_000)).toBe("Every 30 seconds");
    expect(fetchIntervalLabel(90_000)).toBe("Every 90 seconds");
    expect(fetchIntervalLabel(7_200_000)).toBe("Every 2 hours");
    for (const o of def.options) if (o.value !== "server") expect(fetchIntervalLabel(choiceMs(o.value)!)).toBe(o.label);
  });
});

describe("Check the remote, unchanged", () => {
  it("defaults to the server's own interval", () => {
    expect(DEFAULTS.gitFetchInterval).toBe("server");
  });

  it("shows the server's value as the default, folding the option that does the same", () => {
    expect(shown("server", 300_000)).toEqual(["server=Every 5 minutes (default)", "off=Off", "1=Every minute", "15=Every 15 minutes"]);
    expect(shown("server", 60_000)[0]).toBe("server=Every minute (default)");
    expect(shown("server", 0)).toEqual(["server=Off (default)", "1=Every minute", "5=Every 5 minutes", "15=Every 15 minutes"]);
    expect(shown("server", 120_000)).toHaveLength(def.options.length);
    expect(shown("server", 120_000)[0]).toBe("server=Every 2 minutes (default)");
  });

  it("keeps the picked option even when it matches the server", () => {
    expect(shown("5", 300_000)).toContain("5=Every 5 minutes");
  });

  it("says Server default until the server has answered", () => {
    expect(shown("server")).toEqual(def.options.map((o) => `${o.value}=${o.label}`));
    expect(formatValue(def, "server")).toBe("Server default");
  });

  it("reads only the defaults this build knows", () => {
    expect(parseServerDefaults({ gitFetchIntervalMs: 300_000, future: 1 })).toEqual({ gitFetchIntervalMs: 300_000 });
    expect(parseServerDefaults({ gitFetchIntervalMs: -1 })).toEqual({});
    expect(parseServerDefaults("x")).toEqual({});
    expect(parseServerDefaults(null)).toEqual({});
  });

  it("exports and imports as the server default, not a fixed interval", () => {
    const parsed = parseSettingsFile(serializeSettings(DEFAULTS));
    expect(parsed.ok && parsed.values.gitFetchInterval).toBe("server");
    const old = parseSettingsFile(JSON.stringify({ settings: { gitFetchInterval: "1" } }));
    expect(old.ok && old.values.gitFetchInterval).toBe("1");
  });
});
