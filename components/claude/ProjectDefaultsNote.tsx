"use client";

import { folderName, type PickedField, type ProjectConfig } from "@/lib/projects";

const FIELD: Record<PickedField, string> = { profile: "profile", model: "model", mode: "approvals", effort: "effort", worktree: "worktree" };

/** A quiet mark on the new session screen: these choices came from the folder's project settings. */
export function ProjectDefaultsNote({ project, fields }: { project: ProjectConfig; fields: PickedField[] }) {
  const name = project.name ?? folderName(project.path);
  const list = fields.map((f) => FIELD[f]);
  const what = list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list.at(-1)}` : list[0];
  return (
    <span className="inline-flex h-6 min-w-0 shrink items-center truncate px-1 text-ink-3" title={`From Settings > Projects > ${name}: ${what}. What you pick here wins for this session.`}>
      <span className="truncate">Defaults from {name}</span>
    </span>
  );
}
