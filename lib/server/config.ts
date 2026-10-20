import os from "node:os";
import path from "node:path";

const home = os.homedir();

export const CLAUDE_HOME = process.env.CLAUDE_HOME ?? path.join(home, ".claude");
export const PROJECTS_DIR = path.join(CLAUDE_HOME, "projects");
export const LIVE_SESSIONS_DIR = path.join(CLAUDE_HOME, "sessions");

/** Path to the `claude` binary the SDK should drive; falls back to the SDK's bundled CLI. */
export const CLAUDE_BIN = process.env.CLAUDE_BIN || undefined;

/** Model for Claude sessions when neither the composer nor the profile names one. */
export const CLAUDE_DEFAULT_MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";

/** "tmux" (default): web-started Claude sessions run Claude's own TUI in a kept tmux session; "sdk": through the Agent SDK. */
export const CLAUDE_WEB_DRIVER = process.env.CLAUDE_WEB_DRIVER === "sdk" ? "sdk" : "tmux";

/** Project folders (substring match) that never show up in the session list. */
export const HIDDEN_PROJECTS = (process.env.HIDE_PROJECTS ?? "claude-mem-observer")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Web runs with no viewers are shut down after this long idle, freeing the claude process. */
export const IDLE_REAP_MS = Number(process.env.IDLE_REAP_MS ?? 20 * 60_000);

const MAX_DIR_NAME = 200;

/** The 32-bit string hash Claude Code appends to long folder names, in base 36. */
function nameHash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i) | 0;
  return Math.abs(h).toString(36);
}

/** Claude Code's project folder name for a cwd: every non-alphanumeric char replaced by "-", and names over 200 chars
 * cut to 200 with "-<hash of the cwd>" appended (as the Agent SDK and CLI do). */
export function projectDirName(cwd: string) {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return name.length <= MAX_DIR_NAME ? name : `${name.slice(0, MAX_DIR_NAME)}-${nameHash(cwd)}`;
}

export const projectDirFor = (cwd: string) => path.join(PROJECTS_DIR, projectDirName(cwd));
