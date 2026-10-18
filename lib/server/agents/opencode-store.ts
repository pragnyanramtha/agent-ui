import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { Entry } from "@/lib/types";

/* Read-only access to OpenCode's SQLite store (~/.local/share/opencode/opencode.db,
 * OpenCode >= 1.x). Tables used: session (one row per thread, parent_id set for
 * subagent sessions), message (data = JSON MessageV1 Info: role user|assistant),
 * part (data = JSON Part: text, reasoning, tool, step-start, step-finish, file,
 * patch, retry, compaction, ...). Parts are ordered by id (ids are time-sortable),
 * messages by (time_created, id). Parts are upserted in place while they stream,
 * so `time_updated` is what live polling keys on. */

type Row = Record<string, unknown>;
type Json = Record<string, unknown>;

export type SessionRow = { id: string; title: string; directory: string; time_created: number; time_updated: number; model: string | null };

const CLIP = 8000;
/** parts that stopped changing this long ago are treated as final even without an end time (crashed runs) */
const STALE_MS = 120_000;
const PAGE = 60;

export function dbPath(): string {
  const env = process.env.OPENCODE_DB;
  const data = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "opencode");
  if (env && env !== ":memory:") return path.isAbsolute(env) ? env : path.join(data, env);
  return path.join(data, "opencode.db");
}

const cache = (() => {
  const g = globalThis as typeof globalThis & { __opencodeDb?: { file: string; ino: number; db: DatabaseSync } | null };
  return g;
})();

/** Shared read-only connection; null when OpenCode has never run here. Reopens if the file is replaced. */
export function db(): DatabaseSync | null {
  const file = dbPath();
  let ino: number;
  try {
    ino = fs.statSync(file).ino;
  } catch {
    return null;
  }
  const hit = cache.__opencodeDb;
  if (hit && hit.file === file && hit.ino === ino) return hit.db;
  try {
    hit?.db.close();
  } catch {}
  const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
  const conn = new sqlite.DatabaseSync(file, { readOnly: true });
  conn.exec("PRAGMA busy_timeout = 3000");
  cache.__opencodeDb = { file, ino, db: conn };
  return conn;
}

function query<T = Row>(sql: string, ...params: (string | number | null)[]): T[] {
  const conn = db();
  if (!conn) return [];
  try {
    return conn.prepare(sql).all(...params) as T[];
  } catch (err) {
    // a dropped/replaced file or a schema we don't know: drop the connection and retry once
    if (/no such table/.test(String(err))) return [];
    cache.__opencodeDb = null;
    const again = db();
    return again ? (again.prepare(sql).all(...params) as T[]) : [];
  }
}

const parse = (s: unknown): Json => {
  if (typeof s !== "string") return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Json) : {};
  } catch {
    return {};
  }
};

function modelOf(raw: unknown): string | null {
  const m = parse(raw);
  const id = str(m.id) || str(m.modelID);
  return id ? (str(m.providerID) ? `${str(m.providerID)}/${id}` : id) : null;
}

const SESSION_COLS = "id, title, directory, time_created, time_updated, model";
const toSession = (r: Row): SessionRow => ({
  id: String(r.id),
  title: String(r.title ?? ""),
  directory: String(r.directory ?? ""),
  time_created: Number(r.time_created),
  time_updated: Number(r.time_updated),
  model: modelOf(r.model),
});

/** Top-level, unarchived sessions, newest first (subagent sessions have parent_id). */
export function listSessions(limit = 500): SessionRow[] {
  return query(`SELECT ${SESSION_COLS} FROM session WHERE parent_id IS NULL AND time_archived IS NULL ORDER BY time_updated DESC LIMIT ?`, limit).map(toSession);
}

export function getSession(id: string): SessionRow | null {
  const r = query(`SELECT ${SESSION_COLS} FROM session WHERE id = ?`, id)[0];
  return r ? toSession(r) : null;
}

/** Top-level sessions created at/after `since` (ms), with the text of their first user message. */
export function sessionsSince(since: number): (SessionRow & { firstText: string })[] {
  return query(`SELECT ${SESSION_COLS} FROM session WHERE parent_id IS NULL AND time_created >= ? ORDER BY time_created DESC LIMIT 20`, since).map((r) => {
    const s = toSession(r);
    const p = query<{ data: string }>(
      `SELECT p.data FROM part p JOIN message m ON m.id = p.message_id WHERE m.session_id = ? AND json_extract(m.data, '$.role') = 'user' ORDER BY m.time_created, m.id, p.id LIMIT 5`,
      s.id,
    );
    const firstText = p.map((x) => parse(x.data)).find((d) => d.type === "text" && !d.synthetic);
    return { ...s, firstText: str(firstText?.text) };
  });
}

/* ── history ─────────────────────────────────────────────── */

type Msg = { id: string; created: number; updated: number; info: Json };
type Part = { id: string; messageId: string; created: number; updated: number; data: Json };

const toMsg = (r: Row): Msg => ({ id: String(r.id), created: Number(r.time_created), updated: Number(r.time_updated), info: parse(r.data) });
const toPart = (r: Row): Part => ({ id: String(r.id), messageId: String(r.message_id), created: Number(r.time_created), updated: Number(r.time_updated), data: parse(r.data) });

function partsOf(ids: string[]): Map<string, Part[]> {
  const out = new Map<string, Part[]>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const rows = query(`SELECT id, message_id, time_created, time_updated, data FROM part WHERE message_id IN (${chunk.map(() => "?").join(",")}) ORDER BY id`, ...chunk);
    for (const r of rows) {
      const p = toPart(r);
      const list = out.get(p.messageId) ?? [];
      list.push(p);
      out.set(p.messageId, list);
    }
  }
  return out;
}

/** Latest activity stamp of a session, used as the live-watch watermark. */
export function sessionEnd(id: string): number {
  const r = query<{ t: number | null }>(
    `SELECT MAX(t) AS t FROM (SELECT MAX(time_updated) AS t FROM part WHERE session_id = ? UNION ALL SELECT MAX(time_updated) FROM message WHERE session_id = ?)`,
    id,
    id,
  )[0];
  return Number(r?.t ?? 0) || 0;
}

/** cursor = "<time_created>:<message id>" of the oldest message on the page */
export function historyPage(id: string, before: string | null | undefined): { entries: Entry[]; cursor: string | null } {
  let bound = parseCursor(before);
  const pages: Entry[][] = [];
  let count = 0;
  let more = false;
  let oldest: Msg | null = null;
  while (count < PAGE) {
    const rows = bound
      ? query(
          `SELECT id, time_created, time_updated, data FROM message WHERE session_id = ? AND (time_created < ? OR (time_created = ? AND id < ?)) ORDER BY time_created DESC, id DESC LIMIT 41`,
          id,
          bound.t,
          bound.t,
          bound.id,
        )
      : query(`SELECT id, time_created, time_updated, data FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT 41`, id);
    more = rows.length > 40;
    const msgs = rows.slice(0, 40).map(toMsg);
    if (!msgs.length) break;
    const parts = partsOf(msgs.map((m) => m.id));
    const now = Date.now();
    for (const m of msgs) {
      const e = messageEntries(m, parts.get(m.id) ?? [], now);
      pages.unshift(e);
      count += e.length;
      oldest = m;
      if (count >= PAGE) {
        more = more || m !== msgs[msgs.length - 1];
        break;
      }
    }
    if (!more) break;
    bound = { t: oldest!.created, id: oldest!.id };
  }
  return { entries: pages.flat(), cursor: more && oldest ? `${oldest.created}:${oldest.id}` : null };
}

function parseCursor(c: string | null | undefined): { t: number; id: string } | null {
  if (!c) return null;
  const i = c.indexOf(":");
  const t = Number(c.slice(0, i));
  return i > 0 && Number.isFinite(t) ? { t, id: c.slice(i + 1) } : null;
}

/* ── live polling ────────────────────────────────────────── */

/** Entries of every message touched at/after `since` (ms), plus the newest stamp seen. */
export function changedSince(id: string, since: number): { entries: Entry[]; end: number } {
  const msgRows = query(
    `SELECT id, time_created, time_updated, data FROM message WHERE session_id = ? AND (time_updated >= ? OR id IN (SELECT message_id FROM part WHERE session_id = ? AND time_updated >= ?)) ORDER BY time_created, id`,
    id,
    since,
    id,
    since,
  );
  const msgs = msgRows.map(toMsg);
  if (!msgs.length) return { entries: [], end: since };
  const parts = partsOf(msgs.map((m) => m.id));
  const now = Date.now();
  let end = since;
  const entries: Entry[] = [];
  for (const m of msgs) {
    end = Math.max(end, m.updated);
    const ps = parts.get(m.id) ?? [];
    for (const p of ps) end = Math.max(end, p.updated);
    entries.push(...messageEntries(m, ps, now));
  }
  return { entries, end };
}

/* ── mapping ─────────────────────────────────────────────── */

const str = (v: unknown) => (typeof v === "string" ? v : "");
const iso = (ms: unknown) => new Date(typeof ms === "number" && Number.isFinite(ms) ? ms : Date.now()).toISOString();
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});

/**
 * Entries for one message. Text/reasoning only once finished (the UI keeps the first
 * copy of an id), tools once their input is known, results once they complete.
 */
export function messageEntries(m: Msg, parts: Part[], now: number): Entry[] {
  const info = m.info;
  const out: Entry[] = [];
  if (info.role === "user") {
    const texts = parts.filter((p) => p.data.type === "text" && !p.data.synthetic && !p.data.ignored).map((p) => str(p.data.text));
    const images = parts.filter((p) => p.data.type === "file" && str(p.data.mime).startsWith("image/")).length;
    const text = texts.join("\n\n").trim();
    if (text || images) out.push({ kind: "user", id: m.id, ts: iso(obj(info.time).created ?? m.created), text, images });
    for (const p of parts) {
      if (p.data.type === "subtask") {
        out.push({
          kind: "tool",
          id: p.id,
          ts: iso(p.created),
          msgId: m.id,
          toolUseId: p.id,
          name: "Task",
          input: { description: str(p.data.description), prompt: str(p.data.prompt), subagent_type: str(p.data.agent) },
        });
      }
      if (p.data.type === "compaction") out.push({ kind: "notice", id: p.id, ts: iso(p.created), tone: "info", text: "Conversation compacted" });
    }
    return out;
  }

  const time = obj(info.time);
  const msgDone = typeof time.completed === "number" || Boolean(info.error);
  const model = [str(info.providerID), str(info.modelID)].filter(Boolean).join("/");
  for (const p of parts) {
    const d = p.data;
    const pt = obj(d.time);
    const final = msgDone || typeof pt.end === "number" || now - p.updated > STALE_MS;
    switch (d.type) {
      case "text": {
        const text = str(d.text);
        if (final && text.trim() && !d.ignored) out.push({ kind: "text", id: p.id, ts: iso(pt.start ?? p.created), msgId: m.id, text });
        break;
      }
      case "reasoning":
        if (final) out.push({ kind: "thinking", id: p.id, ts: iso(pt.start ?? p.created), msgId: m.id, text: str(d.text) });
        break;
      case "tool":
        out.push(...toolEntries(m.id, p, msgDone || now - p.updated > STALE_MS));
        break;
      case "step-finish": {
        const t = obj(d.tokens);
        const cache = obj(t.cache);
        out.push({
          kind: "usage",
          id: p.id,
          ts: iso(p.created),
          model,
          input: Number(t.input) || 0,
          cacheRead: Number(cache.read) || 0,
          cacheWrite: Number(cache.write) || 0,
          output: (Number(t.output) || 0) + (Number(t.reasoning) || 0),
        });
        break;
      }
      case "retry": {
        const e = obj(d.error);
        const msg = str(obj(e.data).message) || str(e.name) || "request failed";
        out.push({ kind: "notice", id: p.id, ts: iso(obj(d.time).created ?? p.created), tone: "warn", text: `Retrying (attempt ${Number(d.attempt) || 1}): ${msg}` });
        break;
      }
      case "compaction":
        out.push({ kind: "notice", id: p.id, ts: iso(p.created), tone: "info", text: "Conversation compacted" });
        break;
    }
  }
  const err = obj(info.error);
  if (info.error) {
    const name = str(err.name);
    const msg = str(obj(err.data).message);
    out.push(
      name === "MessageAbortedError"
        ? { kind: "notice", id: `${m.id}:error`, ts: iso(time.completed ?? m.updated), tone: "info", text: "Stopped" }
        : { kind: "notice", id: `${m.id}:error`, ts: iso(time.completed ?? m.updated), tone: "warn", text: authHint(name, msg || name || "The model request failed") },
    );
  }
  return out;
}

function authHint(name: string, msg: string): string {
  if (name === "ProviderAuthError" || /api key|unauthori[sz]ed|401|credentials/i.test(msg)) return `${msg}. Run opencode auth login on the server.`;
  return msg;
}

function toolEntries(msgId: string, p: Part, stale: boolean): Entry[] {
  const d = p.data;
  const state = obj(d.state);
  const status = str(state.status);
  if (status === "pending" && !stale) return [];
  const st = obj(state.time);
  const tool = str(d.tool);
  const { name, input } = toolCall(tool, obj(state.input));
  const out: Entry[] = [{ kind: "tool", id: p.id, ts: iso(st.start ?? p.created), msgId, toolUseId: p.id, name, input }];
  if (status === "completed" || status === "error") {
    const isError = status === "error";
    const raw = isError ? str(state.error) : tool === "read" ? readOutput(str(state.output)) : str(state.output);
    out.push({
      kind: "result",
      id: `${p.id}:result`,
      ts: iso(st.end ?? p.updated),
      toolUseId: p.id,
      result: { text: raw.length > CLIP ? raw.slice(0, CLIP) : raw, isError, truncated: raw.length > CLIP },
    });
  }
  return out;
}

/** OpenCode tool names/inputs -> the Claude Code shapes the UI renders. */
export function toolCall(tool: string, i: Json): { name: string; input: Record<string, unknown> } {
  const pick = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  switch (tool) {
    case "bash":
      return { name: "Bash", input: pick({ command: str(i.command), description: i.description, workdir: i.workdir, timeout: i.timeout }) };
    case "read":
      return { name: "Read", input: pick({ file_path: str(i.filePath), offset: i.offset, limit: i.limit }) };
    case "edit":
      return { name: "Edit", input: pick({ file_path: str(i.filePath), old_string: str(i.oldString), new_string: str(i.newString), replace_all: i.replaceAll }) };
    case "write":
      return { name: "Write", input: { file_path: str(i.filePath), content: str(i.content) } };
    case "grep":
      return { name: "Grep", input: pick({ pattern: str(i.pattern), path: i.path, glob: i.include }) };
    case "glob":
      return { name: "Glob", input: pick({ pattern: str(i.pattern), path: i.path }) };
    case "list":
      return { name: "LS", input: pick({ path: i.path }) };
    case "webfetch":
      return { name: "WebFetch", input: pick({ url: str(i.url), format: i.format }) };
    case "websearch":
    case "codesearch":
      return { name: "WebSearch", input: { query: str(i.query) } };
    case "todowrite":
      return {
        name: "TodoWrite",
        input: {
          todos: (Array.isArray(i.todos) ? i.todos : []).map((t) => {
            const o = obj(t);
            return { content: str(o.content), status: o.status === "cancelled" ? "completed" : str(o.status) || "pending", activeForm: str(o.content), priority: o.priority };
          }),
        },
      };
    case "todoread":
      return { name: "TodoRead", input: {} };
    case "task":
      return { name: "Task", input: pick({ description: str(i.description), prompt: str(i.prompt), subagent_type: i.subagent_type }) };
    case "skill":
      return { name: "Skill", input: { skill: str(i.name) } };
    case "question":
      return {
        name: "AskUserQuestion",
        input: {
          questions: (Array.isArray(i.questions) ? i.questions : []).map((q) => {
            const o = obj(q);
            return { question: str(o.question), header: str(o.header), multiSelect: Boolean(o.multiple), options: Array.isArray(o.options) ? o.options : [] };
          }),
        },
      };
    case "apply_patch":
      return patchCall(str(i.patchText));
    default:
      return { name: tool || "tool", input: i };
  }
}

/** apply_patch envelopes: one added file -> Write, one updated file -> MultiEdit, anything else stays a raw patch. */
function patchCall(text: string): { name: string; input: Record<string, unknown> } {
  const files: { op: string; path: string; lines: string[] }[] = [];
  for (const line of text.split("\n")) {
    const m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (m) files.push({ op: m[1], path: m[2].trim(), lines: [] });
    else if (files.length && !/^\*\*\* (End Patch|Move to:)/.test(line)) files[files.length - 1].lines.push(line);
  }
  if (files.length === 1 && files[0].op === "Add") {
    return { name: "Write", input: { file_path: files[0].path, content: files[0].lines.map((l) => l.replace(/^\+/, "")).join("\n") } };
  }
  if (files.length === 1 && files[0].op === "Update") {
    const edits: { old_string: string; new_string: string }[] = [];
    let cur: { o: string[]; n: string[] } | null = null;
    const flush = () => {
      if (cur && (cur.o.length || cur.n.length)) edits.push({ old_string: cur.o.join("\n"), new_string: cur.n.join("\n") });
      cur = null;
    };
    for (const l of files[0].lines) {
      if (l.startsWith("@@")) {
        flush();
        continue;
      }
      cur ??= { o: [], n: [] };
      if (l.startsWith("-")) cur.o.push(l.slice(1));
      else if (l.startsWith("+")) cur.n.push(l.slice(1));
      else if (l.startsWith(" ")) {
        cur.o.push(l.slice(1));
        cur.n.push(l.slice(1));
      }
    }
    flush();
    return { name: "MultiEdit", input: { file_path: files[0].path, edits } };
  }
  return { name: "apply_patch", input: { files: files.map((f) => `${f.op.toLowerCase()} ${f.path}`).join("\n"), patch: text } };
}

/** `<content>\n1: line\n...</content>` -> cat -n style lines the UI's file view understands. */
function readOutput(out: string): string {
  const m = /<content>\n?([\s\S]*?)\n?<\/content>/.exec(out);
  if (!m) return out;
  return m[1]
    .split("\n")
    .filter((l) => !/^\s*\((End of file|Showing lines|File has more lines)/.test(l))
    .map((l) => l.replace(/^(\d+): ?/, "$1\t"))
    .join("\n")
    .replace(/\s+$/, "");
}
