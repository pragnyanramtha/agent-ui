import type { Entry, ToolResult } from "@/lib/types";
import { lineDiff } from "./diff";
import { parsePatch } from "./tools";

/* The file edits carried by tool calls, in the shapes every adapter maps its own tools to: Claude's Edit, MultiEdit,
 * Write and NotebookEdit (also what OpenCode, Cursor, Gemini, Devin, Kimi and Antigravity emit), and the
 * "*** Begin Patch" envelopes of Codex (ApplyPatch) and OpenCode (apply_patch, for patches over several files). */

type ToolEntry = Extract<Entry, { kind: "tool" }>;

export type FileEdit = {
  path: string;
  before: string;
  after: string;
  kind: "edit" | "write" | "delete";
  /** false when the strings don't tell the whole change (replace_all hits every match; a deleted file's text isn't in the patch) */
  exact: boolean;
};

const str = (v: unknown) => (typeof v === "string" ? v : "");
const PATCH_TOOLS = new Set(["ApplyPatch", "apply_patch"]);
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/** Whether a tool call writes files (what the Changes panel and the turn's changed files count). */
export function writesFiles(e: Entry): e is ToolEntry {
  if (e.kind !== "tool") return false;
  if (PATCH_TOOLS.has(e.name)) return /^\*\*\* (Update|Add|Delete) File:/m.test(str(e.input?.patch));
  return EDIT_TOOLS.has(e.name) && Boolean(str(e.input?.file_path) || str(e.input?.notebook_path));
}

/** One hunk of a patch as the text it replaced and the text it left. */
function hunks(lines: ReturnType<typeof parsePatch>[number]["lines"]) {
  const out: { before: string; after: string }[] = [];
  let cur: { b: string[]; a: string[] } | null = null;
  const flush = () => {
    if (cur && (cur.b.length || cur.a.length)) out.push({ before: cur.b.join("\n"), after: cur.a.join("\n") });
    cur = null;
  };
  for (const l of lines) {
    if (l.tone === "hunk") {
      flush();
      continue;
    }
    cur ??= { b: [], a: [] };
    if (l.tone !== "add") cur.b.push(l.text);
    if (l.tone !== "del") cur.a.push(l.text);
  }
  flush();
  return out;
}

/** The edits one tool call made, file by file; [] for anything that doesn't write files. */
export function toolEdits(e: Entry): FileEdit[] {
  if (!writesFiles(e)) return [];
  const input = e.input ?? {};
  if (PATCH_TOOLS.has(e.name)) {
    return parsePatch(str(input.patch)).flatMap((f): FileEdit[] => {
      const path = f.moveTo ?? f.path;
      if (f.op === "delete") return [{ path, before: "", after: "", kind: "delete", exact: false }];
      if (f.op === "add") return [{ path, before: "", after: f.lines.filter((l) => l.tone !== "hunk").map((l) => l.text).join("\n"), kind: "write", exact: true }];
      const parts = hunks(f.lines);
      /* a rename with no hunks still touched the file */
      return parts.length ? parts.map((h) => ({ path, ...h, kind: "edit" as const, exact: true })) : [{ path, before: "", after: "", kind: "edit", exact: true }];
    });
  }
  const path = str(input.file_path) || str(input.notebook_path);
  switch (e.name) {
    case "Edit":
      return [{ path, before: str(input.old_string), after: str(input.new_string), kind: "edit", exact: input.replace_all !== true }];
    case "MultiEdit": {
      const list = Array.isArray(input.edits) ? (input.edits as ({ old_string?: unknown; new_string?: unknown; replace_all?: unknown } | null)[]) : [];
      return list.map((x) => ({ path, before: str(x?.old_string), after: str(x?.new_string), kind: "edit" as const, exact: x?.replace_all !== true }));
    }
    case "Write":
      return [{ path, before: "", after: str(input.content), kind: "write", exact: true }];
    case "NotebookEdit":
      return [{ path, before: "", after: str(input.new_source), kind: "edit", exact: true }];
  }
  return [];
}

/** Lines added and removed by one edit. */
export function editCounts(ed: FileEdit): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lineDiff(ed.before, ed.after)) {
    if (l.tone === "add") added++;
    else if (l.tone === "del") removed++;
  }
  return { added, removed };
}

/** A file a turn changed; null counts when the tool calls can't tell them. */
export type TurnFile = { path: string; added: number | null; removed: number | null };

/** The files a turn's tool calls changed, in the order first touched. Failed calls changed nothing. */
export function turnFiles(tools: readonly Entry[], results: Record<string, ToolResult>): TurnFile[] {
  const files = new Map<string, TurnFile>();
  for (const e of tools) {
    if (e.kind !== "tool" || results[e.toolUseId]?.isError) continue;
    for (const ed of toolEdits(e)) {
      if (!ed.path) continue;
      const f = files.get(ed.path) ?? { path: ed.path, added: 0, removed: 0 };
      files.set(ed.path, f);
      if (!ed.exact) {
        if (ed.kind === "delete") f.removed = null;
        else f.added = f.removed = null;
        continue;
      }
      const c = editCounts(ed);
      if (f.added !== null) f.added += c.added;
      if (f.removed !== null) f.removed += c.removed;
    }
  }
  return [...files.values()];
}

/** "3 files changed", and the known lines added and removed across them (null when no file's count is known). */
export function filesSummary(files: readonly TurnFile[]): { label: string; added: number | null; removed: number | null } {
  const label = `${files.length} ${files.length === 1 ? "file" : "files"} changed`;
  const known = files.filter((f) => f.added !== null || f.removed !== null);
  if (!known.length) return { label, added: null, removed: null };
  return { label, added: known.reduce((n, f) => n + (f.added ?? 0), 0), removed: known.reduce((n, f) => n + (f.removed ?? 0), 0) };
}
