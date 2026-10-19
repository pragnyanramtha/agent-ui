import { parseEffort } from "./agent-traits";
import type { AgentId, PermissionMode, ProfileInfo } from "./types";

/* Per-project settings, keyed by the project's absolute folder: defaults for new sessions started there and the
 * commands its Run menu offers. Shared by the browser and the server (no Node, no React). */

export const ACTION_ICONS = ["play", "test", "build", "lint", "debug", "deploy", "terminal"] as const;
export type ActionIcon = (typeof ACTION_ICONS)[number];

export type ProjectAction = { id: string; name: string; command: string; icon: ActionIcon };

export type ProjectConfig = {
  /** absolute, without a trailing slash */
  path: string;
  name?: string;
  profile?: string;
  /** only with `profile`: model ids belong to a profile */
  model?: string;
  mode?: PermissionMode;
  effort?: string;
  /** unset follows Settings > Git */
  worktree?: "on" | "off";
  /** put before the branch name of worktrees made for new sessions here; default "agent-u/" */
  branchPrefix?: string;
  actions: ProjectAction[];
};

/** A row of Settings > Projects: a configured project, a folder sessions ran in, or both. */
export type ProjectEntry = {
  path: string;
  /** the configured name, else the folder's name */
  name: string;
  config: ProjectConfig | null;
  sessions: number;
  lastActive: number | null;
  exists: boolean;
};

export type PackageManager = "pnpm" | "yarn" | "npm" | "bun";
export type ScriptSeed = { manager: PackageManager | null; actions: Omit<ProjectAction, "id">[] };

export const PROJECT_LIMITS = { projects: 200, actions: 20, name: 60, actionName: 40, command: 500, model: 100, prefix: 40, path: 1024 } as const;

export const DEFAULT_BRANCH_PREFIX = "agent-u/";

/** Agents whose web turns can stop and ask for approval; the others only run plan-only or unattended. */
export const canAsk = (agent: AgentId) => agent === "claude" || agent === "codex";

/* ── new session defaults ─────────────────────────────────── */

export type SessionChoice = { agent: AgentId; profile: string; model: string; mode: PermissionMode; effort: string; worktree: boolean };
export type PickedField = "profile" | "model" | "mode" | "effort" | "worktree";

type ProfileLite = Pick<ProfileInfo, "id" | "agent" | "installed" | "hidden" | "defaultEffort">;

export type ResolvedChoice = SessionChoice & {
  /** what goes to the server: the session's effort, else the profile's default, else Settings > Composer */
  sentEffort: string;
  /** the fields the project decided */
  fromProject: PickedField[];
};

/**
 * What a new session starts with. Each field: what the user picked on the new session screen, else the project's
 * default, else what the screen would use anyway (the profile last used, the agent's mode, Settings).
 * `current` is the screen's own state; `picked` names the fields the user set there themselves.
 * Effort goes one step further for the server: the profile's default effort, then the one in Settings.
 */
export function resolveNewSession(o: {
  current: SessionChoice;
  picked: Partial<Record<PickedField, boolean>>;
  project: ProjectConfig | null;
  profiles: ProfileLite[] | null;
  settingsEffort: (agent: AgentId) => string;
}): ResolvedChoice {
  const { current, picked, project, profiles } = o;
  const out: ResolvedChoice = { ...current, sentEffort: "", fromProject: [] };
  const own = project?.profile ? profiles?.find((p) => p.id === project.profile && p.installed) : undefined;
  if (own && !picked.profile) {
    out.profile = own.id;
    out.agent = own.agent;
    out.fromProject.push("profile");
  }
  if (project?.model && !picked.model && project.profile === out.profile) {
    out.model = project.model;
    out.fromProject.push("model");
  } else if (!picked.model && out.profile !== current.profile) out.model = "";
  if (project?.mode && !picked.mode && (canAsk(out.agent) || project.mode === "bypassPermissions" || project.mode === "plan")) {
    out.mode = project.mode;
    out.fromProject.push("mode");
  } else if (!picked.mode && out.agent !== current.agent) {
    /* the project switched the agent: its usual mode, as when the agent is picked by hand */
    out.mode = out.agent === "claude" ? "default" : "bypassPermissions";
  }
  if (project?.effort && !picked.effort && parseEffort(out.agent, project.effort)) {
    out.effort = project.effort;
    out.fromProject.push("effort");
  } else if (!picked.effort && out.agent !== current.agent) out.effort = "";
  if (project?.worktree && !picked.worktree) {
    out.worktree = project.worktree === "on";
    out.fromProject.push("worktree");
  }
  const profile = profiles?.find((p) => p.id === out.profile);
  /* until profiles load, the profile's own default is unknown: send none rather than one it would override */
  out.sentEffort = out.effort || (profiles ? profile?.defaultEffort || o.settingsEffort(out.agent) || "" : "");
  return out;
}

/* ── small helpers both sides use ─────────────────────────── */

export const folderName = (p: string) => p.replace(/\/+$/, "").split("/").pop() || "/";

/** The project a folder belongs to among `list`: the same folder, else the nearest one above it. */
export function nearestProject<T extends { path: string }>(list: readonly T[], dir: string): T | null {
  const d = dir.replace(/\/+$/, "") || "/";
  let best: T | null = null;
  for (const p of list) {
    const base = p.path === "/" ? "/" : `${p.path}/`;
    if ((d === p.path || d.startsWith(base)) && (!best || p.path.length > best.path.length)) best = p;
  }
  return best;
}
