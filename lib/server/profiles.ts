import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_IDS, AGENT_LABEL, type AgentId, type ProfileInfo } from "@/lib/types";
import { CLAUDE_DEFAULT_MODEL } from "./config";

/* Agent profiles: which CLI to run for an agent kind, with what arguments and environment.
 * Every installed agent has a built-in profile under its own id ("claude", "codex", ...).
 * Extra ones live in the config file, so wrappers (a Codex behind another backend), API-key
 * subscriptions and custom proxies are just data:
 *
 *   { "profiles": [{ "id": "codex-proxy", "label": "Codex via proxy", "agent": "codex",
 *       "bin": "codex", "args": ["-c", "model_provider=\"proxy\""],
 *       "env": { "OPENAI_API_KEY": "${PROXY_KEY}" }, "models": ["gpt-5.5"], "fallback": ["codex"] }] }
 *
 * `${VAR}` in env values reads the server's environment (.env.local), so secrets stay out of the file.
 * A profile with the id of a built-in overrides it. */

export type Profile = {
  id: string;
  label: string;
  agent: AgentId;
  /** binary name (searched on PATH and the usual install folders) or absolute path; default: the agent's own */
  bin?: string;
  /** put before the agent's own arguments (global flags) */
  args?: string[];
  env?: Record<string, string>;
  /** model ids offered in the composer; the first is the default when `defaultModel` isn't set */
  models?: string[];
  defaultModel?: string;
  /** profiles to continue with when a turn fails on a usage limit, quota, or capacity error */
  fallback?: string[];
  /** extra arguments for interactive launches only (e.g. "--dangerously-skip-permissions") */
  launchArgs?: string[];
  hidden?: boolean;
  notes?: string;
};

export type ResolvedProfile = Profile & { binPath: string | null; env: Record<string, string>; args: string[]; builtin: boolean };

const home = os.homedir();
export const CONFIG_DIR = process.env.AGENT_U_HOME || path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "agent-u");
export const CONFIG_PATH = process.env.AGENT_U_CONFIG || path.join(CONFIG_DIR, "config.json");
const STATE_PATH = path.join(CONFIG_DIR, "state.json");

const DEFAULT_BIN: Record<AgentId, string> = { claude: "claude", codex: "codex", opencode: "opencode", cursor: "cursor-agent", devin: "devin", kimi: "kimi" };
const BIN_ENV: Record<AgentId, string> = { claude: "CLAUDE_BIN", codex: "CODEX_BIN", opencode: "OPENCODE_BIN", cursor: "CURSOR_AGENT_BIN", devin: "DEVIN_BIN", kimi: "KIMI_BIN" };

/** where CLIs usually land; services often run with a short PATH */
const EXTRA_DIRS = [".local/bin", ".local/npm-global/bin", ".npm-global/bin", ".opencode/bin", ".kimi-code/bin", ".bun/bin", ".cargo/bin", ".local/share/pnpm/bin"].map((d) => path.join(home, d));

export function resolveBin(bin: string): string | null {
  if (path.isAbsolute(bin)) return isExec(bin) ? bin : null;
  if (bin.includes("/")) return null;
  for (const dir of [...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean), ...EXTRA_DIRS, "/usr/local/bin", "/usr/bin"]) {
    const p = path.join(dir, bin);
    if (isExec(p)) return p;
  }
  return null;
}

function isExec(p: string) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/* ── config file ─────────────────────────────────────────── */

type ConfigFile = { profiles?: unknown[]; defaultProfile?: string };
let cache: { mtime: number; data: ConfigFile } | null = null;

function readConfig(): ConfigFile {
  try {
    const st = fs.statSync(CONFIG_PATH);
    if (cache && cache.mtime === st.mtimeMs) return cache.data;
    const data = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as ConfigFile;
    cache = { mtime: st.mtimeMs, data: data && typeof data === "object" ? data : {} };
    return cache.data;
  } catch {
    return {};
  }
}

function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const ID = /^[a-z0-9][a-z0-9._-]{0,40}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);

/** A clean profile from untrusted JSON, or an error message. */
export function parseProfile(raw: unknown): Profile | string {
  if (!raw || typeof raw !== "object") return "A profile must be an object.";
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id.trim() : "";
  if (!ID.test(id)) return `"${id}" isn't a valid id (lowercase letters, digits, . _ -).`;
  const agent = r.agent as AgentId;
  if (!AGENT_IDS.includes(agent)) return `${id}: agent must be one of ${AGENT_IDS.join(", ")}.`;
  const env: Record<string, string> = {};
  if (r.env && typeof r.env === "object") {
    for (const [k, v] of Object.entries(r.env as Record<string, unknown>)) {
      if (!ENV_KEY.test(k)) return `${id}: "${k}" isn't a valid environment variable name.`;
      if (typeof v === "string") env[k] = v;
    }
  }
  const bin = typeof r.bin === "string" && r.bin.trim() ? r.bin.trim() : undefined;
  if (bin && bin.includes("/") && !path.isAbsolute(bin)) return `${id}: bin must be a name on PATH or an absolute path.`;
  const out: Profile = {
    id,
    label: typeof r.label === "string" && r.label.trim() ? r.label.trim().slice(0, 60) : id,
    agent,
    bin,
    args: strings(r.args),
    env: Object.keys(env).length ? env : undefined,
    models: strings(r.models)?.map((m) => m.trim()).filter(Boolean),
    defaultModel: typeof r.defaultModel === "string" && r.defaultModel.trim() ? r.defaultModel.trim() : undefined,
    fallback: strings(r.fallback)?.filter((f) => ID.test(f) && f !== id),
    launchArgs: strings(r.launchArgs),
    hidden: r.hidden === true ? true : undefined,
    notes: typeof r.notes === "string" ? r.notes.slice(0, 500) : undefined,
  };
  return JSON.parse(JSON.stringify(out)) as Profile;
}

function userProfiles(): Profile[] {
  const list = readConfig().profiles ?? [];
  return list.map(parseProfile).filter((p): p is Profile => typeof p !== "string");
}

const builtin = (agent: AgentId): Profile => ({ id: agent, label: AGENT_LABEL[agent], agent, bin: process.env[BIN_ENV[agent]] || undefined });

const expand = (v: string) => v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, k: string) => process.env[k] ?? "");

function resolve(p: Profile, isBuiltin: boolean): ResolvedProfile {
  const bin = p.bin ?? process.env[BIN_ENV[p.agent]] ?? DEFAULT_BIN[p.agent];
  return {
    ...p,
    binPath: resolveBin(bin),
    args: p.args ?? [],
    env: Object.fromEntries(Object.entries(p.env ?? {}).map(([k, v]) => [k, expand(v)])),
    builtin: isBuiltin,
  };
}

/** Every profile: built-ins first (unless overridden), then the config file's, in file order. */
export function allProfiles(): ResolvedProfile[] {
  const user = userProfiles();
  const byId = new Map(user.map((p) => [p.id, p]));
  const out: ResolvedProfile[] = [];
  for (const agent of AGENT_IDS) {
    const own = byId.get(agent);
    out.push(resolve(own ? { ...builtin(agent), ...own, agent } : builtin(agent), true));
  }
  for (const p of user) if (!AGENT_IDS.includes(p.id as AgentId)) out.push(resolve(p, false));
  return out;
}

export const getProfile = (id: string | null | undefined) => (id ? (allProfiles().find((p) => p.id === id) ?? null) : null);

/** The profile a request asked for (if it fits the agent), else the one the session last used, else the agent's own. */
export function pickProfile(agent: AgentId, requested: unknown, sessionKey?: string | null): ResolvedProfile {
  const want = typeof requested === "string" ? getProfile(requested) : null;
  if (want && want.agent === agent) return want;
  const used = sessionKey ? getProfile(sessionProfile(sessionKey)) : null;
  if (used && used.agent === agent) return used;
  return getProfile(agent) ?? resolve(builtin(agent), true);
}

/** The model a turn runs on: the one asked for, else the profile's default, else (Claude only) Opus 5.5. */
export function modelFor(p: ResolvedProfile | null, requested?: string | null): string | undefined {
  if (requested) return requested;
  if (p?.defaultModel || p?.models?.length) return p.defaultModel ?? p.models?.[0];
  return !p || p.agent === "claude" ? CLAUDE_DEFAULT_MODEL : undefined;
}

const SECRET = /KEY|TOKEN|SECRET|PASSWORD|AUTH/i;
const MASK = "••••••";

/** For the browser: secrets that aren't ${VAR} references are masked; saving the mask keeps the old value. */
export function profileInfo(p: ResolvedProfile): ProfileInfo {
  const stored = userProfiles().find((u) => u.id === p.id);
  const raw = stored?.env ?? {};
  return {
    id: p.id,
    label: p.label,
    agent: p.agent,
    bin: p.bin ?? "",
    binPath: p.binPath,
    installed: Boolean(p.binPath) || p.agent === "claude",
    args: p.args,
    env: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, SECRET.test(k) && !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(v) ? MASK : v])),
    models: p.models ?? [],
    defaultModel: p.defaultModel ?? null,
    fallback: p.fallback ?? [],
    launchArgs: p.launchArgs ?? [],
    hidden: Boolean(p.hidden),
    notes: p.notes ?? "",
    builtin: p.builtin,
    custom: Boolean(stored),
  };
}

/** Replaces the config file's profiles. Masked secrets keep their stored value. */
export function saveProfiles(list: unknown[]): { ok: true } | { error: string } {
  const old = new Map(userProfiles().map((p) => [p.id, p]));
  const out: Profile[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const p = parseProfile(raw);
    if (typeof p === "string") return { error: p };
    if (seen.has(p.id)) return { error: `Two profiles are called ${p.id}.` };
    seen.add(p.id);
    const prev = raw && typeof raw === "object" && typeof (raw as { previousId?: unknown }).previousId === "string" ? (raw as { previousId: string }).previousId : p.id;
    if (p.env) for (const [k, v] of Object.entries(p.env)) if (v === MASK) p.env[k] = old.get(prev)?.env?.[k] ?? old.get(p.id)?.env?.[k] ?? "";
    /* keep the file as short as a hand-written one */
    const lean = Object.fromEntries(
      Object.entries(p).filter(([, v]) => v !== undefined && v !== "" && v !== false && !(Array.isArray(v) && !v.length) && !(v && typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length)),
    ) as Profile;
    out.push(lean);
  }
  const cfg = readConfig();
  writeJson(CONFIG_PATH, { ...cfg, profiles: out });
  cache = null;
  return { ok: true };
}

/* ── which profile a session runs on ─────────────────────── */

type State = { sessionProfiles?: Record<string, string> };
const readState = (): State => {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as State;
  } catch {
    return {};
  }
};

export const sessionProfile = (key: string) => readState().sessionProfiles?.[key] ?? null;

export function setSessionProfile(key: string, profile: string) {
  const s = readState();
  if (s.sessionProfiles?.[key] === profile) return;
  const map = { ...(s.sessionProfiles ?? {}), [key]: profile };
  /* keep the newest few thousand */
  const keys = Object.keys(map);
  for (const k of keys.slice(0, Math.max(0, keys.length - 5000))) delete map[k];
  try {
    writeJson(STATE_PATH, { ...s, sessionProfiles: map });
  } catch {
    /* read-only home: the session falls back to the agent's own profile */
  }
}

/* ── the profile a request runs under ────────────────────── */

const scope: AsyncLocalStorage<ResolvedProfile> = (() => {
  const g = globalThis as typeof globalThis & { __agentuProfileScope?: AsyncLocalStorage<ResolvedProfile> };
  return (g.__agentuProfileScope ??= new AsyncLocalStorage<ResolvedProfile>());
})();

/** Runs `fn` with `profile` active: agent CLIs it spawns use the profile's binary, arguments and environment. */
export const withProfile = <T>(profile: ResolvedProfile | null, fn: () => T): T => (profile ? scope.run(profile, fn) : fn());
export const activeProfile = () => scope.getStore() ?? null;

/** The active profile's binary when it has one, else the adapter's own lookup. */
export async function profileBin(find: () => Promise<string | null>): Promise<string | null> {
  const p = activeProfile();
  if (p?.bin) return p.binPath;
  return find();
}

/** Errors that mean "try another account/model", not "the request was wrong". */
export const LIMIT_ERROR = /rate.?limit|usage limit|limit reached|quota|\b429\b|capacity|overloaded|credit balance|out of credits|insufficient[_ ](quota|funds|balance)|too many requests|billing|exhausted/i;
