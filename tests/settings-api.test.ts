import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-u-settings-"));
process.env.AGENT_U_SETTINGS = path.join(dir, "nested", "settings.json");
const { GET, PUT } = await import("@/app/api/settings/route");
const { SETTINGS_PATH, readSynced, updateSynced } = await import("@/lib/server/settings");

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
beforeEach(() => fs.rmSync(path.dirname(SETTINGS_PATH), { recursive: true, force: true }));

const put = (body: string) => PUT(new NextRequest("http://x/api/settings", { method: "PUT", body, headers: { "content-type": "application/json" } }));

describe("GET /api/settings", () => {
  it("answers defaults (an empty object) before anything is saved", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ settings: {}, updatedAt: 0, defaults: { gitFetchIntervalMs: 60_000 } });
  });

  it("names the server's own default for Check the remote", async () => {
    const saved = process.env.GIT_FETCH_INTERVAL_MS;
    try {
      process.env.GIT_FETCH_INTERVAL_MS = "300000";
      expect((await GET().json()).defaults).toEqual({ gitFetchIntervalMs: 300_000 });
      process.env.GIT_FETCH_INTERVAL_MS = "0";
      expect((await GET().json()).defaults).toEqual({ gitFetchIntervalMs: 0 });
    } finally {
      if (saved === undefined) delete process.env.GIT_FETCH_INTERVAL_MS;
      else process.env.GIT_FETCH_INTERVAL_MS = saved;
    }
  });
});

describe("PUT /api/settings", () => {
  it("merges patches and resets keys set to null", async () => {
    let res = await put(JSON.stringify({ palette: "nord", accent: "violet" }));
    expect(res.status).toBe(200);
    expect((await res.json()).settings).toEqual({ palette: "nord", accent: "violet" });
    res = await put(JSON.stringify({ accent: null, corners: "round" }));
    const body = await res.json();
    expect(body.settings).toEqual({ palette: "nord", corners: "round" });
    expect(body.updatedAt).toBeGreaterThan(0);
    expect((await GET().json()).settings).toEqual({ palette: "nord", corners: "round" });
  });

  it("normalizes colors", async () => {
    const res = await put(JSON.stringify({ accentColor: "#ABC" }));
    expect((await res.json()).settings).toEqual({ accentColor: "#aabbcc" });
  });

  it("answers 400 and keeps the file for unknown keys, bad values, device settings and bad bodies", async () => {
    await put(JSON.stringify({ palette: "github" }));
    const before = fs.readFileSync(SETTINGS_PATH, "utf8");
    for (const body of ['{"nope":1}', '{"palette":"dracula"}', '{"uiScale":110}', '{"showTimestamps":"yes"}', "[1]", "not json", "", '"palette"']) {
      const res = await put(body);
      expect(res.status, body).toBe(400);
      expect((await res.json()).error, body).toBeTruthy();
    }
    expect(fs.readFileSync(SETTINGS_PATH, "utf8")).toBe(before);
  });
});

describe("settings file", () => {
  it("is written atomically with private permissions and no temp files left", () => {
    updateSynced({ palette: "solarized" });
    updateSynced({ codeFont: "fira-code" });
    expect(fs.statSync(SETTINGS_PATH).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(SETTINGS_PATH))).toEqual(["settings.json"]);
    expect(JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")).settings).toEqual({ palette: "solarized", codeFont: "fira-code" });
  });

  it("keeps the old file and cleans up when a save fails halfway", () => {
    updateSynced({ palette: "nord" });
    const spy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("disk full");
    });
    try {
      expect(() => updateSynced({ palette: "github" })).toThrow("disk full");
    } finally {
      spy.mockRestore();
    }
    expect(fs.readdirSync(path.dirname(SETTINGS_PATH))).toEqual(["settings.json"]);
    expect(readSynced().settings).toEqual({ palette: "nord" });
  });

  it("reads a damaged or foreign file as defaults and keeps only valid known values", () => {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, "{ not json");
    expect(readSynced()).toEqual({ settings: {}, updatedAt: 0 });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify({ settings: { palette: "nord", accent: 3, future: "x", uiScale: 110 }, updatedAt: 5 }));
    expect(readSynced()).toEqual({ settings: { palette: "nord" }, updatedAt: 5 });
    expect(updateSynced({ corners: "sharp" })).toMatchObject({ ok: true, file: { settings: { palette: "nord", corners: "sharp" } } });
  });
});
