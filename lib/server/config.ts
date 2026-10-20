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

/** Claude Code names project folders after the cwd with every non-alphanumeric char replaced by "-". */
export const projectDirFor = (cwd: string) => path.join(PROJECTS_DIR, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
