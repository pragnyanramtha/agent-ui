import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Entry } from "@/lib/types";
import { clipResult } from "./cursor-tools";

/* Read-only view of Gemini CLI's saved chats (v0.64).
 *
 * Root: $GEMINI_CLI_HOME/.gemini, else ~/.gemini.
 *   projects.json                                 {projects: {"/abs/path": "slug"}}
 *   tmp/<slug>/.project_root                       the project's absolute path (the cwd a resume needs)
 *   tmp/<slug>/chats/session-<YYYY-MM-DDTHH-MM>-<first 8 of id>.jsonl   one chat (subagents nest in chats/<parentId>/)
 * Older releases wrote tmp/<slug>/chats/session-*.json, one object with messages[].
 *
 * A .jsonl chat is an append log folded in order:
 *   first line   {sessionId, projectHash, startTime, lastUpdated, kind: "main"}
 *   a message    {id, timestamp, type: user|gemini|info|warning|error, content, thoughts?, tokens?, model?, toolCalls?};
 *                one whose id already exists replaces it in place
 *   {$set: {...}}                                  metadata (summary is the title)
 *   {$patch: {updates: [{id, ...}], removeIds?, orderIds?}}
 *   {$rewindTo: id}                                drops that message and everything after */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

export type GeminiToolCall = {
  id?: string;
  name?: string;
  args?: unknown;
  result?: unknown;
  status?: string;
  resultDisplay?: unknown;
  displayName?: string;
  description?: string;
  timestamp?: string;
};

export type GeminiMessage = {
  id: string;
  timestamp?: string;
  type?: string;
  content?: unknown;
  thoughts?: { subject?: string; description?: string; timestamp?: string }[];
  tokens?: { input?: number; output?: number; cached?: number; thoughts?: number; tool?: number; total?: number } | null;
  model?: string;
  toolCalls?: GeminiToolCall[];
};

export type GeminiFold = { meta: Obj; messages: GeminiMessage[] };

/* ── folding ───────────────────────────────────────────────── */

function reorder(messages: GeminiMessage[], ids: string[]): GeminiMessage[] {
  const want = ids.filter((id, i) => ids.indexOf(id) === i && messages.some((m) => m.id === id));
  const slots = messages.map((m, i) => (want.includes(m.id) ? i : -1)).filter((i) => i >= 0);
  const byId = new Map(messages.map((m) => [m.id, m]));
  const out = messages.slice();
  slots.forEach((slot, k) => (out[slot] = byId.get(want[k])!));
  return out;
}

/** Applies one record of the log to the fold (unknown shapes are ignored). */
export function applyRecord(fold: GeminiFold, r: unknown): void {
  if (!isObj(r)) return;
  let control = false;
  if (isObj(r.$set)) {
    Object.assign(fold.meta, r.$set);
    control = true;
  }
  if (isObj(r.$patch)) {
    control = true;
    const p = r.$patch;
    for (const u of Array.isArray(p.updates) ? p.updates : []) {
      if (!isObj(u) || typeof u.id !== "string") continue;
      const i = fold.messages.findIndex((m) => m.id === u.id);
      if (i !== -1) fold.messages[i] = { ...fold.messages[i], ...(u as Partial<GeminiMessage>), id: u.id };
    }
    if (Array.isArray(p.removeIds)) {
      const drop = new Set(p.removeIds.filter((x): x is string => typeof x === "string"));
      fold.messages = fold.messages.filter((m) => !drop.has(m.id));
    }
    if (Array.isArray(p.orderIds)) fold.messages = reorder(fold.messages, p.orderIds.filter((x): x is string => typeof x === "string"));
  }
  if (typeof r.$rewindTo === "string") {
    control = true;
    const i = fold.messages.findIndex((m) => m.id === r.$rewindTo);
    if (i !== -1) fold.messages.length = i;
  }
  if (control) return;
  if (typeof r.id === "string" && typeof r.type === "string") {
    const msg = r as GeminiMessage;
    const i = fold.messages.findIndex((m) => m.id === msg.id);
    if (i === -1) fold.messages.push(msg);
    else fold.messages[i] = msg;
    return;
  }
  /* the header */
  if (typeof r.sessionId === "string") Object.assign(fold.meta, r);
}

/** A whole chat file (.jsonl log or a legacy .json object) folded into its current messages. */
export function foldChat(text: string): GeminiFold {
  const fold: GeminiFold = { meta: {}, messages: [] };
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    /* a log fails to parse as one value at its second line */
    try {
      const j = JSON.parse(trimmed);
      if (isObj(j) && Array.isArray(j.messages)) return legacy(j);
    } catch {
      /* a log */
    }
  }
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      applyRecord(fold, JSON.parse(line));
    } catch {
      /* a partial last line */
    }
  }
  return fold;
}

function legacy(j: Obj): GeminiFold {
  const { messages, ...meta } = j;
  const fold: GeminiFold = { meta, messages: [] };
  for (const m of messages as unknown[]) applyRecord(fold, m);
  return fold;
}

/* ── tools ─────────────────────────────────────────────────── */

const pick = (o: Obj, ...keys: string[]) => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k];
  return undefined;
};
const compact = (o: Obj) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

function todoStatus(v: unknown): string {
  const t = String(v ?? "").toLowerCase();
  if (t === "in_progress" || t === "in-progress" || t === "active") return "in_progress";
  if (t === "completed" || t === "done" || t === "cancelled" || t === "canceled") return "completed";
  return "pending";
}

function argsOf(raw: unknown): Obj {
  if (isObj(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const j = JSON.parse(raw);
      return isObj(j) ? j : { value: raw };
    } catch {
      return { value: raw };
    }
  }
  return {};
}

/** Gemini's tool names and arguments -> the Claude-shaped ones the tool cards render. */
export function mapGeminiTool(rawName: string, rawArgs: unknown): { name: string; input: Obj } {
  const a = argsOf(rawArgs);
  const file = str(pick(a, "file_path", "absolute_path", "path"));
  switch (rawName) {
    case "run_shell_command":
      return { name: "Bash", input: compact({ command: str(a.command) ?? "", description: str(a.description), cwd: str(pick(a, "dir_path", "directory")) }) };
    case "read_file":
      return { name: "Read", input: compact({ file_path: file ?? "", offset: typeof a.offset === "number" ? a.offset : undefined, limit: typeof a.limit === "number" ? a.limit : undefined }) };
    case "write_file":
      return { name: "Write", input: { file_path: file ?? "", content: str(a.content) ?? "" } };
    case "replace":
      return { name: "Edit", input: compact({ file_path: file ?? "", old_string: str(a.old_string) ?? "", new_string: str(a.new_string) ?? "", replace_all: a.allow_multiple === true || Number(a.expected_replacements) > 1 ? true : undefined }) };
    case "glob":
      return { name: "Glob", input: compact({ pattern: str(a.pattern) ?? "", path: str(pick(a, "dir_path", "path")) }) };
    case "grep_search":
    case "search_file_content":
      return { name: "Grep", input: compact({ pattern: str(a.pattern) ?? "", path: str(pick(a, "dir_path", "path")), glob: str(pick(a, "include_pattern", "include")) }) };
    case "list_directory":
      return { name: "LS", input: { path: str(pick(a, "dir_path", "path")) ?? "" } };
    case "google_web_search":
      return { name: "WebSearch", input: { query: str(a.query) ?? "" } };
    case "web_fetch": {
      const prompt = str(pick(a, "prompt", "url")) ?? "";
      return { name: "WebFetch", input: compact({ url: /https?:\/\/\S+/.exec(prompt)?.[0] ?? prompt, prompt: prompt || undefined }) };
    }
    case "write_todos":
      return {
        name: "TodoWrite",
        input: { todos: (Array.isArray(a.todos) ? a.todos : []).filter(isObj).map((t) => ({ content: String(t.description ?? t.content ?? ""), status: todoStatus(t.status) })) },
      };
    case "invoke_agent":
      return {
        name: "Task",
        input: compact({ description: str(pick(a, "description", "agent_name", "name")) ?? "", prompt: str(pick(a, "prompt", "task", "query", "objective")), subagent_type: str(pick(a, "agent_name", "name")) }),
      };
    case "exit_plan_mode":
      return { name: "ExitPlanMode", input: { plan: str(pick(a, "plan", "plan_path", "content")) ?? "" } };
    default:
      return { name: rawName || "tool", input: a };
  }
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined || v === null) return "";
  try {
    return JSON.stringify(v, null, 2) ?? "";
  } catch {
    return String(v);
  }
}

/**
 * run_shell_command's report to the model: "<untrusted_context>\nOutput: …\nExit Code: 3\nProcess Group PGID: 7\n</untrusted_context>"
 * (Exit Code only when non-zero; "Output: (empty)" when there was none) -> the output, and whether the command failed.
 */
export function shellReport(raw: string, display?: unknown): { text: string; failed: boolean } {
  const body = raw.trim().replace(/^<untrusted_context>\s*/, "").replace(/\s*<\/untrusted_context>$/, "");
  if (!body.startsWith("Output: ")) return { text: raw, failed: false };
  const rest = body.slice("Output: ".length);
  /* the trailer follows the output in a fixed order, so it's read from the end: the command's own output can
   * contain "Exit Code: 1" too. With the display string the output's exact length is known. */
  let output = rest;
  let trailer: string[] = [];
  if (typeof display === "string" && display && rest.startsWith(display) && (rest.length === display.length || rest[display.length] === "\n")) {
    output = display;
    trailer = rest.slice(display.length).split("\n").filter(Boolean);
  } else {
    const lines = rest.split("\n");
    let order = TRAILER.length;
    while (lines.length > 1) {
      const at = TRAILER.findIndex((k) => lines[lines.length - 1].startsWith(`${k}: `));
      if (at < 0 || at >= order) break;
      order = at;
      trailer.unshift(lines.pop()!);
    }
    output = lines.join("\n");
  }
  const code = trailer.map((l) => /^Exit Code: (-?\d+)\s*$/.exec(l)).find(Boolean);
  const text = output.replace(/^\(empty\)$/, "").trim();
  return { text, failed: !!code && Number(code[1]) !== 0 };
}
const TRAILER = ["Error", "Exit Code", "Signal", "Background PIDs", "Process Group PGID"];

/** What the model was told a tool call returned. */
function modelResult(tc: GeminiToolCall): string {
  const parts = Array.isArray(tc.result) ? tc.result : tc.result !== undefined ? [tc.result] : [];
  const out: string[] = [];
  for (const p of parts) {
    const fr = isObj(p) && isObj(p.functionResponse) ? p.functionResponse : null;
    const resp = fr && isObj(fr.response) ? fr.response : null;
    if (resp) out.push(stringify(pick(resp, "output", "error", "llmContent") ?? (Object.keys(resp).length ? resp : "")));
    else if (isObj(p) && typeof p.text === "string") out.push(p.text);
  }
  return out.filter(Boolean).join("\n");
}

/** The text a finished tool call shows: its display string, else what the model was told. */
export function toolResultText(tc: GeminiToolCall): string {
  if (typeof tc.resultDisplay === "string" && tc.resultDisplay) return tc.resultDisplay;
  const text = modelResult(tc);
  return tc.name === "run_shell_command" ? shellReport(text).text : text;
}

const DONE = new Set(["success", "error", "cancelled", "canceled"]);

/* ── entries ───────────────────────────────────────────────── */

type Part = { text?: string; thought?: boolean; functionCall?: unknown; functionResponse?: unknown; inlineData?: unknown; fileData?: unknown };

function partsOf(content: unknown): Part[] {
  if (typeof content === "string") return [{ text: content }];
  if (Array.isArray(content)) return content.flatMap(partsOf);
  if (isObj(content)) return [content as Part];
  return [];
}

/* context the CLI injects, and its built-in slash commands ("/stats", not "/tmp is full, clean it") */
const COMMANDS =
  "about|agents|auth|bug|chat|clear|commands|compact|compress|copy|corgi|dir|directory|docs|editor|exit|extensions|help|hooks|ide|init|login|logout|mcp|memory|model|permissions|plan|policies|privacy|profile|quit|restore|resume|rewind|settings|setup-github|shortcuts|skills|stats|status|tasks|terminal-setup|theme|tools|trust|upgrade|usage|vim|voice";
const SKIP_USER = new RegExp(`^(<session_context>|<hook_context>|/(${COMMANDS})(\\s|$))`, "i");
const CONTEXT_PART = /^\s*<(session_context|hook_context)>/;
/** Gemini models all have a 1M window */
const WINDOW = 1_048_576;

/** A folded chat as UI entries. Ids are stable across re-folds, so a watcher can send only what's new. */
export function geminiEntries(fold: GeminiFold): Entry[] {
  const out: Entry[] = [];
  const startTs = str(fold.meta.startTime);
  let lastTs = startTs ?? new Date(0).toISOString();
  for (const m of fold.messages) {
    const ts = m.timestamp && !Number.isNaN(Date.parse(m.timestamp)) ? m.timestamp : lastTs;
    lastTs = ts;
    const parts = partsOf(m.content);
    if (m.type === "user") {
      if (parts.length && parts.every((p) => p.functionResponse !== undefined)) continue;
      const text = parts
        .filter((p) => typeof p.text === "string" && !p.thought && !CONTEXT_PART.test(p.text))
        .map((p) => p.text!)
        .join("\n")
        .trim();
      const images = parts.filter((p) => p.inlineData !== undefined || p.fileData !== undefined).length;
      if ((!text && !images) || SKIP_USER.test(text)) continue;
      out.push({ kind: "user", id: `${m.id}:x`, ts, text, images });
      continue;
    }
    if (m.type === "gemini" || m.type === "model") {
      (m.thoughts ?? []).forEach((t, i) => {
        const text = [t.subject ? `**${t.subject}**` : "", t.description ?? ""].filter(Boolean).join("\n\n").trim();
        if (text) out.push({ kind: "thinking", id: `${m.id}:t${i}`, ts, msgId: m.id, text });
      });
      /* a resumed chat's $patch can rewrite content with the same thinking as thought parts */
      const thought = m.thoughts?.length ? "" : parts.filter((p) => p.thought && p.text).map((p) => p.text!).join("\n").trim();
      if (thought) out.push({ kind: "thinking", id: `${m.id}:tp`, ts, msgId: m.id, text: thought });
      const text = parts.filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text!).join("").trim();
      if (text) out.push({ kind: "text", id: `${m.id}:x`, ts, msgId: m.id, text });
      for (const [i, tc] of (m.toolCalls ?? []).entries()) {
        const callId = tc.id || `${m.id}:c${i}`;
        const { name, input } = mapGeminiTool(tc.name ?? "tool", tc.args);
        out.push({ kind: "tool", id: `${m.id}:${callId}`, ts: tc.timestamp ?? ts, msgId: m.id, toolUseId: callId, name, input });
        const status = String(tc.status ?? "").toLowerCase();
        if (DONE.has(status) || (!status && tc.result !== undefined)) {
          /* a failing command is still a "success" of the tool; only its report says it exited non-zero */
          const isError = (status !== "success" && status !== "") || (tc.name === "run_shell_command" && shellReport(modelResult(tc), tc.resultDisplay).failed);
          const body = toolResultText(tc) || (status === "cancelled" || status === "canceled" ? "Cancelled" : "");
          out.push({ kind: "result", id: `${m.id}:${callId}:r`, ts, toolUseId: callId, result: clipResult(body, isError) });
        }
      }
      const tk = m.tokens;
      if (tk && (tk.input || tk.output)) {
        const cached = tk.cached ?? 0;
        out.push({
          kind: "usage",
          id: `${m.id}:u`,
          ts,
          model: m.model || str(fold.meta.model) || "gemini",
          input: Math.max(0, (tk.input ?? 0) - cached),
          cacheRead: cached,
          cacheWrite: 0,
          output: tk.output ?? 0,
          window: WINDOW,
        });
      }
      continue;
    }
    if (m.type === "info" || m.type === "warning" || m.type === "error") {
      const text = parts.map((p) => p.text ?? "").join("\n").trim();
      if (text) out.push({ kind: "notice", id: `${m.id}:x`, ts, tone: m.type === "info" ? "info" : "warn", text: text.slice(0, 2000) });
    }
  }
  return out;
}

/** The chat's title: its summary, else the first thing the user typed. */
export function chatTitle(fold: GeminiFold): string {
  const summary = str(fold.meta.summary)?.trim();
  if (summary) return summary;
  for (const e of geminiEntries({ meta: {}, messages: fold.messages.filter((m) => m.type === "user") })) {
    if (e.kind === "user" && e.text) return oneLine(e.text);
  }
  return "";
}

const oneLine = (t: string) => {
  const l = t.replace(/\s+/g, " ").trim();
  return l.length > 120 ? `${l.slice(0, 119)}…` : l;
};

/* ── files ─────────────────────────────────────────────────── */

export const geminiRoot = (home = process.env.GEMINI_CLI_HOME || os.homedir()) => path.join(home, ".gemini");

export type ChatFile = { id: string; file: string; cwd: string; mtime: number; size: number };

const CHAT_FILE = /^session-.*\.jsonl?$/;
const headers = new Map<string, { mtime: number; id: string | null; kind: string | null }>();

function readHead(file: string, bytes: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/** sessionId and kind from a chat file's first line (or the legacy object), cached per file */
function header(file: string, mtime: number): { id: string | null; kind: string | null } {
  const hit = headers.get(file);
  /* a log's header never changes; a legacy file is rewritten whole */
  if (hit && (file.endsWith(".jsonl") || hit.mtime === mtime)) return hit;
  let id: string | null = null;
  let kind: string | null = null;
  try {
    if (file.endsWith(".jsonl")) {
      const first = readHead(file, 64 * 1024).split("\n")[0];
      const j = JSON.parse(first) as Obj;
      id = str(j.sessionId) ?? null;
      kind = str(j.kind) ?? null;
    } else {
      const head = readHead(file, 4096);
      id = /"sessionId"\s*:\s*"([^"]+)"/.exec(head)?.[1] ?? null;
      kind = /"kind"\s*:\s*"([^"]+)"/.exec(head)?.[1] ?? null;
    }
  } catch {
    /* empty or partial */
  }
  const out = { mtime, id, kind };
  if (id) headers.set(file, out);
  return out;
}

function projectRoots(root: string): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, "projects.json"), "utf8")) as { projects?: Record<string, unknown> };
    for (const [abs, slug] of Object.entries(j.projects ?? {})) if (typeof slug === "string") map.set(slug, abs);
  } catch {
    /* none yet */
  }
  return map;
}

/** Every main chat under the given roots; the newest file wins when two carry the same id. */
export function chatFiles(roots: string[]): Map<string, ChatFile> {
  const out = new Map<string, ChatFile>();
  for (const root of roots) {
    const tmp = path.join(root, "tmp");
    let slugs: string[];
    try {
      slugs = fs.readdirSync(tmp);
    } catch {
      continue;
    }
    const bySlug = projectRoots(root);
    for (const slug of slugs) {
      const chats = path.join(tmp, slug, "chats");
      let names: string[];
      try {
        names = fs.readdirSync(chats).filter((n) => CHAT_FILE.test(n));
      } catch {
        continue;
      }
      let cwd = "";
      try {
        cwd = fs.readFileSync(path.join(tmp, slug, ".project_root"), "utf8").trim();
      } catch {
        cwd = bySlug.get(slug) ?? "";
      }
      for (const n of names) {
        const file = path.join(chats, n);
        let st: fs.Stats;
        try {
          st = fs.statSync(file);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        const h = header(file, st.mtimeMs);
        if (!h.id || (h.kind && h.kind !== "main")) continue;
        const prev = out.get(h.id);
        if (!prev || prev.mtime < st.mtimeMs) out.set(h.id, { id: h.id, file, cwd, mtime: st.mtimeMs, size: st.size });
      }
    }
  }
  return out;
}

const folds = new Map<string, { mtime: number; size: number; fold: GeminiFold }>();

/** The folded chat, re-read only when the file changed. */
export function readChat(file: string): GeminiFold | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const hit = folds.get(file);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.fold;
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const fold = foldChat(text);
  folds.set(file, { mtime: st.mtimeMs, size: st.size, fold });
  if (folds.size > 64) folds.delete(folds.keys().next().value!);
  return fold;
}

const summaries = new Map<string, { mtime: number; size: number; title: string; model: string | null }>();
const FULL_READ = 4 << 20;

/** Title and model for the list. Large chats are judged from their first and last stretch only. */
export function chatSummary(c: ChatFile): { title: string; model: string | null } {
  const hit = summaries.get(c.file);
  if (hit && hit.mtime === c.mtime && hit.size === c.size) return hit;
  let title = "";
  let model: string | null = null;
  if (c.size <= FULL_READ) {
    const fold = readChat(c.file);
    if (fold) {
      title = chatTitle(fold);
      model = [...fold.messages].reverse().find((m) => m.model)?.model ?? null;
    }
  } else {
    try {
      const head = foldChat(readHead(c.file, 1 << 20).split("\n").slice(0, -1).join("\n"));
      const fd = fs.openSync(c.file, "r");
      let tail = "";
      try {
        const len = 256 * 1024;
        const buf = Buffer.alloc(len);
        const n = fs.readSync(fd, buf, 0, len, Math.max(0, c.size - len));
        tail = buf.subarray(0, n).toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
      let summary = "";
      for (const line of tail.split("\n").slice(1)) {
        if (!line.includes('"$set"')) continue;
        try {
          const s = (JSON.parse(line) as { $set?: { summary?: unknown } }).$set?.summary;
          if (typeof s === "string" && s.trim()) summary = s.trim();
        } catch {
          /* partial */
        }
      }
      title = summary || chatTitle(head);
      model = /"model":"([^"]+)"/.exec(tail)?.[1] ?? [...head.messages].reverse().find((m) => m.model)?.model ?? null;
    } catch {
      /* unreadable */
    }
  }
  const out = { mtime: c.mtime, size: c.size, title, model };
  summaries.set(c.file, out);
  return out;
}
