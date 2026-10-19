import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { monogram, monogramColors, PROJECT_TINTS, tintIndex } from "@/lib/project-identity";
import { chipModel, lastSeenModel, seenModel } from "@/lib/model-chip";
import { createFlip, flipDelta, FLIP_MAX_ROWS, planFlip, remaining } from "@/lib/client/flip";
import { clampSidebarWidth, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, sidebarKeyWidth, sidebarMax } from "@/lib/sidebar-width";
import { clearProjectCaches, findProjectIcon, projectBranch, projectIcon } from "@/lib/server/project-icon";
import { DEFAULTS, domState, parseValue, settingDef } from "@/lib/settings-schema";
import type { Entry } from "@/lib/types";

describe("project monograms", () => {
  it("takes two letters from the name", () => {
    expect(monogram("agent-ui")).toBe("AU");
    expect(monogram("myProject")).toBe("MP");
    expect(monogram("workspace")).toBe("WO");
    expect(monogram("web3")).toBe("W3");
    expect(monogram("x")).toBe("X");
    expect(monogram("  my_cool.app ")).toBe("MC");
    expect(monogram("über-tool")).toBe("ÜT");
    expect(monogram("---")).toBe("");
    expect(monogram("")).toBe("");
  });

  it("picks the same theme tint for the same name, whatever the case", () => {
    expect(tintIndex("agent-u")).toBe(tintIndex("Agent-U "));
    for (const n of ["a", "agent-u", "workspace", "web", "", "日本"]) {
      const i = tintIndex(n);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(PROJECT_TINTS.length);
    }
    /* names spread over more than one tint */
    expect(new Set(["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"].map(tintIndex)).size).toBeGreaterThan(2);
  });

  it("colors through theme tokens, so light and dark both hold", () => {
    const c = monogramColors("agent-u");
    const tint = PROJECT_TINTS[tintIndex("agent-u")];
    expect(c.color).toBe(`color-mix(in oklch, var(${tint}) 78%, var(--ink))`);
    expect(c.background).toBe(`color-mix(in oklch, var(${tint}) 16%, transparent)`);
  });
});

describe("model chip", () => {
  const profile = (defaultModel: string | null, models: string[] = []) => ({ defaultModel, models });

  it("names the picked model first", () => {
    expect(chipModel("opus", profile("sonnet"), "claude-haiku-4-5")).toEqual({ model: "opus", from: "picked" });
  });

  it("on Default, names the profile's default, then its first model", () => {
    expect(chipModel(null, profile("gpt-5.5", ["gpt-5"]), "gpt-4")).toEqual({ model: "gpt-5.5", from: "profile" });
    expect(chipModel("", profile(null, ["gpt-5"]), "gpt-4")).toEqual({ model: "gpt-5", from: "profile" });
  });

  it("then the model the session last reported, then the agent", () => {
    expect(chipModel(null, profile(null), "claude-opus-4-5-20251101")).toEqual({ model: "claude-opus-4-5-20251101", from: "seen" });
    expect(chipModel(null, undefined, " ")).toEqual({ model: null, from: "agent" });
    expect(chipModel(undefined, null, null)).toEqual({ model: null, from: "agent" });
  });

  it("ignores the stand-ins agents write when they don't know", () => {
    expect(seenModel("<synthetic>")).toBeNull();
    expect(seenModel("cursor")).toBeNull();
    expect(seenModel("")).toBeNull();
    expect(seenModel(" gemini-2.5-pro ")).toBe("gemini-2.5-pro");
    expect(chipModel(null, null, "<synthetic>")).toEqual({ model: null, from: "agent" });
  });

  it("finds the newest usage record that names a model", () => {
    const u = (id: string, model: string): Entry => ({ kind: "usage", id, ts: "", model, input: 1, cacheRead: 0, cacheWrite: 0, output: 1 });
    const t: Entry = { kind: "text", id: "t", ts: "", msgId: "m", text: "hi" };
    expect(lastSeenModel([u("1", "claude-sonnet-4-5"), t, u("2", "claude-opus-4-5"), u("3", "<synthetic>"), t])).toBe("claude-opus-4-5");
    expect(lastSeenModel([t])).toBeNull();
  });
});

describe("FLIP math", () => {
  it("starts a moved row from its old place, capped", () => {
    expect(flipDelta(undefined, 100)).toBeNull();
    expect(flipDelta(100, 100)).toBeNull();
    expect(flipDelta(100.2, 100)).toBeNull();
    expect(flipDelta(120, 100)).toBe(20);
    expect(flipDelta(0, 300)).toBe(-40);
    expect(flipDelta(500, 0, 30)).toBe(30);
  });

  it("plans only rows that moved, top first, near the view, at most the cap", () => {
    const prev = new Map([
      ["a", 0],
      ["b", 34],
      ["c", 68],
      ["gone", 102],
    ]);
    const next = new Map([
      ["b", 0],
      ["a", 34],
      ["c", 68],
      ["new", 102],
    ]);
    expect(planFlip(prev, next)).toEqual([
      { key: "b", delta: 34 },
      { key: "a", delta: -34 },
    ]);
    const many = new Map(Array.from({ length: 100 }, (_, i) => [`r${i}`, i * 34] as const));
    const shifted = new Map(Array.from({ length: 100 }, (_, i) => [`r${i}`, i * 34 + 34] as const));
    expect(planFlip(many, shifted)).toHaveLength(FLIP_MAX_ROWS);
    expect(planFlip(many, shifted, { maxRows: 5 }).map((p) => p.key)).toEqual(["r0", "r1", "r2", "r3", "r4"]);
    /* rows far below the visible window snap */
    const seen = planFlip(many, shifted, { view: [0, 340], rowHeight: 34 });
    expect(seen.length).toBeLessThan(15);
    expect(seen[0]).toEqual({ key: "r0", delta: -34 });
  });

  it("carries the part of a move still to go", () => {
    expect(remaining(40, 0)).toBe(40);
    expect(remaining(40, 0.25)).toBe(30);
    expect(remaining(-40, 1)).toBeCloseTo(0);
    expect(remaining(40, 2)).toBe(0);
  });
});

describe("createFlip", () => {
  const g = globalThis as Record<string, unknown>;
  afterEach(() => {
    delete g.window;
    delete g.document;
  });
  function page(reduce: boolean) {
    g.window = { matchMedia: () => ({ matches: reduce }) };
    g.document = { documentElement: { getAttribute: () => null } };
  }
  function list(order: string[]) {
    const played: { key: string; frames: Keyframe[] }[] = [];
    const rows = new Map<string, { top: number; el: HTMLElement }>();
    const make = (key: string) => {
      const el = {
        dataset: { sessionRow: key },
        getBoundingClientRect: () => ({ top: rows.get(key)!.top, height: 34 }),
        animate: (frames: Keyframe[]) => {
          played.push({ key, frames });
          return { cancel() {}, addEventListener() {}, playState: "running", effect: { getComputedTiming: () => ({ progress: 0 }) } };
        },
      } as unknown as HTMLElement;
      return el;
    };
    const set = (keys: string[]) => keys.forEach((k, i) => rows.set(k, { top: i * 34, el: rows.get(k)?.el ?? make(k) }));
    set(order);
    const container = {
      scrollTop: 0,
      getBoundingClientRect: () => ({ top: 0, height: 600 }),
      querySelectorAll: () => [...rows.values()].sort((a, b) => a.top - b.top).map((r) => r.el),
    } as unknown as HTMLElement;
    return { container, played, set };
  }

  it("measures first, then slides rows that moved", () => {
    page(false);
    const l = list(["a", "b", "c"]);
    const f = createFlip(l.container, { selector: "[data-session-row]", key: (el) => el.dataset.sessionRow });
    f.update();
    expect(l.played).toEqual([]);
    l.set(["c", "a", "b"]);
    f.update();
    expect(l.played.map((p) => [p.key, p.frames[0].transform])).toEqual([
      ["c", "translateY(40px)"],
      ["a", "translateY(-34px)"],
      ["b", "translateY(-34px)"],
    ]);
  });

  it("stays still under Reduce motion", () => {
    page(true);
    const l = list(["a", "b"]);
    const f = createFlip(l.container, { selector: "[data-session-row]", key: (el) => el.dataset.sessionRow });
    f.update();
    l.set(["b", "a"]);
    f.update();
    expect(l.played).toEqual([]);
  });
});

describe("sidebar width", () => {
  it("clamps to the bounds and whole pixels", () => {
    expect(clampSidebarWidth(100)).toBe(SIDEBAR_MIN);
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX);
    expect(clampSidebarWidth(300.6)).toBe(301);
    expect(clampSidebarWidth(NaN)).toBe(SIDEBAR_DEFAULT);
  });

  it("leaves the conversation room in a narrow window", () => {
    expect(sidebarMax(1440)).toBe(SIDEBAR_MAX);
    expect(sidebarMax(900)).toBe(300);
    expect(sidebarMax(700)).toBe(SIDEBAR_MIN);
    expect(clampSidebarWidth(400, 900)).toBe(300);
  });

  it("moves with the keyboard", () => {
    expect(sidebarKeyWidth("ArrowRight", 260, false)).toBe(276);
    expect(sidebarKeyWidth("ArrowLeft", 260, true)).toBe(220);
    expect(sidebarKeyWidth("ArrowLeft", 230, false)).toBe(SIDEBAR_MIN);
    expect(sidebarKeyWidth("Home", 300, false)).toBe(SIDEBAR_MIN);
    expect(sidebarKeyWidth("End", 300, false, 900)).toBe(300);
    expect(sidebarKeyWidth("Enter", 400, false)).toBe(SIDEBAR_DEFAULT);
    expect(sidebarKeyWidth("a", 300, false)).toBeNull();
  });

  it("is a device setting that lands on <html> before paint", () => {
    const def = settingDef("sidebarWidth");
    expect(def.scope).toBe("device");
    expect(def.section).toBe("sidebar");
    expect(parseValue(def, 500)).toEqual({ ok: true, value: SIDEBAR_MAX });
    expect(domState(DEFAULTS, false).vars["--sidebar-w"]).toBeUndefined();
    expect(domState({ ...DEFAULTS, sidebarWidth: 320 }, false).vars["--sidebar-w"]).toBe("320px");
  });
});

describe("project icons on the server", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-u-icons-"));
  const dir = (name: string, files: Record<string, string | number> = {}) => {
    const d = path.join(tmp, name);
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
      fs.writeFileSync(path.join(d, rel), typeof body === "number" ? Buffer.alloc(body) : body);
    }
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  afterEach(clearProjectCaches);

  it("finds the best favicon a folder has", async () => {
    const next = dir("next", { "app/favicon.ico": "ico", "public/favicon.svg": "<svg/>" });
    expect(await findProjectIcon(next)).toBe(path.join(next, "public/favicon.svg"));
    const plain = dir("plain", { "README.md": "hi" });
    expect(await findProjectIcon(plain)).toBeNull();
    /* empty files and pictures far bigger than an icon don't count */
    const odd = dir("odd", { "public/favicon.ico": "", "static/favicon.png": 2 * 1024 * 1024 });
    expect(await findProjectIcon(odd)).toBeNull();
  });

  it("looks in the repository a subfolder belongs to", async () => {
    const repo = dir("repo", { ".git/HEAD": "ref: refs/heads/main\n", "static/favicon.png": "png" });
    const sub = dir("repo/packages/web");
    expect(await findProjectIcon(sub)).toBe(path.join(repo, "static/favicon.png"));
  });

  it("caches per folder and refuses relative paths", async () => {
    const d = dir("cached");
    expect(await projectIcon(d, 1000)).toBeNull();
    fs.mkdirSync(path.join(d, "public"));
    fs.writeFileSync(path.join(d, "public/favicon.png"), "png");
    expect(await projectIcon(d, 2000)).toBeNull();
    expect(await projectIcon(d, 1000 + 11 * 60_000)).toBe(path.join(d, "public/favicon.png"));
    expect(await projectIcon("relative/dir")).toBeNull();
  });

  it("reads the branch once per folder for a while", async () => {
    const d = dir("branchy");
    execFileSync("git", ["init", "-q", "-b", "feature/x"], { cwd: d });
    expect(await projectBranch(d, 1000)).toBe("feature/x");
    execFileSync("git", ["checkout", "-q", "-b", "other"], { cwd: d });
    expect(await projectBranch(d, 2000)).toBe("feature/x");
    expect(await projectBranch(d, 1000 + 31_000)).toBe("other");
    expect(await projectBranch(dir("not-a-repo"))).toBeNull();
  });
});
