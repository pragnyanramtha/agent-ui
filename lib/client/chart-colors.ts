import type { AgentId } from "@/lib/types";

/* Theme tokens the Usage chart stacks with, so both themes and custom palettes apply. Each must reach 3:1 against
 * --surface in both themes (tests/usage-colors.test.ts). */

export const AGENT_CHART_TOKEN: Record<AgentId, string> = {
  claude: "orange-ink",
  codex: "agent-codex",
  opencode: "agent-opencode",
  cursor: "agent-cursor",
  devin: "agent-devin",
  kimi: "agent-kimi",
  gemini: "agent-gemini",
  antigravity: "agent-antigravity",
};

export const SERIES_TOKENS = ["accent", "orange-ink", "agent-codex", "agent-devin", "agent-cursor"] as const;
export const OTHER_TOKEN = "ink-3";

export const tokenVar = (token: string) => `var(--${token})`;
