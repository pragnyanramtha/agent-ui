import type { PermissionMode } from "@/lib/types";

export const MODES: { key: PermissionMode; name: string; short: string; desc: string }[] = [
  { key: "default", name: "Ask before acting", short: "Ask first", desc: "Approve edits and commands here" },
  { key: "acceptEdits", name: "Accept edits", short: "Accept edits", desc: "File edits go through, commands still ask" },
  { key: "plan", name: "Plan only", short: "Plan", desc: "Read and propose, no changes" },
  { key: "bypassPermissions", name: "Bypass approvals", short: "Bypass", desc: "Everything runs without asking" },
];

export const MODELS = [
  { key: "", name: "Default" },
  { key: "opus", name: "Opus" },
  { key: "sonnet", name: "Sonnet" },
  /* the "haiku" alias still resolves to Haiku 4.5 on current Claude Code */
  { key: "claude-haiku-5-5", name: "Haiku 5.5" },
];

export function modelLabel(model: string | null) {
  if (!model) return "Default";
  const m = /claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?/.exec(model);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] && m[3].length < 3 ? `.${m[3]}` : ""}`;
  return MODELS.find((x) => x.key === model)?.name ?? model;
}
