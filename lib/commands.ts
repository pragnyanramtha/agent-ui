export type SlashKind = "app" | "builtin" | "command" | "skill";

export type SlashItem = { name: string; description: string; kind: SlashKind; hint?: string };

/** Handled in the browser, never sent to Claude. */
export const APP_COMMANDS: SlashItem[] = [
  { name: "model", description: "Switch model: opus, sonnet, haiku, or default", kind: "app", hint: "opus" },
  { name: "mode", description: "Approval mode: ask, edits, plan, or bypass", kind: "app", hint: "plan" },
  { name: "stop", description: "Stop the current turn", kind: "app" },
  { name: "new", description: "Start a new session", kind: "app" },
  { name: "end", description: "End the session. History stays.", kind: "app" },
];

/** Claude Code commands that work in SDK-driven sessions. */
export const BUILTIN_COMMANDS: SlashItem[] = [
  { name: "compact", description: "Summarize to free context", kind: "builtin", hint: "focus on the API work" },
  { name: "context", description: "Show what's using the context window", kind: "builtin" },
  { name: "cost", description: "Show token usage and cost for this session", kind: "builtin" },
  { name: "init", description: "Create CLAUDE.md for this project", kind: "builtin" },
  { name: "review", description: "Review a pull request", kind: "builtin", hint: "123" },
  { name: "security-review", description: "Security review of the pending changes", kind: "builtin" },
  { name: "pr-comments", description: "Load comments from a pull request", kind: "builtin" },
  { name: "release-notes", description: "Show the Claude Code release notes", kind: "builtin" },
  { name: "todos", description: "List the current todo items", kind: "builtin" },
];

export const MODE_ALIASES: Record<string, "default" | "acceptEdits" | "plan" | "bypassPermissions"> = {
  ask: "default",
  default: "default",
  edits: "acceptEdits",
  accept: "acceptEdits",
  acceptedits: "acceptEdits",
  plan: "plan",
  bypass: "bypassPermissions",
  yolo: "bypassPermissions",
};

/** Prefix matches first, then name contains, then description contains. */
export function rankCommands(items: SlashItem[], query: string, limit = 60) {
  const q = query.toLowerCase();
  if (!q) return items.slice(0, limit);
  const score = (c: SlashItem) => {
    const n = c.name.toLowerCase();
    if (n === q) return 0;
    if (n.startsWith(q)) return 1;
    if (n.includes(q)) return 2;
    if (c.description.toLowerCase().includes(q)) return 3;
    return 9;
  };
  return items
    .map((c, i) => ({ c, s: score(c), i }))
    .filter((x) => x.s < 9)
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.c);
}
