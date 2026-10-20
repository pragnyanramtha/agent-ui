import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Entry } from "@/lib/types";

/* Read-only view of the Devin CLI's local session store.
 *
 * Devin keeps everything in one SQLite file, ~/.local/share/devin/cli/sessions.db (WAL):
 *  - sessions(id "adjective-noun", working_directory, model, agent_mode, created_at/last_activity_at in
 *    epoch seconds, title, main_chain_id, hidden)
 *  - message_nodes(row_id, session_id, node_id, parent_node_id, chat_message JSON, metadata JSON): a forest per
 *    session. The conversation is the parent chain ending at sessions.main_chain_id. Every resume, mode switch
 *    or compaction starts a new chain (fresh system prompt + copies of earlier messages with the same
 *    message_id), and a compaction summary node carries metadata.summarized_from = the last node it replaced.
 *    Subagents and the summarizer live in side chains that never join the main chain.
 *  Rows are append-only (row_id grows), so a session changes when its max(row_id) or main_chain_id does.
 *
 * We rebuild the logical history as: chain(summarized_from) ++ current chain, deduped by message_id. */

type Db = DatabaseSync;
type Json = Record<string, unknown>;

export const devinDataDir = () =>
  path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "devin");
export const devinCliDir = () => path.join(devinDataDir(), "cli");
export const devinDbPath = () => path.join(devinCliDir(), "sessions.db");
export const devinLocksDir = () => path.join(devinCliDir(), "session_locks");

const g = globalThis as typeof globalThis & { __devinDb?: { db: Db; file: string; ino: number } | null; __devinCache?: Map<string, SessionCache> };

/** Shared read-only connection; reopened if the file is replaced. Null when Devin has never run here. */
export function openDb(): Db | null {
  const file = devinDbPath();
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const cur = g.__devinDb;
  if (cur && cur.file === file && cur.ino === st.ino) return cur.db;
  try {
    cur?.db.close();
  } catch {
    /* ignore */
  }
  const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite") | undefined;
  if (!sqlite) throw new Error("node:sqlite is not available in this Node version.");
  const db = new sqlite.DatabaseSync(file, { readOnly: true, timeout: 2000 });
  g.__devinDb = { db, file, ino: st.ino };
  return db;
}

export type DevinSessionRow = {
  id: string;
  cwd: string;
  model: string;
  agentMode: string;
  createdAt: number;
  lastActivity: number;
  title: string;
  head: number | null;
  hidden: boolean;
};

const SESSION_COLS = "id, working_directory, model, agent_mode, created_at, last_activity_at, title, main_chain_id, hidden";

function toRow(r: Json): DevinSessionRow {
  return {
    id: String(r.id),
    cwd: String(r.working_directory ?? ""),
    model: String(r.model ?? ""),
    agentMode: String(r.agent_mode ?? ""),
    createdAt: Number(r.created_at ?? 0),
    lastActivity: Number(r.last_activity_at ?? 0),
    title: typeof r.title === "string" ? r.title : "",
    head: r.main_chain_id == null ? null : Number(r.main_chain_id),
    hidden: Number(r.hidden ?? 0) !== 0,
  };
}

/** Visible sessions, newest first, with the first prompt as a fallback title. */
export function listSessions(db: Db): DevinSessionRow[] {
  const rows = db.prepare(`SELECT ${SESSION_COLS} FROM sessions WHERE hidden = 0 ORDER BY last_activity_at DESC`).all() as Json[];
  const firstPrompt = db.prepare("SELECT content FROM prompt_history WHERE session_id = ? ORDER BY id LIMIT 1");
  return rows.map((r) => {
    const row = toRow(r);
    if (!row.title) {
      const p = firstPrompt.get(row.id) as Json | undefined;
      row.title = typeof p?.content === "string" ? p.content.slice(0, 120) : "";
    }
    return row;
  });
}

export function getSession(db: Db, id: string): DevinSessionRow | null {
  const r = db.prepare(`SELECT ${SESSION_COLS} FROM sessions WHERE id = ?`).get(id) as Json | undefined;
  return r ? toRow(r) : null;
}

/* ---------- logical history ---------- */

type NodeMeta = {
  parent: number | null;
  rowId: number;
  summarizedFrom: number | null;
  messageId: string;
  role: string;
  userInput: boolean;
  modeTo: string | null;
};

type SessionCache = { maxRow: number; nodes: Map<number, NodeMeta> };

/** One renderable message of the logical history. */
export type HistoryItem = { nodeId: number; messageId: string };

const cacheMap = () => (g.__devinCache ??= new Map());

/** Change detector for watch: cheap (index lookups only). */
export function signature(db: Db, id: string): string {
  const s = db.prepare("SELECT main_chain_id, last_activity_at FROM sessions WHERE id = ?").get(id) as Json | undefined;
  if (!s) return "missing";
  const m = db.prepare("SELECT max(row_id) AS m FROM message_nodes WHERE session_id = ?").get(id) as Json | undefined;
  return `${s.main_chain_id}:${m?.m ?? 0}`;
}

function loadNodes(db: Db, id: string): SessionCache {
  const caches = cacheMap();
  let c = caches.get(id);
  if (!c) {
    c = { maxRow: 0, nodes: new Map() };
    caches.set(id, c);
    if (caches.size > 24) caches.delete(caches.keys().next().value!);
  }
  const rows = db
    .prepare(
      `SELECT row_id, node_id, parent_node_id, metadata,
              json_extract(chat_message, '$.message_id') AS mid,
              json_extract(chat_message, '$.role') AS role,
              json_extract(chat_message, '$.metadata.is_user_input') AS ui,
              json_extract(chat_message, '$.metadata.extensions.mode_transition.to') AS mode_to
         FROM message_nodes WHERE session_id = ? AND row_id > ? ORDER BY row_id`,
    )
    .all(id, c.maxRow) as Json[];
  for (const r of rows) {
    let summarizedFrom: number | null = null;
    if (typeof r.metadata === "string" && r.metadata.includes("summarized_from")) {
      try {
        const m = JSON.parse(r.metadata) as Json | null;
        if (m && typeof m.summarized_from === "number") summarizedFrom = m.summarized_from;
      } catch {
        /* ignore */
      }
    }
    const rowId = Number(r.row_id);
    c.nodes.set(Number(r.node_id), {
      parent: r.parent_node_id == null ? null : Number(r.parent_node_id),
      rowId,
      summarizedFrom,
      messageId: typeof r.mid === "string" ? r.mid : `node-${r.node_id}`,
      role: String(r.role ?? ""),
      userInput: r.ui === 1 || r.ui === true || r.ui === "true",
      modeTo: typeof r.mode_to === "string" ? r.mode_to : null,
    });
    if (rowId > c.maxRow) c.maxRow = rowId;
  }
  return c;
}

function renderable(n: NodeMeta) {
  if (n.role === "assistant" || n.role === "tool") return true;
  if (n.role === "user") return n.userInput;
  if (n.role === "system") return n.summarizedFrom != null || n.modeTo != null;
  return false;
}

/** The whole visible conversation of a session, oldest first, one item per unique message. */
export function historyItems(db: Db, id: string, head?: number | null): HistoryItem[] {
  const h = head === undefined ? getSession(db, id)?.head ?? null : head;
  if (h == null) return [];
  const { nodes } = loadNodes(db, id);
  const usedHeads = new Set<number>();
  const build = (start: number, depth: number): number[] => {
    if (depth > 32 || usedHeads.has(start)) return [];
    usedHeads.add(start);
    const chain: number[] = [];
    const seen = new Set<number>();
    for (let n: number | null = start; n != null && !seen.has(n); ) {
      seen.add(n);
      const meta = nodes.get(n);
      if (!meta) break;
      chain.push(n);
      n = meta.parent;
    }
    chain.reverse();
    let summary = -1;
    for (let i = chain.length - 1; i >= 0; i--) if (nodes.get(chain[i])!.summarizedFrom != null) { summary = i; break; }
    if (summary === -1) return chain;
    return [...build(nodes.get(chain[summary])!.summarizedFrom!, depth + 1), ...chain];
  };
  const out: HistoryItem[] = [];
  const ids = new Set<string>();
  for (const nodeId of build(h, 0)) {
    const n = nodes.get(nodeId)!;
    if (ids.has(n.messageId) || !renderable(n)) continue;
    ids.add(n.messageId);
    out.push({ nodeId, messageId: n.messageId });
  }
  return out;
}

/** Loads the messages of `items` and maps them to UI entries. */
export function itemsToEntries(db: Db, id: string, items: HistoryItem[], fallbackModel = ""): Entry[] {
  if (!items.length) return [];
  const byNode = new Map<number, Json>();
  const stmt = db.prepare("SELECT node_id, chat_message, created_at FROM message_nodes WHERE session_id = ? AND node_id = ?");
  for (const it of items) {
    const r = stmt.get(id, it.nodeId) as Json | undefined;
    if (!r || typeof r.chat_message !== "string") continue;
    try {
      const m = JSON.parse(r.chat_message) as Json;
      m.__createdAt = Number(r.created_at ?? 0);
      byNode.set(it.nodeId, m);
    } catch {
      /* skip corrupt row */
    }
  }
  const entries: Entry[] = [];
  for (const it of items) {
    const m = byNode.get(it.nodeId);
    if (m) entries.push(...messageToEntries(m, fallbackModel));
  }
  return entries;
}

/* ---------- message -> Entry mapping ---------- */

const CLIP = 8000;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const s = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function tsOf(m: Json): string {
  const iso = s(obj(m.metadata).created_at);
  if (iso) return iso;
  const sec = num(m.__createdAt);
  return new Date(sec ? sec * 1000 : 0).toISOString();
}

export function messageToEntries(m: Json, fallbackModel = ""): Entry[] {
  const id = s(m.message_id) || `msg-${Math.random().toString(36).slice(2)}`;
  const ts = tsOf(m);
  const meta = obj(m.metadata);
  const ext = obj(meta.extensions);
  const role = s(m.role);

  if (role === "user") {
    const images = Array.isArray(m.images) ? m.images.length : 0;
    const blocks = ext["chisel/acp-content-blocks"];
    let text = Array.isArray(blocks)
      ? blocks.map((b) => (obj(b).type === "text" ? s(obj(b).text) : "")).filter(Boolean).join("\n")
      : "";
    if (!text) text = s(m.content).replace(/^(\[Image \d+[^\]]*\]\s*)+/, "");
    return [{ kind: "user", id, ts, text: text.trim(), images }];
  }

  if (role === "system") {
    const mode = obj(ext.mode_transition);
    if (s(mode.to)) return [{ kind: "notice", id, ts, tone: "info", text: `Switched to ${titleCase(s(mode.to))} mode` }];
    return [{ kind: "notice", id, ts, tone: "info", text: "Context compacted" }];
  }

  if (role === "tool") {
    const raw = s(m.content);
    const resMeta = obj(ext["chisel/tool_result_meta"]);
    const isError = resMeta.success === false || ext["chisel/tool_failure"] != null;
    return [
      {
        kind: "result",
        id: `${id}:r`,
        ts,
        toolUseId: s(m.tool_call_id),
        result: { text: raw.length > CLIP ? raw.slice(0, CLIP) : raw, isError, truncated: raw.length > CLIP },
      },
    ];
  }

  if (role !== "assistant") return [];
  const out: Entry[] = [];
  const thinking = s(obj(m.thinking).thinking).trim();
  if (thinking) out.push({ kind: "thinking", id: `${id}:th`, ts, msgId: id, text: thinking });
  const text = s(m.content).trim();
  if (text) out.push({ kind: "text", id: `${id}:tx`, ts, msgId: id, text });
  const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
  calls.forEach((c, i) => {
    const call = obj(c);
    const toolUseId = s(call.id) || `${id}:t${i}`;
    const { name, input } = mapTool(s(call.name), obj(call.arguments));
    out.push({ kind: "tool", id: `${id}:t${i}`, ts, msgId: id, toolUseId, name, input });
  });
  const metrics = obj(meta.metrics);
  const usage = {
    input: num(metrics.input_tokens),
    cacheRead: num(metrics.cache_read_tokens),
    cacheWrite: num(metrics.cache_creation_tokens),
    output: num(metrics.output_tokens),
  };
  if (usage.input || usage.cacheRead || usage.cacheWrite || usage.output) {
    out.push({ kind: "usage", id: `${id}:u`, ts, model: s(meta.generation_model) || fallbackModel, ...usage });
  }
  return out;
}

const titleCase = (v: string) => v.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** Devin tool names/args -> the Claude-style names the UI already knows how to render. */
export function mapTool(name: string, a: Json): { name: string; input: Json } {
  const pick = (o: Json) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));
  switch (name) {
    case "exec":
      return { name: "Bash", input: pick({ ...a, command: s(a.command), cwd: a.workdir, workdir: undefined }) };
    case "get_output":
      return { name: "BashOutput", input: pick({ bash_id: a.shell_id, ...a }) };
    case "kill_shell":
      return { name: "KillShell", input: pick({ shell_id: a.shell_id }) };
    case "read":
      return { name: "Read", input: pick({ file_path: s(a.file_path), offset: a.offset, limit: a.limit }) };
    case "edit":
      return {
        name: "Edit",
        input: pick({ file_path: s(a.file_path), old_string: s(a.old_string), new_string: s(a.new_string), replace_all: a.replace_all }),
      };
    case "write":
      return { name: "Write", input: { file_path: s(a.file_path), content: s(a.content) } };
    case "grep":
      return {
        name: "Grep",
        input: pick({
          pattern: s(a.pattern),
          path: a.path,
          glob: a.glob_pattern,
          output_mode: a.output_mode,
          "-i": a.case_insensitive,
          "-C": a.context_lines,
          head_limit: a.max_results,
        }),
      };
    case "find_file_by_name":
      return { name: "Glob", input: pick({ pattern: s(a.pattern), path: a.path }) };
    case "todo_write": {
      const todos = Array.isArray(a.todos) ? a.todos.map((t) => ({ content: s(obj(t).content), status: s(obj(t).status) || "pending" })) : [];
      return { name: "TodoWrite", input: { todos } };
    }
    case "web_search":
      return { name: "WebSearch", input: pick({ query: s(a.query), num_results: a.num_results }) };
    case "webfetch":
      return { name: "WebFetch", input: pick({ url: s(a.url) }) };
    case "run_subagent":
      return { name: "Task", input: pick({ description: a.title, prompt: a.task, subagent_type: a.profile, run_in_background: a.is_background }) };
    case "ask_user_question":
      return {
        name: "AskUserQuestion",
        input: {
          questions: (Array.isArray(a.questions) ? a.questions : []).map((q) => ({
            question: s(obj(q).question),
            header: s(obj(q).header),
            multiSelect: Boolean(obj(q).multiSelect ?? obj(q).multi_select),
            options: (Array.isArray(obj(q).options) ? (obj(q).options as unknown[]) : []).map((o) => ({ label: s(obj(o).label), description: s(obj(o).description) })),
          })),
        },
      };
    case "exit_plan_mode":
      return { name: "ExitPlanMode", input: pick({ plan: a.plan }) };
    case "skill":
      return { name: "Skill", input: pick({ skill: a.skill ?? a.command, ...a }) };
    case "mcp_call_tool":
      return { name: `mcp__${s(a.server_name) || "mcp"}__${s(a.tool_name) || "tool"}`, input: obj(a.arguments) };
    default:
      return { name: name || "tool", input: a };
  }
}
