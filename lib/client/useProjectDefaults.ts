"use client";

import { useCallback, useState } from "react";
import type { AgentId, ProfileInfo } from "@/lib/types";
import { EFFORT_SETTING } from "@/lib/settings-schema";
import { resolveNewSession, type PickedField, type SessionChoice } from "@/lib/projects";
import { useSetting } from "./settings";
import { useProjectFor } from "./projects";

/**
 * The new session screen's choices with the folder's project defaults (Settings > Projects) filled in.
 * `current` is the screen's own state; fields the user sets there (call `pick`) always win over the project.
 * Worktree is kept here: a project's on/off is a default for this screen, not a change to Settings > Git.
 */
export function useProjectDefaults({ cwd, current, profiles }: { cwd: string; current: Omit<SessionChoice, "worktree">; profiles: ProfileInfo[] | null }) {
  const { project } = useProjectFor(cwd, 250);
  const [picked, setPicked] = useState<Partial<Record<PickedField, boolean>>>({});
  const [worktreeSetting, setWorktreeSetting] = useSetting("newSessionWorktree");
  const [worktreePick, setWorktreePick] = useState<boolean | null>(null);
  const [claudeEffort] = useSetting("effortClaude");
  const [codexEffort] = useSetting("effortCodex");
  const pick = useCallback((f: PickedField) => setPicked((p) => (p[f] ? p : { ...p, [f]: true })), []);

  const efforts: Record<string, string> = { effortClaude: claudeEffort, effortCodex: codexEffort };
  const resolved = resolveNewSession({
    current: { ...current, worktree: worktreePick ?? worktreeSetting },
    picked: { ...picked, worktree: worktreePick !== null },
    project,
    profiles,
    settingsEffort: (a: AgentId) => {
      const key = EFFORT_SETTING[a];
      const v = key ? efforts[key] : undefined;
      return v && v !== "default" ? v : "";
    },
  });

  /* with no project override, the switch is still Settings > Git's, as before */
  const setWorktree = (v: boolean) => (project?.worktree || worktreePick !== null ? setWorktreePick(v) : setWorktreeSetting(v));

  return { ...resolved, project, pick, setWorktree };
}
