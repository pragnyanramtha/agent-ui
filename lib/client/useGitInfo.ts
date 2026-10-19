"use client";

import { useEffect, useState } from "react";
import type { CheckpointRef } from "./turns";

export type GitInfo = { branch: string | null; checkpoints: CheckpointRef[] };

/**
 * The session folder's branch and checkpoints (GET /api/git). Fetched again whenever `key` changes
 * (the caller passes something that moves when a turn starts or ends); null while unknown or not a repo.
 */
export function useGitInfo(session: string, key: string): GitInfo | null {
  const [state, setState] = useState<{ session: string; info: GitInfo | null } | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/git?session=${encodeURIComponent(session)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { repo?: { branch?: string | null } | null; checkpoints?: CheckpointRef[] } | null) => {
        if (!live) return;
        setState({ session, info: d?.repo ? { branch: d.repo.branch ?? null, checkpoints: d.checkpoints ?? [] } : null });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [session, key]);
  return state?.session === session ? state.info : null;
}
