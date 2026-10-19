import fs from "node:fs/promises";
import type { Entry, ToolResult } from "@/lib/types";

/* Claude Code transcripts are JSONL: one record per line, appended as the
 * conversation happens. This turns records into the small set of entries the
 * UI renders, dropping bookkeeping lines and subagent (sidechain) traffic. */

const RESULT_MAX = 8_000;
const INPUT_STRING_MAX = 24_000;
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

type Block = { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };
type Rec = {
  type?: string;
  subtype?: string;
  uuid?: string;
  timestamp?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  isApiErrorMessage?: boolean;
  error?: string;
  content?: string;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    content?: string | Block[];
    usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; output_tokens?: number };
  };
  attachment?: { type?: string; prompt?: string | Block[]; origin?: { kind?: string } };
  aiTitle?: string;
  customTitle?: string;
  summary?: string;
  cwd?: string;
  permissionMode?: string;
};

const clip = (text: string, max: number) => (text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false });

function trimInput(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length > INPUT_STRING_MAX ? `${value.slice(0, INPUT_STRING_MAX)}\n…` : value;
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => trimInput(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trimInput(v, depth + 1)]));
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: Block) => (part.type === "text" ? part.text ?? "" : part.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

function tag(text: string, name: string) {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  return match ? match[1].trim() : null;
}

/** User-typed strings carry wrappers for slash commands, shell escapes, and hook output. */
function userString(rec: Rec, text: string, id: string, ts: string): Entry[] {
  const command = tag(text, "command-name");
  if (command) {
    const args = tag(text, "command-args");
    return [{ kind: "user", id, ts, text: args ? `${command} ${args}` : command, images: 0 }];
  }
  const stdout = tag(text, "local-command-stdout") ?? tag(text, "bash-stdout");
  const stderr = tag(text, "local-command-stderr") ?? tag(text, "bash-stderr");
  if (stdout !== null || stderr !== null) {
    const body = [stdout, stderr].filter(Boolean).join("\n").replace(ANSI, "").trim();
    return body ? [{ kind: "notice", id, ts, tone: stderr ? "warn" : "info", text: body }] : [];
  }
  const bash = tag(text, "bash-input");
  if (bash) return [{ kind: "user", id, ts, text: `! ${bash}`, images: 0 }];
  if (text.startsWith("[Request interrupted by user")) return [{ kind: "notice", id, ts, tone: "warn", text: "Stopped" }];
  if (/^<(task-notification|local-command-caveat|user-memory-input)>/.test(text) || rec.isCompactSummary) return [];
  const imported = text.startsWith("<imported-session>") ? tag(text, "imported-session") : null;
  if (imported !== null) {
    const from = /moved here from (.+?) \(/.exec(imported)?.[1];
    return [{ kind: "notice", id, ts, tone: "info", text: from ? `Continued from ${from}` : imported }];
  }
  const clean = text.replace(SYSTEM_REMINDER, "").trim();
  return clean ? [{ kind: "user", id, ts, text: clean, images: 0 }] : [];
}

/** A user message given as text blocks and images. */
function userBlocks(rec: Rec, texts: string[], images: number, id: string, ts: string): Entry[] {
  if (!texts.length && !images) return [];
  const parsed = userString(rec, texts.join("\n\n"), id, ts);
  if (parsed.length && parsed[0].kind === "user") parsed[0] = { ...parsed[0], images };
  else if (images) parsed.push({ kind: "user", id, ts, text: "", images });
  return parsed;
}

export function parseRecord(rec: Rec): Entry[] {
  if (rec.isSidechain || !rec.uuid) return [];
  const ts = rec.timestamp ?? "";
  const base = rec.uuid;

  if (rec.type === "system") {
    if (rec.subtype === "compact_boundary") return [{ kind: "notice", id: base, ts, tone: "info", text: "Context compacted" }];
    if (rec.subtype === "informational" && rec.content) return [{ kind: "notice", id: base, ts, tone: "info", text: rec.content.replace(ANSI, "") }];
    return [];
  }

  /* a message sent while claude was mid-turn is stored as a queued command, not a user record */
  if (rec.type === "attachment") {
    const a = rec.attachment;
    if (a?.type !== "queued_command" || (a.origin?.kind && a.origin.kind !== "human")) return [];
    if (typeof a.prompt === "string") return userString(rec, a.prompt, base, ts);
    /* a queued message with a pasted image is stored as content blocks */
    if (!Array.isArray(a.prompt)) return [];
    const texts = a.prompt.flatMap((b) => (b.type === "text" && b.text ? [b.text] : []));
    return userBlocks(rec, texts, a.prompt.filter((b) => b.type === "image").length, base, ts);
  }

  const content = rec.message?.content;
  if (rec.type === "user") {
    if (typeof content === "string") return rec.isMeta ? [] : userString(rec, content, base, ts);
    if (!Array.isArray(content)) return [];
    const out: Entry[] = [];
    const texts: string[] = [];
    let images = 0;
    content.forEach((block, i) => {
      if (block.type === "tool_result" && block.tool_use_id) {
        const clipped = clip(resultText(block.content).replace(ANSI, ""), RESULT_MAX);
        const result: ToolResult = { text: clipped.text, truncated: clipped.truncated, isError: Boolean(block.is_error) };
        out.push({ kind: "result", id: `${base}:${i}`, ts, toolUseId: block.tool_use_id, result });
      } else if (block.type === "text" && block.text && !rec.isMeta) texts.push(block.text);
      else if (block.type === "image" && !rec.isMeta) images += 1;
    });
    out.unshift(...userBlocks(rec, texts, images, base, ts));
    return out;
  }

  if (rec.type === "assistant" && Array.isArray(content)) {
    const msgId = rec.message?.id ?? base;
    const u = rec.message?.usage;
    const synthetic = rec.message?.model === "<synthetic>";
    if (synthetic && rec.isApiErrorMessage) {
      const said = content.map((b) => (b.type === "text" ? b.text ?? "" : "")).join(" ").trim();
      const auth = rec.error === "authentication_failed" || /authenticat|log ?in|oauth/i.test(said);
      return [{ kind: "notice", id: base, ts, tone: "warn", text: auth ? `${said ? said.replace(/[^.!?]$/, "$&.") : "Claude couldn't sign in."} Log in again on the server: run claude, then /login.` : said || "API error." }];
    }
    /* the acknowledgement written after an imported session's preamble */
    if (synthetic && msgId.startsWith("msg_import_") && content.length === 1 && content[0].text === "Understood.") return [];
    /* one usage entry per API message: every block's record repeats it, and the shared id dedupes */
    const usage: Entry[] = u && !synthetic
      ? [{ kind: "usage", id: `${msgId}:usage`, ts, model: rec.message?.model ?? "", input: u.input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? 0 }]
      : [];
    return usage.concat(content.flatMap((block, i): Entry[] => {
      const id = `${base}:${i}`;
      if (block.type === "text" && block.text?.trim()) return [{ kind: "text", id, ts, msgId, text: block.text }];
      if (block.type === "thinking" || block.type === "redacted_thinking") return [{ kind: "thinking", id, ts, msgId, text: block.thinking ?? "" }];
      if (block.type === "tool_use" && block.id) {
        return [{ kind: "tool", id, ts, msgId, toolUseId: block.id, name: block.name ?? "tool", input: (trimInput(block.input ?? {}) as Record<string, unknown>) }];
      }
      return [];
    }));
  }
  return [];
}

export type Meta = {
  customTitle: string | null;
  aiTitle: string | null;
  cwd: string | null;
  permissionMode: string | null;
  lastPrompt: string | null;
};

export const emptyMeta = (): Meta => ({ customTitle: null, aiTitle: null, cwd: null, permissionMode: null, lastPrompt: null });

export const metaTitle = (meta: Meta) => meta.customTitle ?? meta.aiTitle ?? meta.lastPrompt?.slice(0, 80) ?? null;

/** Pulls display metadata out of a run of records; later records win. */
export function scanMeta(lines: string[], meta: Meta = emptyMeta()) {
  for (const line of lines) {
    if (line.startsWith('{"type":"custom-title"')) meta.customTitle = safeParse(line)?.customTitle ?? meta.customTitle;
    else if (line.startsWith('{"type":"ai-title"')) meta.aiTitle = safeParse(line)?.aiTitle ?? meta.aiTitle;
    else if (line.startsWith('{"type":"permission-mode"')) {
      meta.permissionMode = safeParse(line)?.permissionMode ?? meta.permissionMode;
    } else if (line.startsWith('{"type":"last-prompt"')) {
      const rec = safeParse(line) as { lastPrompt?: string } | null;
      if (rec?.lastPrompt) meta.lastPrompt = rec.lastPrompt;
    } else if (!meta.lastPrompt && line.includes('"type":"user"') && line.includes('"origin":{"kind":"human"}')) {
      const content = safeParse(line)?.message?.content;
      if (typeof content === "string" && !content.startsWith("<")) meta.lastPrompt = content;
    }
    if (!meta.cwd && line.includes('"cwd":"')) meta.cwd = safeParse(line)?.cwd ?? null;
  }
  return meta;
}

export function safeParse(line: string): Rec | null {
  try {
    return JSON.parse(line) as Rec;
  } catch {
    return null;
  }
}

export const parseLines = (lines: string[]) => lines.flatMap((line) => {
  const rec = line ? safeParse(line) : null;
  return rec ? parseRecord(rec) : [];
});

/** Entries from outside the transcript (a web run's slash command output, notices; oldest first) placed among a
 * history page by time, so they stay where they happened. Ones without a usable time go last. */
export function placeByTime(page: Entry[], extras: Entry[]): Entry[] {
  if (!extras.length) return page;
  const out: Entry[] = [];
  let j = 0;
  for (const e of page) {
    const at = Date.parse(e.ts);
    while (j < extras.length && Date.parse(extras[j].ts) < at) out.push(extras[j++]);
    out.push(e);
  }
  return [...out, ...extras.slice(j)];
}

/**
 * Reads the complete lines inside [start, end). A start mid-line skips to the
 * next line break; a trailing partial line (still being written) is left out,
 * `begin` is where the first returned line starts and `end` is the offset just
 * past the last complete line.
 */
export async function readLines(file: string, start: number, end: number) {
  start = Math.max(0, Math.floor(start));
  end = Math.floor(end);
  if (end <= start) return { lines: [] as string[], begin: start, end: start };
  const handle = await fs.open(file, "r");
  try {
    /* read one byte early: if it's a newline, `start` is already on a line boundary (the live tail case) */
    const from = Math.max(0, start - 1);
    const buf = Buffer.alloc(end - from);
    const { bytesRead } = await handle.read(buf, 0, buf.length, from);
    const last = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
    const first = start === 0 ? 0 : buf.indexOf(0x0a) + 1;
    if (last === -1 || first > last + 1) return { lines: [] as string[], begin: start, end: start };
    const text = buf.subarray(first, last).toString("utf8");
    return { lines: text.split("\n").filter(Boolean), begin: from + first, end: from + last + 1 };
  } finally {
    await handle.close();
  }
}

const PAGE_BYTES = 2_500_000;
const MAX_PAGE_BYTES = 4 * PAGE_BYTES;
const MIN_ENTRIES = 60;

/** One page of history ending at `before` (exclusive byte offset); cursor is the next `before`, null at the top. */
export async function readHistory(file: string, before?: number) {
  const { size } = await fs.stat(file);
  const limit = Math.min(before ?? size, size);
  let window = PAGE_BYTES;
  for (;;) {
    const start = Math.max(0, limit - window);
    const { lines, begin, end } = await readLines(file, start, limit);
    const entries = parseLines(lines);
    if (entries.length >= MIN_ENTRIES || start === 0 || window >= MAX_PAGE_BYTES) {
      /* no complete line in the window (one giant record): step past it instead of returning the same cursor forever */
      const top = lines.length ? begin : start;
      return { entries, cursor: top === 0 ? null : top, end };
    }
    window *= 2;
  }
}

/** Reads a slice from the head and tail of a file, enough for listing metadata without loading it. */
export async function readEdges(file: string, size: number, headBytes = 24_000, tailBytes = 200_000) {
  const head = (await readLines(file, 0, Math.min(size, headBytes))).lines;
  const tail = size > headBytes ? (await readLines(file, Math.max(headBytes, size - tailBytes), size)).lines : [];
  return { head, tail };
}
