import type { Entry, PermissionMode, ToolResult } from "@/lib/types";
import { parseRecord, safeParse } from "./transcript";
import type { Source } from "./handoff-shape";

/* "Fork from here" and "Edit from here": which part of a conversation a new session keeps. Pure: no I/O.
 *  - fork: everything up to and including the turn the reply closes (up to the next prompt), so its tool calls
 *    keep their results
 *  - edit: everything before the prompt being edited */

export type BranchKind = "fork" | "edit";

export type BranchRequest = {
  entryId: string;
  text: string;
  /** edit only: the checkpoint to put the files back to first */
  checkpoint: string | null;
  mode: PermissionMode | null;
  model: string | null;
  profile: string | null;
};

const MODES: readonly PermissionMode[] = ["default", "acceptEdits", "bypassPermissions", "plan"];
export const TEXT_MAX = 500_000;
const ENTRY_ID = /^[\x21-\x7e]{1,256}$/;
const CHECKPOINT_ID = /^\d{10,16}-[0-9a-f]{4}$/;
const PROFILE_ID = /^[a-z0-9._-]{1,64}$/;
const MODEL = /^[^\s\x00-\x1f\x7f]{1,200}$/;

/** A fork or edit body read strictly: the right types, known values, sane sizes. A string is the error to show. */
export function parseBranchBody(kind: BranchKind, body: Record<string, unknown>): BranchRequest | string {
  const { entryId, text, checkpoint, permissionMode, model, profile } = body;
  if (typeof entryId !== "string" || !ENTRY_ID.test(entryId)) return "Choose a message.";
  if (text !== undefined && typeof text !== "string") return "The message must be text.";
  const clean = (text ?? "").trim();
  if (clean.length > TEXT_MAX) return "That message is too long.";
  if (kind === "edit" && !clean) return "Enter a message.";
  if (checkpoint !== undefined && checkpoint !== null) {
    if (kind !== "edit") return "Only Edit from here puts files back.";
    if (typeof checkpoint !== "string" || !CHECKPOINT_ID.test(checkpoint)) return "Unknown checkpoint.";
  }
  if (permissionMode !== undefined && permissionMode !== null && !MODES.includes(permissionMode as PermissionMode)) return "Unknown approval mode.";
  if (model !== undefined && model !== null && model !== "" && (typeof model !== "string" || !MODEL.test(model))) return "Unknown model.";
  if (profile !== undefined && profile !== null && profile !== "" && (typeof profile !== "string" || !PROFILE_ID.test(profile))) return "Unknown profile.";
  return {
    entryId,
    text: clean,
    checkpoint: typeof checkpoint === "string" ? checkpoint : null,
    mode: (permissionMode as PermissionMode | null | undefined) ?? null,
    model: typeof model === "string" && model ? model : null,
    profile: typeof profile === "string" && profile ? profile : null,
  };
}

/**
 * How many entries the new session keeps, or null when `entryId` isn't a message this kind can start from:
 * an edit starts from a prompt, a fork from anything the agent said.
 */
export function cutIndex(entries: readonly Entry[], entryId: string, kind: BranchKind): number | null {
  const at = entries.findIndex((e) => e.id === entryId);
  if (at < 0) return null;
  const e = entries[at];
  if (kind === "edit") return e.kind === "user" ? at : null;
  if (e.kind === "user") return null;
  const next = entries.findIndex((x, i) => i > at && x.kind === "user");
  return next < 0 ? entries.length : next;
}

/** A source with only the entries a fork or edit keeps; null when the message isn't there. */
export function truncateSource(src: Source, entryId: string, kind: BranchKind): Source | null {
  const n = cutIndex(src.entries, entryId, kind);
  if (n === null) return null;
  const entries = src.entries.slice(0, n);
  const results: Record<string, ToolResult> = {};
  for (const e of entries) if (e.kind === "result") results[e.toolUseId] = e.result;
  return { ...src, entries, results };
}

/** A Claude record's uuid, from an entry id ("<uuid>" for prompts, "<uuid>:<block>" for what the agent said). */
export const recordUuid = (entryId: string) => entryId.split(":")[0];

/**
 * Walks a Claude transcript line by line and says where the new session's copy ends. Call `take(line)` for each
 * line in order: true keeps it, false means stop (that line and everything after it are left out). `found` turns
 * true once the message was seen; `kept` counts the kept lines that show in the conversation; `stopTs` is the time
 * of the line it stopped at.
 */
export function claudeCutter(entryId: string, kind: BranchKind) {
  const uuid = recordUuid(entryId);
  const state = { found: false, kept: 0, stopTs: null as string | null };
  const take = (line: string): boolean => {
    const rec = line ? safeParse(line) : null;
    if (!rec) return true;
    const entries = parseRecord(rec);
    const prompt = entries.some((e) => e.kind === "user");
    if (kind === "edit" && rec.uuid === uuid && entries.some((e) => e.kind === "user" && e.id === entryId)) {
      state.found = true;
      state.stopTs = rec.timestamp ?? null;
      return false;
    }
    if (kind === "fork" && state.found && prompt) {
      state.stopTs = rec.timestamp ?? null;
      return false;
    }
    if (kind === "fork" && rec.uuid === uuid && entries.some((e) => e.id === entryId && e.kind !== "user")) state.found = true;
    if (entries.some((e) => e.kind === "user" || e.kind === "text" || e.kind === "tool")) state.kept++;
    return true;
  };
  return Object.assign(state, { take });
}

/** A record of the source transcript as a record of the new one: the same, under the new session id. */
export function rewriteRecord(line: string, sessionId: string): string | null {
  let rec: unknown;
  try {
    rec = JSON.parse(line);
  } catch {
    return null;
  }
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return null;
  const r = rec as Record<string, unknown>;
  if (typeof r.sessionId === "string") r.sessionId = sessionId;
  return JSON.stringify(r);
}

/** The title a fork or an edited copy gets: "Fix login (fork)". */
export function branchTitle(title: string, kind: BranchKind): string {
  const base = (title || "Session").replace(/\s+\((fork|edited)\)$/, "").slice(0, 180);
  return `${base} (${kind === "fork" ? "fork" : "edited"})`;
}
