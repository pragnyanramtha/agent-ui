"use client";

import { useEffect, useRef } from "react";
import type { FileChange } from "@/components/claude/ChangesPanel";
import { useSetting } from "./settings";

/** the session and its edit count when a web turn was first seen running */
export type TurnStart = { session: string; edits: number } | null;

/** One look at the session: remembers where a running turn started, and says to open the panel when it ends with
 * more edits than it started with. Switching sessions mid-turn never opens anything. */
export function autoOpenStep(start: TurnStart, now: { session: string; busy: boolean; edits: number; on: boolean }): { start: TurnStart; open: boolean } {
  if (now.busy) return { start: start?.session === now.session ? start : { session: now.session, edits: now.edits }, open: false };
  return { start: null, open: Boolean(now.on && start && start.session === now.session && now.edits > start.edits) };
}

export const editCount = (changes: readonly FileChange[]) => changes.reduce((n, f) => n + f.edits.length, 0);

/** Settings > Git > Open changes after a turn: calls `open` when a turn sent from the web ends having edited files. */
export function useAutoOpenDiff(session: string, webBusy: boolean, changes: readonly FileChange[], open: () => void) {
  const [on] = useSetting("autoOpenDiff");
  const edits = editCount(changes);
  const start = useRef<TurnStart>(null);
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    const step = autoOpenStep(start.current, { session, busy: webBusy, edits, on });
    start.current = step.start;
    if (step.open) openRef.current();
  }, [session, webBusy, edits, on]);
}
