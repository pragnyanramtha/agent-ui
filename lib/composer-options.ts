import type { PermissionMode } from "@/lib/types";

export const MODES: { key: PermissionMode; name: string; short: string; desc: string }[] = [
  { key: "default", name: "Ask before acting", short: "Ask first", desc: "Approve edits and commands here" },
  { key: "acceptEdits", name: "Accept edits", short: "Accept edits", desc: "File edits go through, commands still ask" },
  { key: "plan", name: "Plan only", short: "Plan", desc: "Read and propose, no changes" },
  { key: "bypassPermissions", name: "Bypass approvals", short: "Bypass", desc: "Everything runs without asking" },
];

/* full ids: the bare aliases lag behind (on current Claude Code "haiku" is still Haiku 4.5); the server defaults to the first */
export const MODELS = [
  { key: "claude-opus-5-5", name: "Opus 5.5" },
  { key: "claude-sonnet-5-5", name: "Sonnet 5.5" },
  { key: "claude-haiku-5-5", name: "Haiku 5.5" },
];

export function modelLabel(model: string | null) {
  if (!model) return "Default";
  if (/^(opus|sonnet|haiku)$/.test(model)) return MODELS.find((x) => x.key.includes(model))!.name;
  const m = /claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?/.exec(model);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] && m[3].length < 3 ? `.${m[3]}` : ""}`;
  return MODELS.find((x) => x.key === model)?.name ?? model;
}
