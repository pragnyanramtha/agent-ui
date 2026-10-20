import { AGENT_IDS } from "@/lib/types";
import type { AgentAdapter, AgentId } from "./types";

/* Registry of non-Claude agent adapters. Each lives in its own file and is
 * added here; ids in URLs are "<agent>:<nativeId>", plain UUIDs stay Claude. */

const adapters: Partial<Record<AgentId, () => Promise<AgentAdapter>>> = {
  codex: () => import("./codex").then((m) => m.default),
  opencode: () => import("./opencode").then((m) => m.default),
  cursor: () => import("./cursor").then((m) => m.default),
  devin: () => import("./devin").then((m) => m.default),
  kimi: () => import("./kimi").then((m) => m.default),
  gemini: () => import("./gemini").then((m) => m.default),
  antigravity: () => import("./antigravity").then((m) => m.default),
};

export async function adapterFor(id: AgentId): Promise<AgentAdapter | null> {
  return (await adapters[id]?.()) ?? null;
}

export async function allAdapters(): Promise<AgentAdapter[]> {
  return Promise.all(Object.values(adapters).map((load) => load!()));
}

/* never starts with "-" or ".": ids end up as CLI arguments (`codex resume <id>`) */
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const AGENTS: AgentId[] = AGENT_IDS;

/** "codex:abc" -> { agent: "codex", native: "abc" }; a bare id is Claude (backwards compatible). */
export function parseSessionKey(key: string): { agent: AgentId; native: string } | null {
  const i = key.indexOf(":");
  if (i === -1) return SAFE.test(key) ? { agent: "claude", native: key } : null;
  const agent = key.slice(0, i) as AgentId;
  const native = key.slice(i + 1);
  return AGENTS.includes(agent) && SAFE.test(native) ? { agent, native } : null;
}

export const sessionKey = (agent: AgentId, native: string) => (agent === "claude" ? native : `${agent}:${native}`);
