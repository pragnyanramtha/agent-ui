import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/* The browser store against the real /api/settings handlers: a small fake window, localStorage and <html>. */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-u-settings-client-"));
process.env.AGENT_U_SETTINGS = path.join(dir, "settings.json");
const route = await import("@/app/api/settings/route");
const server = await import("@/lib/server/settings");

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

function fakeRoot() {
  const classes = new Set<string>();
  const attrs = new Map<string, string>();
  const vars = new Map<string, string>();
  return {
    classes,
    attrs,
    vars,
    classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c), contains: (c: string) => classes.has(c), toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)) },
    getAttribute: (k: string) => attrs.get(k) ?? null,
    setAttribute: (k: string, v: string) => attrs.set(k, v),
    removeAttribute: (k: string) => attrs.delete(k),
    style: { setProperty: (k: string, v: string) => vars.set(k, v), removeProperty: (k: string) => vars.delete(k), getPropertyValue: (k: string) => vars.get(k) ?? "" },
  };
}

let root: ReturnType<typeof fakeRoot>;
let net: "up" | "down" | "refuse" = "up";
const g = globalThis as Record<string, unknown>;

async function fakeFetch(url: string, init?: RequestInit) {
  if (net === "down") throw new TypeError("Failed to fetch");
  if (net === "refuse" && init?.method === "PUT") return Response.json({ error: "no" }, { status: 400 });
  return init?.method === "PUT" ? route.PUT(new NextRequest(`http://x${url}`, init as ConstructorParameters<typeof NextRequest>[1])) : route.GET();
}

async function load() {
  vi.resetModules();
  return import("@/lib/client/settings");
}

beforeEach(() => {
  fs.rmSync(server.SETTINGS_PATH, { force: true });
  net = "up";
  root = fakeRoot();
  const win = new EventTarget() as EventTarget & Record<string, unknown>;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.location = { pathname: "/" };
  g.window = win;
  g.localStorage = new MemStorage();
  g.document = { documentElement: root, querySelector: () => null, visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
  g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
  g.fetch = vi.fn(fakeFetch);
});

afterAll(() => {
  /* retry timers may still fire after the last test; they find a quiet fake window */
  net = "down";
  fs.rmSync(dir, { recursive: true, force: true });
});

const ls = () => g.localStorage as MemStorage;

describe("client settings store", () => {
  it("keeps the choices people made before the registry", async () => {
    ls().setItem("cui:send-enter", "1");
    ls().setItem("cui:term-docked", "sheet");
    ls().setItem("bui-theme", "light");
    const s = await load();
    expect(s.getSetting("sendWithEnter")).toBe(true);
    expect(s.getSetting("terminalDocked")).toBe(false);
    expect(s.getSetting("theme")).toBe("light");
    s.setSetting("terminalDocked", true);
    expect(ls().getItem("cui:term-docked")).toBe("dock");
    s.applyTheme("system");
    expect(ls().getItem("bui-theme")).toBe("system");
  });

  it("shows synced changes at once, puts them on <html>, then saves them on the server", async () => {
    const s = await load();
    const seen = vi.fn();
    (g.window as EventTarget).addEventListener("agent-u:settings", seen);
    s.setSetting("palette", "nord");
    s.setSetting("accent", "custom");
    s.setSetting("accentHue", 140);
    expect(s.getSetting("palette")).toBe("nord");
    expect(seen).toHaveBeenCalled();
    expect(root.attrs.get("data-palette")).toBe("nord");
    expect(root.vars.get("--ah")).toBe("140");
    expect(JSON.parse(ls().getItem("cui:synced")!)).toEqual({ palette: "nord", accent: "custom", accentHue: 140 });
    await s.flush();
    expect(server.readSynced().settings).toEqual({ palette: "nord", accent: "custom", accentHue: 140 });
    expect(ls().getItem("cui:synced-pending")).toBeNull();
    /* one merged request, not one per change */
    expect((g.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
  });

  it("keeps device settings out of the server", async () => {
    const s = await load();
    s.setSetting("uiScale", 120);
    await s.flush();
    expect(ls().getItem("cui:set:uiScale")).toBe("120");
    expect(fs.existsSync(server.SETTINGS_PATH)).toBe(false);
    expect(root.attrs.get("data-ui-scale")).toBe("120");
    expect(root.vars.get("--ui-scale")).toBe("1.2");
  });

  it("holds changes made offline across a reload and sends them once the server answers", async () => {
    let s = await load();
    net = "down";
    s.setSetting("corners", "round");
    await s.flush();
    expect(JSON.parse(ls().getItem("cui:synced-pending")!)).toEqual({ corners: "round" });
    expect(fs.existsSync(server.SETTINGS_PATH)).toBe(false);

    net = "up";
    s = await load();
    await s.pull(true);
    /* the server has nothing yet; the unsent change still wins */
    expect(s.getSetting("corners")).toBe("round");
    await s.flush();
    expect(server.readSynced().settings).toEqual({ corners: "round" });
  });

  it("takes the server's values on pull without losing unsent local ones", async () => {
    server.updateSynced({ accent: "violet", palette: "github" });
    const s = await load();
    s.setSetting("palette", "midnight");
    await s.pull(true);
    expect(s.getSetting("accent")).toBe("violet");
    expect(s.getSetting("palette")).toBe("midnight");
    await s.flush();
    expect(server.readSynced().settings).toEqual({ accent: "violet", palette: "midnight" });
  });

  it("drops changes the server refuses and goes back to its copy", async () => {
    server.updateSynced({ palette: "github" });
    const s = await load();
    net = "refuse";
    s.setSetting("palette", "nord");
    await s.flush();
    await new Promise((r) => setTimeout(r, 0));
    expect(ls().getItem("cui:synced-pending")).toBeNull();
    expect(s.getSetting("palette")).toBe("github");
  });

  it("resets one section, and everything", async () => {
    const s = await load();
    s.setSettings({ palette: "nord", density: "compact", sendWithEnter: true });
    s.resetSection("appearance");
    expect(s.getSetting("palette")).toBe("default");
    expect(s.getSetting("density")).toBe("comfortable");
    expect(s.getSetting("sendWithEnter")).toBe(true);
    expect(root.attrs.size).toBe(0);
    await s.flush();
    expect(server.readSynced().settings).toEqual({});
    s.resetAllSettings();
    expect(s.getSetting("sendWithEnter")).toBe(false);
    expect(ls().getItem("cui:send-enter")).toBeNull();
  });

  it("round-trips export and import, and can undo an import", async () => {
    const s = await load();
    s.setSettings({ palette: "catppuccin", accent: "teal", uiFont: "inter", codeSize: 14, theme: "light", terminalDocked: false, showTimestamps: true });
    const file = s.exportSettings();
    const before = s.getSettings();
    s.resetAllSettings();
    expect(s.getSetting("palette")).toBe("default");

    const res = s.importSettings(file);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.changes.map((c) => c.key).sort()).toEqual(["accent", "codeSize", "palette", "showTimestamps", "terminalDocked", "theme", "uiFont"]);
    expect(res.changes.find((c) => c.key === "palette")).toEqual({ key: "palette", label: "Palette", from: "Default", to: "Catppuccin" });
    expect(s.getSettings()).toEqual(before);

    s.setSettings(res.previous);
    expect(s.getSetting("palette")).toBe("default");
    expect(s.getSetting("terminalDocked")).toBe(true);

    expect(s.importSettings("{}").ok).toBe(false);
    expect(s.importSettings(file.replace('"catppuccin"', '"dracula"'))).toMatchObject({ ok: true, skipped: ["palette"] });
  });

  it("gives useSyncExternalStore the same object until something changes", async () => {
    const s = await load();
    const a = s.getSettings();
    expect(s.getSettings()).toBe(a);
    s.setSetting("density", "spacious");
    expect(s.getSettings()).not.toBe(a);
    expect(s.getSettings().density).toBe("spacious");
  });
});
