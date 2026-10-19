"use client";

import { isPlainText } from "@/lib/client/highlight";
import { useEffect, useMemo, useRef, useState } from "react";
import { NavArrowDown, Xmark } from "iconoir-react";
import type { Entry, ToolResult } from "@/lib/types";
import { lineDiff } from "@/lib/client/diff";
import { DiffBlock } from "./DiffBlock";
import { PathLabel } from "./PathLabel";
import { OPEN_FILES_EVENT } from "./FilesScreen";
import { modalOpen } from "@/lib/client/shortcuts";

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

/** OpenCode-style review pane: files changed in this session, each expandable to its edits. */
export function ChangesPanel({ changes, cwd, partial, onClose }: { changes: FileChange[]; cwd: string; partial: boolean; onClose: () => void }) {
  const [open, setOpen] = useState<string | null>(changes[0]?.path ?? null);
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const totals = useMemo(() => changes.reduce((t, f) => ({ added: t.added + f.added, removed: t.removed + f.removed }), { added: 0, removed: 0 }), [changes]);
  const rel = (p: string) => (cwd && p.startsWith(`${cwd.replace(/\/+$/, "")}/`) ? p.slice(cwd.replace(/\/+$/, "").length + 1) : p);

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && !modalOpen() && closeRef.current();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <aside
      ref={ref}
      tabIndex={-1}
      aria-label="Changes"
      className="absolute inset-0 z-20 flex flex-col bg-page outline-none lg:static lg:inset-auto lg:w-[440px] lg:shrink-0 lg:border-l lg:border-line xl:w-[520px]"
      style={{ animation: "fade-up 220ms cubic-bezier(0.23,1,0.32,1) both" }}
    >
      <div className="safe-top flex shrink-0 items-center gap-2 border-b border-line px-3 sm:px-4">
        <div className="flex h-14 min-w-0 flex-1 items-center gap-2">
          <span className="text-[14px] font-semibold text-ink">Changes</span>
          <span className="text-[12px] text-ink-3 tabular-nums">
            {changes.length} {changes.length === 1 ? "file" : "files"}
          </span>
          <span className="font-mono text-[12px] tabular-nums">
            <span className="text-green">+{totals.added}</span> <span className="text-red">-{totals.removed}</span>
          </span>
          <button type="button" onClick={onClose} aria-label="Close changes" className="tap relative ml-auto flex size-9 items-center justify-center rounded-[9px] text-ink-3 hover:bg-hover hover:text-ink">
            <Xmark width={16} height={16} strokeWidth={2} />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2 sm:px-3">
        {partial && <p className="px-2 pb-2 text-[11.5px] text-ink-3">From the loaded part of the conversation. Load earlier messages to include older edits.</p>}
        {changes.length === 0 ? (
          <p className="px-2 py-8 text-center text-[13px] text-ink-3">No file edits in this conversation yet.</p>
        ) : (
          changes.map((f) => {
            const expanded = open === f.path;
            return (
              <div key={f.path} className="mb-1">
                <button
                  type="button"
                  onClick={() => setOpen(expanded ? null : f.path)}
                  aria-expanded={expanded}
                  title={f.path}
                  className={`flex w-full min-w-0 items-center gap-2 rounded-control px-2 py-2 text-left font-mono text-[12.5px] transition-colors duration-100 hover:bg-hover ${expanded ? "bg-hover" : ""}`}
                >
                  <NavArrowDown width={12} height={12} strokeWidth={2.4} className={`shrink-0 text-ink-3 transition-transform duration-200 ${expanded ? "" : "-rotate-90"}`} />
                  <PathLabel path={rel(f.path)} className="min-w-0 flex-1" />
                  <span className="shrink-0 text-[11.5px] text-ink-3">{f.edits.length > 1 ? `${f.edits.length} edits` : f.edits[0]?.kind === "write" ? "written" : "1 edit"}</span>
                  <span className="shrink-0 tabular-nums">
                    <span className="text-green">+{f.added}</span> <span className="text-red">-{f.removed}</span>
                  </span>
                </button>
                {expanded && (
                  <div className="flex flex-col gap-2 px-1 pt-1 pb-3">
                    {f.path.startsWith("/") && (
                      <button
                        type="button"
                        onClick={() => window.dispatchEvent(new CustomEvent(OPEN_FILES_EVENT, { detail: { path: f.path } }))}
                        className="self-start rounded-full px-2.5 py-1 text-[12px] font-medium text-ink-2 shadow-btn hover:bg-hover"
                      >
                        Open the file as it is now
                      </button>
                    )}
                    {f.edits.map((ed, i) => (
                      <div key={i} className={ed.failed ? "opacity-50" : ""}>
                        {ed.failed && <p className="mb-1 text-[11.5px] text-red-ink">This edit failed and wasn&apos;t applied.</p>}
                        <DiffBlock before={ed.before} after={ed.after} plain={isPlainText(f.path)} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
