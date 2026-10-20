"use client";

import { lazyComponent } from "@/lib/client/lazy";
import type { Entry, ToolResult } from "@/lib/types";
import { editCounts, toolEdits } from "@/lib/client/file-edits";

type Edit = { before: string; after: string; ts: string; kind: "edit" | "write" | "delete"; failed: boolean };
export type FileChange = { path: string; edits: Edit[]; added: number; removed: number; last: string };

/** Every file the loaded part of the conversation edited or wrote, newest first, with its diffs. */
export function collectChanges(entries: Entry[], results: Record<string, ToolResult>): FileChange[] {
  const files = new Map<string, FileChange>();
  for (const e of entries) {
    if (e.kind !== "tool") continue;
    const failed = Boolean(results[e.toolUseId]?.isError);
    for (const ed of toolEdits(e)) {
      if (!ed.path) continue;
      const f = files.get(ed.path) ?? { path: ed.path, edits: [], added: 0, removed: 0, last: e.ts };
      f.edits.push({ before: ed.before, after: ed.after, ts: e.ts, kind: ed.kind, failed });
      if (!failed) {
        const c = editCounts(ed);
        f.added += c.added;
        f.removed += c.removed;
      }
      f.last = e.ts;
      files.set(ed.path, f);
    }
  }
  return [...files.values()].sort((a, b) => b.last.localeCompare(a.last));
}

/** OpenCode-style review pane: files changed in this session, each expandable to its edits. Loads on first open. */
export const ChangesPanel = lazyComponent(
  () => import("./ChangesView").then((m) => m.ChangesView),
  () => (
    <div
      role="status"
      className="absolute inset-0 z-20 flex items-center justify-center bg-page p-6 text-sm text-ink-3 lg:static lg:inset-auto lg:w-[440px] lg:shrink-0 lg:border-l lg:border-line xl:w-[520px]"
    >
      Loading changes…
    </div>
  ),
);
