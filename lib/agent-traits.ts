import type { AgentId } from "./types";

/* What each agent's driver lets you tune per turn beyond the model. Only levels the driver
 * really passes through are listed; an agent with none shows no effort control.
 *  - claude: the Agent SDK's `effort` option (web turns, changed mid-run with applyFlagSettings) and
 *    `claude --effort <level>` (terminals). Models without a level run at the nearest one they have.
 *  - codex: app-server `turn/start {effort}`, and `-c model_reasoning_effort="<level>"` for
 *    `codex exec` and the interactive TUI.
 *  - opencode, cursor, devin, kimi, gemini, antigravity: none. Their print modes take no effort flag
 *    (Cursor and OpenCode pick effort through the model id or variant instead). */

export type EffortOption = { key: string; name: string; desc: string };

const EFFORTS: Partial<Record<AgentId, EffortOption[]>> = {
  claude: [
    { key: "low", name: "Low", desc: "Fastest, least thinking" },
    { key: "medium", name: "Medium", desc: "Balanced" },
    { key: "high", name: "High", desc: "Thinks longer" },
    { key: "xhigh", name: "Extra high", desc: "Deeper reasoning where the model has it" },
    { key: "max", name: "Max", desc: "Most thinking, this session only" },
  ],
  codex: [
    { key: "low", name: "Low", desc: "Fastest, least reasoning" },
    { key: "medium", name: "Medium", desc: "Balanced" },
    { key: "high", name: "High", desc: "Reasons longer" },
    { key: "xhigh", name: "Extra high", desc: "Deepest, on models that support it" },
  ],
};

/** The effort levels an agent offers, in order; empty when it has none. */
export const effortOptions = (agent: AgentId): EffortOption[] => EFFORTS[agent] ?? [];

/**
 * Reads an effort sent by a client or written in a profile:
 * a level the agent offers, null for "the default" ("" or null), undefined when absent or not valid for the agent.
 */
export function parseEffort(agent: AgentId, raw: unknown): string | null | undefined {
  if (raw === null || raw === "") return null;
  if (typeof raw !== "string") return undefined;
  const v = raw.trim().toLowerCase();
  return effortOptions(agent).some((o) => o.key === v) ? v : undefined;
}

export function effortLabel(agent: AgentId, effort: string | null | undefined): string | null {
  return (effort && effortOptions(agent).find((o) => o.key === effort)?.name) || null;
}

/** Flags that set the effort on the agent's CLI (interactive TUI, and `codex exec`). */
export function effortArgs(agent: AgentId, effort: string | null | undefined): string[] {
  const e = parseEffort(agent, effort);
  if (!e) return [];
  if (agent === "claude") return ["--effort", e];
  if (agent === "codex") return ["-c", `model_reasoning_effort="${e}"`];
  return [];
}

/** Words `/effort` accepts besides the level keys. */
const ALIASES: Record<string, string> = { med: "medium", mid: "medium", "extra-high": "xhigh", "extra high": "xhigh", extrahigh: "xhigh", maximum: "max" };

/** `/effort <word>` → a level, "" for default, or null when the agent doesn't have it. */
export function effortFromCommand(agent: AgentId, arg: string): string | null {
  const a = arg.trim().toLowerCase();
  if (a === "default" || a === "auto" || a === "reset") return "";
  const v = ALIASES[a] ?? a;
  const byName = effortOptions(agent).find((o) => o.key === v || o.name.toLowerCase() === a);
  return byName?.key ?? null;
}
