import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentu-projects-")));
process.env.AGENT_U_HOME = path.join(tmp, "cfg");
process.env.AGENT_U_CONFIG = path.join(tmp, "cfg", "config.json");
process.env.AGENT_U_WORKTREES = path.join(tmp, "worktrees");

const rows = vi.hoisted(() => ({ list: [] as { cwd: string; mtime: number }[] }));
vi.mock("@/lib/server/rows", () => ({ sessionRows: async () => rows.list }));

const p = await import("@/lib/server/projects");
const route = await import("@/app/api/projects/route");
const { resolveNewSession, nearestProject } = await import("@/lib/projects");
const { commandArgv } = await import("@/lib/server/terminals");

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => fs.rmSync(p.projectsPath(), { force: true }));

const known = new Map([
  ["claude", "claude"],
  ["codex", "codex"],
  ["gemini-fake", "gemini"],
] as const);
const mkdir = (...parts: string[]) => {
  const d = path.join(tmp, ...parts);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const req = (method: string, body?: unknown, query = "") =>
  new NextRequest(`http://x/api/projects${query}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("project validation", () => {
  it("keeps a clean project and drops what's unset", () => {
    const r = p.parseProject(
      { path: "/srv/app/", name: "  My   app ", profile: "codex", model: "gpt-5.5", mode: "acceptEdits", effort: "HIGH", worktree: "inherit", branchPrefix: "me/", actions: [{ name: "dev", command: " pnpm run dev " }] },
      known,
    );
    expect(r).toEqual({ path: "/srv/app", name: "My app", profile: "codex", model: "gpt-5.5", mode: "acceptEdits", effort: "high", branchPrefix: "me/", actions: [{ id: "dev", name: "dev", command: "pnpm run dev", icon: "play" }] });
  });

  it("refuses bad paths, unknown fields, profiles, levels and prefixes", () => {
    const bad: [unknown, RegExp][] = [
      [{ path: "relative/app" }, /absolute/],
      [{ path: "/" }, /not \//],
      [{ path: "" }, /Choose a folder/],
      [{ path: `/${"a".repeat(1100)}` }, /too long/],
      [{ path: "/a", extra: 1 }, /Unknown field "extra"/],
      [{ path: "/a", profile: "nope" }, /no profile called nope/],
      [{ path: "/a", model: "opus" }, /profile before a model/],
      [{ path: "/a", profile: "claude", model: "has space" }, /valid model/],
      [{ path: "/a", mode: "yolo" }, /mode must be/],
      [{ path: "/a", profile: "gemini-fake", effort: "high" }, /no effort levels/],
      [{ path: "/a", profile: "codex", effort: "max" }, /low, medium, high, xhigh/],
      [{ path: "/a", worktree: "maybe" }, /inherit, on or off/],
      [{ path: "/a", branchPrefix: "a..b" }, /valid git branch/],
      [{ path: "/a", branchPrefix: "-x" }, /letters, digits/],
      [{ path: "/a", branchPrefix: "a b" }, /letters, digits/],
      [{ path: "/a", branchPrefix: "x".repeat(41) }, /under 40/],
      [{ path: "/a", name: 5 }, /name must be a string/],
      [{ path: "/a", actions: {} }, /must be a list/],
    ];
    for (const [raw, want] of bad) expect(p.parseProject(raw, known), JSON.stringify(raw).slice(0, 80)).toMatch(want);
    expect(p.parseProject(null)).toMatch(/project object/);
    expect(p.parseProject([1])).toMatch(/project object/);
  });

  it("limits actions in count and length, one line each, with known icons and unique names", () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ name: `a${i}`, command: "true" }));
    expect(p.parseProject({ path: "/a", actions: many })).toMatch(/20 actions/);
    expect(p.parseProject({ path: "/a", actions: [{ name: "x".repeat(41), command: "true" }] })).toMatch(/under 40/);
    expect(p.parseProject({ path: "/a", actions: [{ name: "x", command: "y".repeat(501) }] })).toMatch(/under 500/);
    expect(p.parseProject({ path: "/a", actions: [{ name: "x", command: "echo a\nrm -rf /" }] })).toMatch(/one line/);
    expect(p.parseProject({ path: "/a", actions: [{ name: "x", command: "" }] })).toMatch(/enter a command/);
    expect(p.parseProject({ path: "/a", actions: [{ name: " ", command: "x" }] })).toMatch(/needs a name/);
    expect(p.parseProject({ path: "/a", actions: [{ name: "x", command: "x", icon: "skull" }] })).toMatch(/unknown icon/);
    expect(p.parseProject({ path: "/a", actions: [{ name: "x", command: "x", shortcut: "mod+r" }] })).toMatch(/Unknown action field/);
    expect(p.parseProject({ path: "/a", actions: [{ name: "Dev", command: "a" }, { name: "dev", command: "b" }] })).toMatch(/Two actions/);
  });

  it("gives actions stable, unique ids", () => {
    const r = p.parseProject({ path: "/a", actions: [{ id: "keep", name: "Dev server", command: "a" }, { name: "Dev: server", command: "b" }, { id: "keep", name: "Other", command: "c" }, { name: "Dev server!", command: "d" }] });
    expect(typeof r === "string" ? r : r.actions.map((a) => a.id)).toEqual(["keep", "dev-server", "other", "dev-server-2"]);
  });

  it("checks branch prefixes and reads a bare name as a folder", () => {
    for (const ok of ["me", "me/", "feat-", "team/me_", "v1.2/"]) expect(p.prefixProblem(ok), ok).toBeNull();
    for (const bad of ["me//x", "me/.x", "x.lock", "x.lock/", "me.", "./x", "@{x"]) expect(p.prefixProblem(bad), bad).not.toBeNull();
    expect(p.normalizePrefix("me")).toBe("me/");
    expect(p.normalizePrefix("me/")).toBe("me/");
    expect(p.normalizePrefix("feat-")).toBe("feat-");
  });
});

describe("projects.json", () => {
  it("saves (chmod 600), replaces by folder, lists and forgets", () => {
    const app = mkdir("app");
    expect(p.saveProject({ path: app, name: "App" }, known)).toEqual({ project: { path: app, name: "App", actions: [] } });
    expect((fs.statSync(p.projectsPath()).mode & 0o777).toString(8)).toBe("600");
    p.saveProject({ path: `${app}/`, name: "App 2", worktree: "on" }, known);
    expect(p.readProjects()).toEqual([{ path: app, name: "App 2", worktree: "on", actions: [] }]);
    expect(JSON.parse(fs.readFileSync(p.projectsPath(), "utf8"))).toEqual({ projects: [{ path: app, name: "App 2", worktree: "on", actions: [] }] });
    expect(p.removeProject(app)).toEqual({ ok: true });
    expect(p.readProjects()).toEqual([]);
  });

  it("needs the folder to exist and skips entries it can't read", () => {
    expect(p.saveProject({ path: path.join(tmp, "nowhere") }, known)).toEqual({ error: `Folder not found: ${path.join(tmp, "nowhere")}` });
    fs.mkdirSync(path.dirname(p.projectsPath()), { recursive: true });
    fs.writeFileSync(p.projectsPath(), JSON.stringify({ projects: [{ path: "rel" }, { path: "/ok", name: "Ok" }, { path: "/ok", name: "Twice" }, 5] }));
    expect(p.readProjects()).toEqual([{ path: "/ok", name: "Ok", actions: [] }]);
  });
});

describe("/api/projects", () => {
  it("lists configured projects and session folders, worktrees left out, newest first", async () => {
    const app = mkdir("list", "app");
    const other = mkdir("list", "other");
    p.saveProject({ path: app, name: "App", actions: [{ name: "dev", command: "pnpm run dev" }] }, known);
    rows.list = [
      { cwd: other, mtime: 300 },
      { cwd: app, mtime: 200 },
      { cwd: app, mtime: 100 },
      { cwd: path.join(tmp, "worktrees", "app", "fix-0101"), mtime: 400 },
      { cwd: "", mtime: 1 },
    ];
    const res = await route.GET(req("GET"));
    const { projects } = await res.json();
    expect(projects.map((e: { path: string; name: string; sessions: number; config: unknown }) => [e.name, e.sessions, Boolean(e.config)])).toEqual([
      ["other", 1, false],
      ["App", 2, true],
    ]);
  });

  it("PUT validates, DELETE forgets, ?for= finds the project above a folder", async () => {
    const app = mkdir("api", "app");
    mkdir("api", "app", "src");
    let res: Response = await route.PUT(req("PUT", { project: { path: app, profile: "missing" } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no profile called missing/);
    res = await route.PUT(req("PUT", { project: { path: app, profile: "claude", effort: "max", actions: [{ name: "test", command: "pnpm test", icon: "test" }] } }));
    expect(res.status).toBe(200);
    res = await route.GET(req("GET", undefined, `?for=${encodeURIComponent(`${app}/src`)}`));
    expect(await res.json()).toMatchObject({ project: { path: app, profile: "claude", effort: "max" }, runDir: app });
    res = await route.DELETE(req("DELETE", { path: app }));
    expect(res.status).toBe(200);
    res = await route.GET(req("GET", undefined, `?for=${encodeURIComponent(app)}`));
    expect(await res.json()).toEqual({ project: null, runDir: null });
    expect((await route.GET(req("GET", undefined, "?for=relative"))).status).toBe(400);
    expect((await route.PUT(req("PUT", {}))).status).toBe(400);
  });
});

describe("package.json scripts", () => {
  const pkg = (dir: string, scripts: Record<string, string>, extra: object = {}) => fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", scripts, ...extra }));

  it("detects pnpm, yarn, npm and bun from their lockfiles", async () => {
    for (const [file, pm] of [
      ["pnpm-lock.yaml", "pnpm"],
      ["yarn.lock", "yarn"],
      ["package-lock.json", "npm"],
      ["bun.lockb", "bun"],
      ["bun.lock", "bun"],
    ] as const) {
      const d = mkdir("seed", file);
      fs.mkdirSync(path.join(d, ".git"));
      fs.writeFileSync(path.join(d, file), "");
      pkg(d, { dev: "next dev" });
      expect(await p.seedScripts(d), file).toEqual({ manager: pm, actions: [{ name: "dev", command: `${pm} run dev`, icon: "play" }] });
    }
  });

  it("uses a lockfile above (a workspace package), then packageManager, then npm", async () => {
    const root = mkdir("mono");
    fs.mkdirSync(path.join(root, ".git"));
    fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "");
    const sub = mkdir("mono", "packages", "web");
    pkg(sub, { build: "vite build" });
    expect((await p.seedScripts(sub)).manager).toBe("pnpm");

    const named = mkdir("named");
    fs.mkdirSync(path.join(named, ".git"));
    pkg(named, { test: "vitest" }, { packageManager: "yarn@4.1.0" });
    expect(await p.seedScripts(named)).toEqual({ manager: "yarn", actions: [{ name: "test", command: "yarn run test", icon: "test" }] });

    const bare = mkdir("bare");
    fs.mkdirSync(path.join(bare, ".git"));
    pkg(bare, { lint: "eslint ." });
    expect((await p.seedScripts(bare)).manager).toBe("npm");
  });

  it("skips lifecycle hooks, quotes odd names, picks icons, and copes without package.json", async () => {
    const d = mkdir("hooks");
    fs.mkdirSync(path.join(d, ".git"));
    fs.writeFileSync(path.join(d, "package-lock.json"), "");
    pkg(d, { prebuild: "rm -rf dist", build: "tsc", postinstall: "patch", prepare: "husky", "test:e2e": "playwright", "it's": "echo", deploy: "x", preview: "vite preview", weird: "a" });
    const s = await p.seedScripts(d);
    expect(s.actions).toEqual([
      { name: "build", command: "npm run build", icon: "build" },
      { name: "test:e2e", command: "npm run test:e2e", icon: "test" },
      { name: "it's", command: `npm run 'it'\\''s'`, icon: "terminal" },
      { name: "deploy", command: "npm run deploy", icon: "deploy" },
      { name: "preview", command: "npm run preview", icon: "play" },
      { name: "weird", command: "npm run weird", icon: "terminal" },
    ]);
    expect(await p.seedScripts(mkdir("empty"))).toEqual({ manager: null, actions: [] });
    fs.writeFileSync(path.join(mkdir("broken"), "package.json"), "{");
    expect(await p.seedScripts(path.join(tmp, "broken"))).toEqual({ manager: null, actions: [] });
  });

  it("is served at ?scripts=", async () => {
    const d = mkdir("served");
    fs.mkdirSync(path.join(d, ".git"));
    fs.writeFileSync(path.join(d, "bun.lock"), "");
    pkg(d, { start: "bun run index.ts" });
    const res = await route.GET(req("GET", undefined, `?scripts=${encodeURIComponent(d)}`));
    expect(await res.json()).toEqual({ manager: "bun", actions: [{ name: "start", command: "bun run start", icon: "play" }] });
  });
});

describe("new session defaults", () => {
  const profiles = [
    { id: "claude", agent: "claude" as const, installed: true, hidden: false, defaultEffort: null },
    { id: "claude-work", agent: "claude" as const, installed: true, hidden: false, defaultEffort: "low" },
    { id: "codex", agent: "codex" as const, installed: true, hidden: false, defaultEffort: null },
    { id: "gemini", agent: "gemini" as const, installed: true, hidden: false, defaultEffort: null },
    { id: "kimi", agent: "kimi" as const, installed: false, hidden: false, defaultEffort: null },
  ];
  const current = { agent: "claude" as const, profile: "claude", model: "", mode: "default" as const, effort: "", worktree: false };
  const settingsEffort = (a: string) => (a === "claude" ? "medium" : "");
  const run = (o: Partial<Parameters<typeof resolveNewSession>[0]>) => resolveNewSession({ current, picked: {}, project: null, profiles, settingsEffort, ...o });

  it("effort: explicit, else the project's, else the profile's, else Settings", () => {
    const project = { path: "/a", profile: "claude-work", effort: "high", actions: [] };
    expect(run({ project, current: { ...current, effort: "max" }, picked: { effort: true } })).toMatchObject({ effort: "max", sentEffort: "max" });
    expect(run({ project })).toMatchObject({ profile: "claude-work", effort: "high", sentEffort: "high" });
    expect(run({ project: { ...project, effort: undefined } })).toMatchObject({ effort: "", sentEffort: "low" });
    expect(run({ project: { path: "/a", actions: [] } })).toMatchObject({ profile: "claude", sentEffort: "medium" });
    expect(run({ profiles: null })).toMatchObject({ sentEffort: "" });
  });

  it("profile, model, mode and worktree: the project's unless picked here", () => {
    const project = { path: "/a", profile: "codex", model: "gpt-5.5", mode: "acceptEdits" as const, worktree: "on" as const, actions: [] };
    expect(run({ project })).toMatchObject({ agent: "codex", profile: "codex", model: "gpt-5.5", mode: "acceptEdits", worktree: true, fromProject: ["profile", "model", "mode", "worktree"] });
    const mine = run({ project, current: { ...current, model: "opus", mode: "plan", worktree: false }, picked: { profile: true, model: true, mode: true, worktree: true } });
    expect(mine).toMatchObject({ agent: "claude", profile: "claude", model: "opus", mode: "plan", worktree: false, fromProject: [] });
  });

  it("a project's model only goes with its own profile; an uninstalled profile is skipped", () => {
    const project = { path: "/a", profile: "codex", model: "gpt-5.5", actions: [] };
    expect(run({ project, picked: { profile: true } })).toMatchObject({ profile: "claude", model: "" });
    expect(run({ project: { path: "/a", profile: "kimi", model: "k2", actions: [] } })).toMatchObject({ agent: "claude", profile: "claude", model: "" });
  });

  it("agents that can't ask only take plan-only or bypass from a project; switching agent resets its mode", () => {
    expect(run({ project: { path: "/a", profile: "gemini", mode: "default", actions: [] } })).toMatchObject({ agent: "gemini", mode: "bypassPermissions" });
    expect(run({ project: { path: "/a", profile: "gemini", mode: "plan", actions: [] } })).toMatchObject({ mode: "plan" });
    expect(run({ project: { path: "/a", profile: "gemini", effort: "high", actions: [] } })).toMatchObject({ effort: "", sentEffort: "" });
  });

  it("finds the nearest project above a folder", () => {
    const list = [{ path: "/a" }, { path: "/a/b" }, { path: "/ab" }];
    expect(nearestProject(list, "/a/b/c")?.path).toBe("/a/b");
    expect(nearestProject(list, "/a/bc")?.path).toBe("/a");
    expect(nearestProject(list, "/ab/")?.path).toBe("/ab");
    expect(nearestProject(list, "/x")).toBeNull();
  });
});

describe("worktrees and run actions", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  const repo = () => {
    const d = mkdir(`repo-${Math.random().toString(36).slice(2, 8)}`);
    git(d, "init", "-q", "-b", "main");
    fs.mkdirSync(path.join(d, "web"));
    fs.writeFileSync(path.join(d, "web", "a.txt"), "a\n");
    git(d, "add", "-A");
    git(d, "commit", "-qm", "init");
    return d;
  };

  it("names worktree branches with the project's prefix, else agent-u/", async () => {
    const g = await import("@/lib/server/git");
    const d = repo();
    expect((await g.newWorktree(d, "Fix login")).branch).toMatch(/^agent-u\/fix-login-\d{8}$/);
    p.saveProject({ path: d, branchPrefix: "me" }, known);
    const wt = await g.newWorktree(path.join(d, "web"), "Fix logout");
    expect(wt.branch).toMatch(/^me\/fix-logout-\d{8}$/);
    expect(git(d, "branch", "--list", wt.branch)).toContain(wt.branch);
    expect(path.basename(wt.dir)).toBe("web");
    p.saveProject({ path: d, branchPrefix: "feat-" }, known);
    expect((await g.newWorktree(d, "Search")).branch).toMatch(/^feat-search-\d{8}$/);
    expect((await g.newWorktree(d, "Find", "x/")).branch).toMatch(/^x\/find-\d{8}$/);
  });

  it("a session in a worktree finds its project and runs actions in the worktree", async () => {
    const g = await import("@/lib/server/git");
    const d = repo();
    p.saveProject({ path: path.join(d, "web"), actions: [{ name: "dev", command: "pnpm run dev" }] }, known);
    const wt = await g.newWorktree(path.join(d, "web"), "Try");
    const hit = await p.locateProject(wt.dir);
    expect(hit?.project.path).toBe(path.join(d, "web"));
    expect(hit?.runDir).toBe(wt.dir);
    expect(await p.locateProject(mkdir("elsewhere"))).toBeNull();
  });

  it("passes the command line to the shell as one argument", () => {
    const [shell, args] = commandArgv(`echo "it's $((1+2))" '$HOME' ; echo done`, "/bin/sh");
    expect([shell, args]).toEqual(["/bin/sh", ["-c", `echo "it's $((1+2))" '$HOME' ; echo done`]]);
    expect(execFileSync(shell, args, { encoding: "utf8" })).toBe("it's 3 $HOME\ndone\n");
    expect(commandArgv("x", "zsh")[0]).toBe("/bin/sh");
  });
});
