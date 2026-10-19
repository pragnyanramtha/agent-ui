import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Entry } from "@/lib/types";
import { fileUriToPath } from "./cursor-store";
import { clipResult } from "./cursor-tools";

/* Read-only view of the Antigravity CLI's (agy 1.4) conversations, under ~/.gemini/antigravity-cli:
 *   conversation_summaries.db   SQLite: conversation_summaries(conversation_id PK, title, preview, step_count,
 *                               last_modified_time, workspace_uris JSON array of file:// URIs, status,
 *                               nesting_depth, app_data_dir, ...). Shared with other Antigravity apps:
 *                               only top-level rows of the CLI's own data dir are ours.
 *   brain/<id>/.system_generated/logs/transcript_full.jsonl   one step per line
 *       {step_index, source, type, status, created_at, content, thinking?, tool_calls?: [{name, args}]}
 * The transcript format isn't documented and is read tolerantly: unknown steps are skipped, and a
 * conversation without one still lists from its summary row. */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

export const agyDir = (home = os.homedir()) => path.join(home, ".gemini", "antigravity-cli");
export const agyDbPath = (dir = agyDir()) => path.join(dir, "conversation_summaries.db");
export const agyTranscriptPaths = (id: string, dir = agyDir()) =>
  ["transcript_full.jsonl", "transcript.jsonl"].map((f) => path.join(dir, "brain", id, ".system_generated", "logs", f));

/* ── summaries ─────────────────────────────────────────────── */

export type AgyRow = { id: string; title: string; preview: string; steps: number; mtime: number; cwd: string; status: string };

/** seconds, ms, µs or ns since the epoch, an ISO string, or {seconds, nanos} -> ms (0 when unknown) */
export function toMs(v: unknown): number {
  if (isObj(v) && v.seconds !== undefined) return Number(v.seconds) * 1000 + Math.floor(Number(v.nanos ?? 0) / 1e6);
  if (typeof v === "bigint") v = Number(v);
  if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim())) v = Number(v);
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    if (v < 1e11) return Math.round(v * 1000);
    if (v < 1e14) return Math.round(v);
    if (v < 1e17) return Math.round(v / 1000);
    return Math.round(v / 1e6);
  }
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? 0 : t;
  }
  return 0;
}

function firstWorkspace(v: unknown): string {
  let list: unknown = v;
  if (typeof v === "string") {
    try {
      list = JSON.parse(v);
    } catch {
      list = [v];
    }
  }
  for (const x of Array.isArray(list) ? list : [list]) {
    const uri = typeof x === "string" ? x : isObj(x) ? (x.uri ?? x.path ?? x.workspace_uri) : null;
    if (typeof uri === "string" && uri) return fileUriToPath(uri);
  }
  return "";
}

const text = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : Buffer.isBuffer(v) || v instanceof Uint8Array ? Buffer.from(v).toString("utf8") : String(v));

/** One summaries row as a session, or null when it isn't a top-level CLI conversation. */
export function agyRow(r: Obj): AgyRow | null {
  const id = text(r.conversation_id).trim();
  if (!id) return null;
  if (Number(r.nesting_depth ?? 0) > 0) return null;
  const app = text(r.app_data_dir).trim();
  if (app && app !== "antigravity-cli" && path.basename(app) !== "antigravity-cli") return null;
  return {
    id,
    title: text(r.title).trim(),
    preview: text(r.preview).trim(),
    steps: Number(r.step_count ?? 0) || 0,
    mtime: toMs(r.last_modified_time),
    cwd: firstWorkspace(r.workspace_uris),
    status: text(r.status),
  };
}

type Sqlite = typeof import("node:sqlite");

function sqlite(): Sqlite | null {
  try {
    return (process.getBuiltinModule?.("node:sqlite") as Sqlite | undefined) ?? null;
  } catch {
    return null;
  }
}

function dbSig(file: string): string | null {
  let sig = "";
  for (const f of [file, `${file}-wal`]) {
    try {
      const st = fs.statSync(f);
      sig += `${st.mtimeMs}:${st.size};`;
    } catch {
      if (f === file) return null;
    }
  }
  return sig;
}

const rowsCache = new Map<string, { sig: string; rows: AgyRow[] }>();
/* when a read last failed: list and get run often and sync, so a locked db isn't retried (and waited on) each time */
const failedAt = new Map<string, number>();
const RETRY_MS = 5000;

/** Every top-level CLI conversation, newest first; empty when the db is missing or unreadable. */
export function readSummaries(file = agyDbPath()): AgyRow[] {
  const sig = dbSig(file);
  if (!sig) return [];
  const hit = rowsCache.get(file);
  if (hit && hit.sig === sig) return hit.rows;
  if (Date.now() - (failedAt.get(file) ?? 0) < RETRY_MS) return hit?.rows ?? [];
  const mod = sqlite();
  if (!mod) return [];
  let db: DatabaseSync | null = null;
  let rows: AgyRow[] = [];
  try {
    db = new mod.DatabaseSync(file, { readOnly: true, timeout: 100 } as ConstructorParameters<Sqlite["DatabaseSync"]>[1]);
    rows = (db.prepare("SELECT * FROM conversation_summaries").all() as Obj[])
      .map(agyRow)
      .filter((r): r is AgyRow => r !== null)
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    /* locked, or another schema: keep what we had */
    failedAt.set(file, Date.now());
    return hit?.rows ?? [];
  } finally {
    try {
      db?.close();
    } catch {
      /* closed */
    }
  }
  failedAt.delete(file);
  rowsCache.set(file, { sig, rows });
  return rows;
}

/* ── tools ─────────────────────────────────────────────────── */

const norm = (k: string) => k.toLowerCase().replace(/[_-]/g, "");
/** the first of `keys` present in `o`, matching case- and underscore-insensitively */
function pick(o: Obj, ...keys: string[]): unknown {
  const byNorm = new Map(Object.keys(o).map((k) => [norm(k), k]));
  for (const want of keys) {
    const k = byNorm.get(norm(want));
    if (k !== undefined && o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k];
  }
  return undefined;
}
const s = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);
const compact = (o: Obj) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** Args may arrive as a JSON string, and their values JSON-encoded too. */
export function decodeArgs(raw: unknown): Obj {
  let a: unknown = raw;
  if (typeof a === "string") {
    try {
      a = JSON.parse(a);
    } catch {
      return { value: raw };
    }
  }
  if (!isObj(a)) return {};
  const out: Obj = {};
  for (const [k, v] of Object.entries(a)) {
    if (typeof v === "string" && /^\s*["{[]/.test(v)) {
      try {
        out[k] = JSON.parse(v);
        continue;
      } catch {
        /* a plain string that happens to start like JSON */
      }
    }
    out[k] = v;
  }
  return out;
}

export function mapAgyTool(rawName: string, rawArgs: unknown): { name: string; input: Obj } {
  const a = decodeArgs(rawArgs);
  const file = s(pick(a, "TargetFile", "AbsolutePath", "FilePath", "File", "Path"));
  switch (rawName) {
    case "run_command":
      return { name: "Bash", input: compact({ command: s(pick(a, "CommandLine", "Command", "cmd")) ?? "", cwd: s(pick(a, "Cwd", "WorkingDirectory")) }) };
    case "write_to_file":
      return { name: "Write", input: { file_path: file ?? "", content: s(pick(a, "CodeContent", "Content")) ?? "" } };
    case "replace_file_content":
      return { name: "Edit", input: { file_path: file ?? "", old_string: s(pick(a, "TargetContent", "OldString")) ?? "", new_string: s(pick(a, "ReplacementContent", "NewString")) ?? "" } };
    case "multi_replace_file_content": {
      const chunks = pick(a, "ReplacementChunks", "Chunks");
      const edits = (Array.isArray(chunks) ? chunks : []).filter(isObj).map((c) => ({ old_string: s(pick(c, "TargetContent")) ?? "", new_string: s(pick(c, "ReplacementContent")) ?? "" }));
      return { name: "MultiEdit", input: { file_path: file ?? "", edits } };
    }
    case "view_file": {
      const startLine = Number(pick(a, "StartLine"));
      const endLine = Number(pick(a, "EndLine"));
      return {
        name: "Read",
        input: compact({ file_path: file ?? "", offset: startLine > 0 ? startLine : undefined, limit: startLine > 0 && endLine >= startLine ? endLine - startLine + 1 : undefined }),
      };
    }
    case "list_dir":
      return { name: "LS", input: { path: s(pick(a, "DirectoryPath", "Path", "Directory")) ?? "" } };
    case "grep_search": {
      const inc = pick(a, "Includes", "Include");
      return { name: "Grep", input: compact({ pattern: s(pick(a, "Query", "Pattern")) ?? "", path: s(pick(a, "SearchPath", "SearchDirectory", "Path")), glob: Array.isArray(inc) ? inc.join(",") : s(inc) }) };
    }
    case "search_web":
      return { name: "WebSearch", input: { query: s(pick(a, "query", "Query")) ?? "" } };
    case "read_url_content":
      return { name: "WebFetch", input: { url: s(pick(a, "Url", "URL")) ?? "" } };
    default:
      return { name: rawName || "tool", input: a };
  }
}

/* ── transcript ────────────────────────────────────────────── */

const stepType = (v: unknown) => String(v ?? "").toUpperCase().replace(/^CORTEX_STEP_TYPE_/, "");
/* steps that answer a tool call; others (checkpoints, memories, ones we don't know) never take a result's place */
const TOOL_STEPS = new Set([
  "RUN_COMMAND",
  "COMMAND_STATUS",
  "SEND_COMMAND_INPUT",
  "VIEW_FILE",
  "VIEW_FILE_OUTLINE",
  "VIEW_CODE_ITEM",
  "VIEW_CONTENT_CHUNK",
  "CODE_ACTION",
  "WRITE_TO_FILE",
  "LIST_DIRECTORY",
  "LIST_DIR",
  "GREP_SEARCH",
  "FIND",
  "FIND_BY_NAME",
  "CODEBASE_SEARCH",
  "SEARCH_WEB",
  "READ_URL_CONTENT",
  "MCP_TOOL",
  "READ_RESOURCE",
  "LIST_RESOURCES",
  "GENERATE_IMAGE",
  "ERROR_MESSAGE",
]);
const isToolStep = (type: string, call: string) => TOOL_STEPS.has(type) || type.startsWith("BROWSER_") || type === call.toUpperCase();

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined || v === null) return "";
  try {
    return JSON.stringify(v, null, 2) ?? "";
  } catch {
    return String(v);
  }
}

/** The request inside a USER_INPUT step, without the metadata the CLI wraps around it. */
export function userRequest(content: unknown): string {
  const raw = isObj(content) ? s(pick(content, "text", "content", "user_request")) ?? stringify(content) : stringify(content);
  const m = /<USER_REQUEST>([\s\S]*?)(?:<\/USER_REQUEST>|$)/.exec(raw);
  const body = m ? m[1] : raw;
  return body.replace(/<ADDITIONAL_METADATA>[\s\S]*?(?:<\/ADDITIONAL_METADATA>|$)/g, "").trim();
}

function resultText(content: unknown): string {
  if (isObj(content)) {
    const v = pick(content, "output", "combined_output", "stdout", "text", "content", "error", "message");
    if (v !== undefined) return stringify(v);
  }
  return stringify(content);
}

/** A transcript_full.jsonl as UI entries. Malformed lines and unknown steps are skipped, never thrown on. */
export function agyTranscriptEntries(raw: string): Entry[] {
  const out: Entry[] = [];
  /* calls of the latest planner step still waiting for their result, in order */
  const pending: { id: string; name: string }[] = [];
  let lastTs = new Date(0).toISOString();
  let n = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let st: Obj;
    try {
      const j = JSON.parse(line);
      if (!isObj(j)) continue;
      st = j;
    } catch {
      continue;
    }
    const idx = st.step_index ?? st.stepIndex ?? `n${n}`;
    n++;
    const base = `s${String(idx)}`;
    const ms = toMs(st.created_at ?? st.createdAt ?? st.timestamp);
    const ts = ms ? new Date(ms).toISOString() : lastTs;
    lastTs = ts;
    const type = stepType(st.type);
    const status = String(st.status ?? "").toUpperCase();
    try {
      if (type === "USER_INPUT") {
        pending.length = 0;
        const t = userRequest(st.content);
        if (t) out.push({ kind: "user", id: `${base}:u`, ts, text: t, images: 0 });
        continue;
      }
      if (type === "PLANNER_RESPONSE") {
        pending.length = 0;
        const thinking = stringify(st.thinking).trim();
        if (thinking) out.push({ kind: "thinking", id: `${base}:t`, ts, msgId: base, text: thinking });
        const body = (isObj(st.content) ? resultText(st.content) : stringify(st.content)).trim();
        if (body) out.push({ kind: "text", id: `${base}:x`, ts, msgId: base, text: body });
        const calls = Array.isArray(st.tool_calls) ? st.tool_calls : Array.isArray(st.toolCalls) ? st.toolCalls : [];
        calls.forEach((c, i) => {
          if (!isObj(c)) return;
          const callId = `${base}:c${i}`;
          const raw = String(c.name ?? "tool");
          const { name, input } = mapAgyTool(raw, c.args ?? c.arguments ?? c.argumentsJson);
          out.push({ kind: "tool", id: callId, ts, msgId: base, toolUseId: callId, name, input });
          pending.push({ id: callId, name: raw });
        });
        continue;
      }
      if (type === "ERROR_MESSAGE" && !pending.length) {
        const t = resultText(st.content).trim();
        if (t) out.push({ kind: "notice", id: `${base}:x`, ts, tone: "warn", text: t.slice(0, 2000) });
        continue;
      }
      if (!pending.length || !isToolStep(type, pending[0].name)) continue;
      const callId = pending.shift()!.id;
      const isError = type === "ERROR_MESSAGE" || /ERROR|FAIL|CANCEL|DENIED|REJECT/.test(status);
      out.push({ kind: "result", id: `${callId}:r`, ts, toolUseId: callId, result: clipResult(resultText(st.content), isError) });
    } catch {
      /* a step shaped some other way */
    }
  }
  return out;
}

/** The conversation's transcript as entries, or null when there's no readable file. */
export function readTranscript(id: string, dir = agyDir()): { entries: Entry[]; file: string } | null {
  for (const file of agyTranscriptPaths(id, dir)) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    return { entries: agyTranscriptEntries(raw), file };
  }
  return null;
}

/** What a conversation without a readable transcript still shows. */
export function summaryEntries(row: AgyRow): Entry[] {
  const ts = new Date(row.mtime || Date.now()).toISOString();
  const what = [row.title, row.preview].filter(Boolean).join(": ");
  return [{ kind: "notice", id: `${row.id}:summary`, ts, tone: "info", text: what ? `Transcript not available. ${what}` : "Transcript not available for this session." }];
}
