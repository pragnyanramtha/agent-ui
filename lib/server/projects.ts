import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { effortOptions, parseEffort } from "@/lib/agent-traits";
import {
  ACTION_ICONS,
  folderName,
  nearestProject,
  PROJECT_LIMITS as L,
  type ActionIcon,
  type PackageManager,
  type ProjectAction,
  type ProjectConfig,
  type ProjectEntry,
  type ScriptSeed,
} from "@/lib/projects";
import { AGENT_IDS, type AgentId, type PermissionMode } from "@/lib/types";
import { childEnv } from "./child-env";

/* Projects: per-folder defaults for new sessions and the commands of the Run menu, in projects.json next to the
 * profiles' config.json (its own file, because setup.sh replaces config.json with the profiles it installs):
 *
 *   { "projects": [{ "path": "/home/me/app", "name": "App", "profile": "claude-work", "mode": "acceptEdits",
 *       "worktree": "on", "branchPrefix": "me/", "actions": [{ "id": "dev", "name": "dev", "command": "pnpm run dev", "icon": "play" }] }] }
 */

const configDir = () => process.env.AGENT_U_HOME || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "agent-u");
export const projectsPath = () => path.join(configDir(), "projects.json");

const MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];
const KEYS = new Set(["path", "name", "profile", "model", "mode", "effort", "worktree", "branchPrefix", "actions"]);
const ACTION_KEYS = new Set(["id", "name", "command", "icon"]);
const ACTION_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const MODEL = /^[\w.:/@[\]+-]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Profile ids the server knows, with their agent; omitted, profile ids aren't checked (reading the file). */
export type KnownProfiles = ReadonlyMap<string, AgentId>;

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "action";

/** A folder path as projects are keyed: absolute, normalized, no trailing slash; or why not. */
export function cleanPath(raw: unknown): string | { error: string } {
  if (typeof raw !== "string" || !raw.trim()) return { error: "Choose a folder." };
  let p = raw.trim();
  if (p === "~" || p.startsWith("~/")) p = path.join(os.homedir(), p.slice(1));
  if (p.length > L.path || p.includes("\0")) return { error: "That folder path is too long." };
  if (!path.isAbsolute(p)) return { error: "Use an absolute folder path." };
  p = path.normalize(p).replace(/\/+$/, "");
  if (!p) return { error: "Pick a project folder, not /." };
  return p;
}

/** Why a branch prefix can't go in front of a branch name, or null when it can ("me", "me/", "feat-"). */
export function prefixProblem(p: string): string | null {
  if (p.length > L.prefix) return `Keep the branch prefix under ${L.prefix} characters.`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(p)) return "Use letters, digits, and . _ - / in the branch prefix.";
  if (/\.\.|\/\/|\/\.|\.lock(\/|$)|\.\/|\.$/.test(p)) return "That branch prefix isn't a valid git branch name.";
  return null;
}

/** "me" reads as "me/"; one that already ends in a separator stays as it is. */
export const normalizePrefix = (p: string) => (/[/_-]$/.test(p) ? p : `${p}/`);

function parseAction(raw: unknown, i: number): Omit<ProjectAction, "id"> & { id?: string } | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return `Action ${i + 1} must be an object.`;
  const r = raw as Record<string, unknown>;
  const extra = Object.keys(r).find((k) => !ACTION_KEYS.has(k));
  if (extra) return `Unknown action field "${extra.slice(0, 40)}".`;
  const name = typeof r.name === "string" ? r.name.replace(/\s+/g, " ").trim() : "";
  if (!name) return `Action ${i + 1} needs a name.`;
  if (name.length > L.actionName) return `Keep action names under ${L.actionName} characters.`;
  const command = typeof r.command === "string" ? r.command.trim() : "";
  if (!command) return `${name}: enter a command.`;
  if (command.length > L.command) return `${name}: keep the command under ${L.command} characters.`;
  if (CONTROL.test(command)) return `${name}: the command must be one line.`;
  const icon = r.icon === undefined || r.icon === null || r.icon === "" ? "play" : r.icon;
  if (typeof icon !== "string" || !(ACTION_ICONS as readonly string[]).includes(icon)) return `${name}: unknown icon.`;
  const id = typeof r.id === "string" && ACTION_ID.test(r.id) ? r.id : undefined;
  return { id, name, command, icon: icon as ActionIcon };
}

/** A clean project from untrusted JSON, or an error message. Unknown fields, profiles and levels are refused. */
export function parseProject(raw: unknown, known?: KnownProfiles): ProjectConfig | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "Send a project object.";
  const r = raw as Record<string, unknown>;
  const extra = Object.keys(r).find((k) => !KEYS.has(k));
  if (extra) return `Unknown field "${extra.slice(0, 40)}".`;
  const p = cleanPath(r.path);
  if (typeof p !== "string") return p.error;
  const out: ProjectConfig = { path: p, actions: [] };
  const text = (k: string) => {
    const v = r[k];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string") return null;
    return v.trim() || undefined;
  };

  const name = text("name");
  if (name === null) return "name must be a string.";
  if (name) {
    const n = name.replace(/\s+/g, " ");
    if (n.length > L.name) return `Keep the name under ${L.name} characters.`;
    out.name = n;
  }

  const profile = text("profile");
  if (profile === null) return "profile must be a string.";
  let agent: AgentId | null = null;
  if (profile) {
    if (known) {
      const a = known.get(profile);
      if (!a) return `There's no profile called ${profile.slice(0, 40)}.`;
      agent = a;
    } else if (!/^[a-z0-9][a-z0-9._-]{0,40}$/.test(profile)) return `"${profile.slice(0, 40)}" isn't a valid profile id.`;
    out.profile = profile;
  }

  const model = text("model");
  if (model === null) return "model must be a string.";
  if (model) {
    if (!profile) return "Choose a profile before a model.";
    if (model.length > L.model || !MODEL.test(model)) return "That isn't a valid model id.";
    out.model = model;
  }

  if (r.mode !== undefined && r.mode !== null && r.mode !== "") {
    if (!MODES.includes(r.mode as PermissionMode)) return `mode must be one of ${MODES.join(", ")}.`;
    out.mode = r.mode as PermissionMode;
  }

  const effort = text("effort");
  if (effort === null) return "effort must be a string.";
  if (effort) {
    const ok = agent ? parseEffort(agent, effort) : AGENT_IDS.some((a) => parseEffort(a, effort));
    if (!ok) {
      const levels = agent ? effortOptions(agent).map((o) => o.key) : [];
      return agent && !levels.length ? "This profile's agent has no effort levels." : `effort must be one of ${levels.length ? levels.join(", ") : "low, medium, high, xhigh, max"}.`;
    }
    out.effort = effort.toLowerCase();
  }

  if (r.worktree !== undefined && r.worktree !== null && r.worktree !== "inherit") {
    if (r.worktree !== "on" && r.worktree !== "off") return "worktree must be inherit, on or off.";
    out.worktree = r.worktree;
  }

  const prefix = text("branchPrefix");
  if (prefix === null) return "branchPrefix must be a string.";
  if (prefix) {
    const why = prefixProblem(prefix);
    if (why) return why;
    out.branchPrefix = prefix;
  }

  if (r.actions !== undefined && r.actions !== null) {
    if (!Array.isArray(r.actions)) return "actions must be a list.";
    if (r.actions.length > L.actions) return `Keep it to ${L.actions} actions.`;
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const [i, a] of r.actions.entries()) {
      const act = parseAction(a, i);
      if (typeof act === "string") return act;
      if (names.has(act.name.toLowerCase())) return `Two actions are called ${act.name}.`;
      names.add(act.name.toLowerCase());
      let id = act.id && !ids.has(act.id) ? act.id : slug(act.name);
      for (let n = 2; ids.has(id); n++) id = `${slug(act.name).slice(0, 36)}-${n}`;
      ids.add(id);
      out.actions.push({ id, name: act.name, command: act.command, icon: act.icon });
    }
  }
  const { actions, ...rest } = out;
  return { ...rest, actions };
}

/* ── the file ─────────────────────────────────────────────── */

let cache: { key: string; list: ProjectConfig[] } | null = null;

/** Every configured project, in file order; entries that don't read as a project are skipped. */
export function readProjects(): ProjectConfig[] {
  const file = projectsPath();
  try {
    const st = fs.statSync(file);
    const key = `${file}\0${st.mtimeMs}\0${st.size}\0${st.ino}`;
    if (cache?.key === key) return cache.list;
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as { projects?: unknown };
    const raw = Array.isArray(data?.projects) ? data.projects : [];
    const seen = new Set<string>();
    const list = raw.map((p) => parseProject(p)).filter((p): p is ProjectConfig => typeof p !== "string" && !seen.has(p.path) && Boolean(seen.add(p.path)));
    cache = { key, list };
    return list;
  } catch {
    return [];
  }
}

function writeProjects(list: ProjectConfig[]) {
  const file = projectsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ projects: list.map(lean) }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  cache = null;
}

/* unset fields stay out of the file, actions last */
const lean = ({ actions, ...rest }: ProjectConfig) => ({ ...(JSON.parse(JSON.stringify(rest)) as Omit<ProjectConfig, "actions">), actions });

const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Adds or replaces a project (matched by folder). The folder has to exist and profiles have to be known. */
export function saveProject(raw: unknown, known: KnownProfiles): { project: ProjectConfig } | { error: string } {
  const p = parseProject(raw, known);
  if (typeof p === "string") return { error: p };
  if (!isDir(p.path)) return { error: `Folder not found: ${p.path}` };
  const list = readProjects().filter((x) => x.path !== p.path);
  if (list.length >= L.projects) return { error: `Keep it to ${L.projects} projects.` };
  writeProjects([...list, p]);
  return { project: p };
}

/** Forgets a project's settings; its sessions stay. */
export function removeProject(raw: unknown): { ok: true } | { error: string } {
  const p = cleanPath(raw);
  if (typeof p !== "string") return p;
  const list = readProjects();
  if (!list.some((x) => x.path === p)) return { ok: true };
  writeProjects(list.filter((x) => x.path !== p));
  return { ok: true };
}

/* ── which project a folder belongs to ───────────────────── */

function gitLines(cwd: string, args: string[]): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, env: childEnv({ GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }), timeout: 5000 }, (err, stdout) =>
      resolve(err ? null : stdout.split("\n").filter(Boolean)),
    );
  });
}

/** For a folder inside a linked worktree: its top folder and the main checkout's. */
async function worktreeOf(dir: string): Promise<{ top: string; main: string } | null> {
  const out = await gitLines(dir, ["rev-parse", "--show-toplevel", "--git-common-dir"]);
  if (!out || out.length < 2) return null;
  const top = out[0];
  const common = path.resolve(dir, out[1]);
  if (path.basename(common) !== ".git") return null;
  const main = path.dirname(common);
  return main === top ? null : { top, main };
}

/**
 * The project a session's folder belongs to, and the folder its actions run in: the project's own folder, or the
 * same place inside the worktree the session works in.
 */
export async function locateProject(dir: string, list = readProjects()): Promise<{ project: ProjectConfig; runDir: string } | null> {
  if (!list.length || !path.isAbsolute(dir)) return null;
  const d = path.resolve(dir);
  const direct = nearestProject(list, d);
  if (direct) return { project: direct, runDir: isDir(direct.path) ? direct.path : d };
  const wt = isDir(d) ? await worktreeOf(d) : null;
  if (!wt) return null;
  const p = nearestProject(list, path.join(wt.main, path.relative(wt.top, d)));
  if (!p) return null;
  const rel = path.relative(wt.main, p.path);
  const inTree = rel.startsWith("..") ? null : path.join(wt.top, rel);
  return { project: p, runDir: inTree && isDir(inTree) ? inTree : d };
}

/** The branch prefix for worktrees made from this folder, normalized; null when its project has none. */
export async function branchPrefixFor(dir: string): Promise<string | null> {
  const prefix = (await locateProject(dir).catch(() => null))?.project.branchPrefix;
  return prefix && !prefixProblem(prefix) ? normalizePrefix(prefix) : null;
}

/* ── the list in Settings ─────────────────────────────────── */

/** Configured projects and the folders sessions ran in (worktrees left out), most recently used first. */
export function projectEntries(configured: ProjectConfig[], sessions: { cwd: string; mtime: number }[], skip: string[] = []): ProjectEntry[] {
  const used = new Map<string, { n: number; last: number }>();
  for (const s of sessions) {
    const c = cleanPath(s.cwd);
    if (typeof c !== "string" || skip.some((k) => c === k || c.startsWith(`${k}/`))) continue;
    const u = used.get(c) ?? { n: 0, last: 0 };
    used.set(c, { n: u.n + 1, last: Math.max(u.last, s.mtime) });
  }
  const out = new Map<string, ProjectEntry>();
  for (const p of configured) out.set(p.path, { path: p.path, name: p.name ?? folderName(p.path), config: p, sessions: 0, lastActive: null, exists: isDir(p.path) });
  for (const [cwd, u] of used) {
    const own = out.get(cwd);
    if (own) Object.assign(own, { sessions: u.n, lastActive: u.last });
    else out.set(cwd, { path: cwd, name: folderName(cwd), config: null, sessions: u.n, lastActive: u.last, exists: isDir(cwd) });
  }
  return [...out.values()].sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0) || a.name.localeCompare(b.name));
}

/* ── package.json scripts ─────────────────────────────────── */

const LOCKFILES: [string, PackageManager][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];
const MANAGERS: PackageManager[] = ["pnpm", "yarn", "npm", "bun"];

/** The package manager a folder uses: the nearest lockfile (up to the repository's top), else package.json's
 * packageManager field, else npm. */
export async function detectManager(dir: string, packageManager?: unknown): Promise<PackageManager> {
  let d = dir;
  for (let i = 0; i < 8; i++) {
    for (const [file, pm] of LOCKFILES) if (await fsp.stat(path.join(d, file)).then(() => true, () => false)) return pm;
    const top = await fsp.stat(path.join(d, ".git")).then(() => true, () => false);
    const up = path.dirname(d);
    if (top || up === d || d === os.homedir()) break;
    d = up;
  }
  const named = typeof packageManager === "string" ? (packageManager.split("@")[0] as PackageManager) : null;
  return named && MANAGERS.includes(named) ? named : "npm";
}

const LIFECYCLE = new Set(["install", "preinstall", "postinstall", "prepare", "prepublish", "prepublishOnly", "prepack", "postpack", "dependencies"]);
const quoteArg = (s: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** An icon that suits a script by its name. */
export function iconFor(name: string): ActionIcon {
  const n = name.toLowerCase();
  if (/^(dev|start|serve|preview|watch)\b/.test(n)) return "play";
  if (/^(test|e2e|spec|vitest|jest)/.test(n)) return "test";
  if (/^(build|compile|bundle|dist)/.test(n)) return "build";
  if (/^(lint|format|fmt|typecheck|check|tsc|prettier|eslint)/.test(n)) return "lint";
  if (/^(debug|inspect)/.test(n)) return "debug";
  if (/^(deploy|release|publish|ship)/.test(n)) return "deploy";
  return "terminal";
}

/** Actions for the scripts in a folder's package.json, run with its package manager. */
export async function seedScripts(dir: string): Promise<ScriptSeed> {
  let pkg: { scripts?: unknown; packageManager?: unknown };
  try {
    pkg = JSON.parse(await fsp.readFile(path.join(dir, "package.json"), "utf8")) as typeof pkg;
  } catch {
    return { manager: null, actions: [] };
  }
  const scripts = pkg && typeof pkg.scripts === "object" && pkg.scripts && !Array.isArray(pkg.scripts) ? (pkg.scripts as Record<string, unknown>) : {};
  const manager = await detectManager(dir, pkg?.packageManager);
  const names = Object.keys(scripts).filter((n) => typeof scripts[n] === "string" && n.trim() && !LIFECYCLE.has(n));
  const actions = names
    /* pre/post hooks run with their script anyway */
    .filter((n) => !(/^(pre|post)./.test(n) && names.includes(n.replace(/^(pre|post)/, ""))))
    .map((n) => ({ name: n.slice(0, L.actionName), command: `${manager} run ${quoteArg(n)}`, icon: iconFor(n) }))
    .filter((a) => a.command.length <= L.command && !CONTROL.test(a.command))
    .slice(0, L.actions);
  return { manager, actions };
}
