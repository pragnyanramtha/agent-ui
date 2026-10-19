"use client";

import { lazyComponent } from "@/lib/client/lazy";
import type { Entry, ToolResult } from "@/lib/types";
import { lineDiff } from "@/lib/client/diff";

type Edit = { before: string; after: string; ts: string; kind: "edit" | "write"; failed: boolean };
export type FileChange = { path: string; edits: Edit[]; added: number; removed: number; last: string };

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Every file the loaded part of the conversation edited or wrote, newest first, with its diffs. */
export function collectChanges(entries: Entry[], results: Record<string, ToolResult>): FileChange[] {
  const files = new Map<string, FileChange>();
  for (const e of entries) {
    if (e.kind !== "tool") continue;
    const path = str(e.input.file_path) || str(e.input.notebook_path);
    if (!path) continue;
    const failed = Boolean(results[e.toolUseId]?.isError);
    let edits: Edit[] = [];
    if (e.name === "Edit") edits = [{ before: str(e.input.old_string), after: str(e.input.new_string), ts: e.ts, kind: "edit", failed }];
    else if (e.name === "MultiEdit" && Array.isArray(e.input.edits))
      edits = (e.input.edits as ({ old_string?: unknown; new_string?: unknown } | null)[]).map((x) => ({ before: str(x?.old_string), after: str(x?.new_string), ts: e.ts, kind: "edit" as const, failed }));
    else if (e.name === "Write") edits = [{ before: "", after: str(e.input.content), ts: e.ts, kind: "write", failed }];
    else if (e.name === "NotebookEdit") edits = [{ before: "", after: str(e.input.new_source), ts: e.ts, kind: "edit", failed }];
    else continue;
    const f = files.get(path) ?? { path, edits: [], added: 0, removed: 0, last: e.ts };
    for (const ed of edits) {
      f.edits.push(ed);
      if (ed.failed) continue;
      for (const l of lineDiff(ed.before, ed.after)) {
        if (l.tone === "add") f.added++;
        else if (l.tone === "del") f.removed++;
      }
    }
    f.last = e.ts;
    files.set(path, f);
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
