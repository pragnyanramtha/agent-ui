import type { ReactNode } from "react";
import { AGENT_LABEL, type AgentId } from "@/lib/types";

/* Small monochrome marks per agent: simple geometric glyphs that suggest each product, not their logos. They draw in
 * currentColor; `tone` colors them with the agent's color (Claude stays neutral, like everywhere else). */

export const AGENT_TEXT: Record<AgentId, string> = {
  claude: "text-ink",
  codex: "text-agent-codex",
  opencode: "text-agent-opencode",
  cursor: "text-agent-cursor",
  devin: "text-agent-devin",
  kimi: "text-agent-kimi",
  gemini: "text-agent-gemini",
  antigravity: "text-agent-antigravity",
};

const line = { fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" } as const;

const GLYPH: Record<AgentId, ReactNode> = {
  /* a six-ray spark */
  claude: <path {...line} strokeWidth={1.9} d="M8 2v12M2.8 5l10.4 6M2.8 11l10.4-6" />,
  /* a prompt in a rounded square */
  codex: (
    <>
      <rect {...line} x="1.75" y="1.75" width="12.5" height="12.5" rx="3.5" />
      <path {...line} d="M5.25 6.25 7.25 8l-2 1.75M8.75 10.25h2" />
    </>
  ),
  /* square brackets around a block */
  opencode: (
    <>
      <path {...line} d="M5.5 2.5h-2v11h2M10.5 2.5h2v11h-2" />
      <rect x="6.5" y="6.5" width="3" height="3" rx="0.75" fill="currentColor" />
    </>
  ),
  /* a pointer */
  cursor: <path fill="currentColor" d="M3.2 2.4a.6.6 0 0 1 .8-.6l9.1 4.1a.6.6 0 0 1-.1 1.1L9.3 8.3 7.9 12a.6.6 0 0 1-1.1.1z" />,
  /* a rounded D */
  devin: (
    <>
      <path {...line} d="M4 2.5h3.25a5.5 5.5 0 0 1 0 11H4z" />
      <circle cx="7.5" cy="8" r="1.4" fill="currentColor" />
    </>
  ),
  /* a crescent */
  kimi: <path fill="currentColor" d="M10.6 1.9a6.25 6.25 0 1 0 3.6 10.2A5.1 5.1 0 0 1 10.6 1.9z" />,
  /* a four-point sparkle */
  gemini: <path fill="currentColor" d="M8 1.25c.55 3.5 2.25 5.2 6.75 6.75C10.25 9.55 8.55 11.25 8 14.75 7.45 11.25 5.75 9.55 1.25 8 5.75 6.45 7.45 4.75 8 1.25z" />,
  /* rising chevrons */
  antigravity: <path {...line} strokeWidth={1.9} d="M3.5 8 8 3.5 12.5 8M3.5 12.5 8 8l4.5 4.5" />,
};

export function AgentIcon({ agent, size = 14, tone = true, label = false, className = "" }: { agent: AgentId; size?: number; tone?: boolean; label?: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      role={label ? "img" : undefined}
      aria-label={label ? AGENT_LABEL[agent] : undefined}
      aria-hidden={label ? undefined : true}
      className={`shrink-0 ${tone ? AGENT_TEXT[agent] : ""} ${className}`}
    >
      {label && <title>{AGENT_LABEL[agent]}</title>}
      {GLYPH[agent]}
    </svg>
  );
}
