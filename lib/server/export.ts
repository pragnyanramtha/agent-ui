import type { AgentId, Entry, ToolResult } from "@/lib/types";
import { AGENT_LABEL } from "@/lib/types";
import { splitAttachments } from "@/lib/attachments";
import { handoffTitle, parseHandoff } from "@/lib/handoff-text";
import { compact, lineDiff } from "@/lib/client/diff";
import { cleanResult, parsePatch, relativeTo, summarizeTool } from "@/lib/client/tools";
import { adapterFor, parseSessionKey, sessionKey } from "./agents";
import { sessionContext } from "./http";
import { getSessionMeta } from "./profiles";
import { metaTitle, readHistory } from "./transcript";

/* Downloading a session as Markdown (to read or share) or JSON (the raw entries). */

export type ToolDetail = "summary" | "full" | "none";
export const TOOL_DETAILS: ToolDetail[] = ["summary", "full", "none"];

export type SessionExport = { id: string; agent: AgentId; title: string; cwd: string; entries: Entry[] };

/* a cursor that stops moving would page forever */
const MAX_PAGES = 10_000;

/** Every entry of a session, oldest first, or null when there is no such session (same key rules as GET /api/sessions/[id]). */
export async function collectSession(raw: string): Promise<SessionExport | null> {
  const key = parseSessionKey(raw);
  if (!key) return null;
  const id = sessionKey(key.agent, key.native);
  const custom = getSessionMeta(id).title;
  const chunks: Entry[][] = [];
  if (key.agent === "claude") {
    const ctx = await sessionContext(key.native);
    if (!ctx) return null;
    let page = await readHistory(ctx.file);
    chunks.push(page.entries);
    for (let i = 0; page.cursor !== null && i < MAX_PAGES; i++) {
      const before = page.cursor;
      page = await readHistory(ctx.file, before);
      chunks.unshift(page.entries);
      if (page.cursor !== null && page.cursor >= before) break;
    }
    return { id, agent: "claude", title: custom ?? metaTitle(ctx.meta) ?? "New session", cwd: ctx.cwd, entries: dedupe(chunks.flat()) };
  }
  const a = await adapterFor(key.agent);
  const session = a ? await a.get(key.native) : null;
  if (!a || !session) return null;
  let page = await a.history(key.native, null);
  chunks.push(page.entries);
  const seen = new Set<string>();
  for (let i = 0; page.cursor && !seen.has(page.cursor) && i < MAX_PAGES; i++) {
    seen.add(page.cursor);
    page = await a.history(key.native, page.cursor);
    chunks.unshift(page.entries);
  }
  return { id, agent: key.agent, title: custom ?? (handoffTitle(session.title) || `New ${a.label} session`), cwd: session.cwd, entries: dedupe(chunks.flat()) };
}

/** Claude repeats a message's usage on every block's record; the latest copy wins, in the first one's place. */
function dedupe(entries: Entry[]): Entry[] {
  const byId = new Map<string, Entry>();
  for (const e of entries) byId.set(`${e.kind}:${e.id}`, e);
  return [...byId.values()];
}

export function toJson(s: SessionExport, exportedAt = new Date()) {
  return { format: "agent-u-session", version: 1, id: s.id, agent: s.agent, title: s.title, cwd: s.cwd, exportedAt: exportedAt.toISOString(), entries: s.entries };
}

/* ── file names ───────────────────────────────────────────── */

export function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug || "session";
}

/** "fix-the-build-2026-10-18.md": the title and the day the session started (today if unknown). */
export function exportFilename(title: string, entries: Entry[], ext: "md" | "json", now = new Date()) {
  const first = entries.map((e) => new Date(e.ts)).find((d) => !Number.isNaN(d.getTime())) ?? now;
  return `${slugify(title)}-${first.toISOString().slice(0, 10)}.${ext}`;
}

/* ── Markdown ─────────────────────────────────────────────── */

export type MarkdownOptions = { title: string; agent: AgentId; cwd: string; tools?: ToolDetail; exportedAt?: Date };

const OUTPUT_LINES = 40;
const OUTPUT_CHARS = 2_000;
const DIFF_LINES = 400;
const CHIP_CHARS = 200;
/* their results only say the file changed; the diff already shows how */
const QUIET_RESULTS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "ApplyPatch", "apply_patch", "TodoWrite"]);

const str = (v: unknown) => (typeof v === "string" ? v : "");
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const clipChars = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const longestRun = (s: string, ch: string) => Math.max(0, ...[...s.matchAll(new RegExp(`\\${ch}+`, "g"))].map((m) => m[0].length));

/** an inline code span that survives backticks inside it */
export function code(s: string): string {
  if (!s) return "";
  const tick = "`".repeat(longestRun(s, "`") + 1);
  const pad = s.startsWith("`") || s.endsWith("`") ? " " : "";
  return `${tick}${pad}${s}${pad}${tick}`;
}

function fence(lang: string, body: string): string {
  const tick = "`".repeat(Math.max(3, longestRun(body, "`") + 1));
  return `${tick}${lang}\n${body.replace(/\n+$/, "")}\n${tick}`;
}

const escapeInline = (s: string) => s.replace(/[\\`*_[\]<>#|~]/g, "\\$&");
const quote = (s: string) => s.trim().split("\n").map((l) => (l.trim() ? `> ${l}` : ">")).join("\n");

function fmtDate(ts: string | undefined): string | null {
  const d = ts ? new Date(ts) : null;
  return d && !Number.isNaN(d.getTime()) ? `${d.toISOString().slice(0, 16).replace("T", " ")} UTC` : null;
}

function clipOutput(text: string, cut: boolean): string {
  let lines = text.split("\n");
  let more = 0;
  if (lines.length > OUTPUT_LINES) {
    more = lines.length - OUTPUT_LINES;
    lines = lines.slice(0, OUTPUT_LINES);
  }
  let out = lines.join("\n");
  if (out.length > OUTPUT_CHARS) {
    out = out.slice(0, OUTPUT_CHARS);
    cut = true;
  }
  return more ? `${out}\n… ${more} more lines` : cut ? `${out}\n…` : out;
}

function capDiff(lines: string[]): string {
  return lines.length > DIFF_LINES ? [...lines.slice(0, DIFF_LINES), `… ${lines.length - DIFF_LINES} more lines`].join("\n") : lines.join("\n");
}

function editDiff(before: string, after: string): string[] {
  return compact(lineDiff(before, after)).map((l) => ("gap" in l ? `@@ ${l.gap} unchanged lines @@` : `${l.tone === "add" ? "+" : l.tone === "del" ? "-" : " "}${l.text}`));
}

/** `- Ran \`npm test\``, `- Edited \`src/a.ts\``: the same verbs the thread shows, with paths relative to the session folder. */
export function toolLine(e: Extract<Entry, { kind: "tool" }>, result: ToolResult | undefined, cwd: string): string {
  const input = e.input ?? {};
  const s = summarizeTool(e.name, input);
  let verb = s.verb;
  let chip = s.chip;
  const file = str(input.file_path) || str(input.notebook_path) || (e.name === "LS" ? str(input.path) : "");
  if (e.name === "Bash") {
    verb = "Ran";
    chip = str(input.command);
  } else if (file) chip = relativeTo(file, cwd);
  chip = clipChars(oneLine(chip), CHIP_CHARS);
  const what = chip ? ` ${s.mono ? code(chip) : escapeInline(chip)}` : "";
  return `- ${verb}${what}${result?.isError ? " (failed)" : ""}`;
}

/** what tools="full" adds under a tool's line: diffs, a long command, its output */
function toolDetails(e: Extract<Entry, { kind: "tool" }>, result: ToolResult | undefined, cwd: string): string[] {
  const input = e.input ?? {};
  const out: string[] = [];
  switch (e.name) {
    case "Edit":
      out.push(fence("diff", capDiff(editDiff(str(input.old_string), str(input.new_string)))));
      break;
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : [];
      if (edits.length) out.push(fence("diff", capDiff(edits.flatMap((x, i) => [...(i ? ["@@"] : []), ...editDiff(str(x?.old_string), str(x?.new_string))]))));
      break;
    }
    case "Write": {
      const content = str(input.content);
      if (content) out.push(fence("diff", capDiff(content.replace(/\n$/, "").split("\n").map((l) => `+${l}`))));
      break;
    }
    case "ApplyPatch":
    case "apply_patch": {
      const patch = str(input.patch);
      const files = parsePatch(patch);
      const lines = files.length
        ? files.flatMap((f) => [`--- ${relativeTo(f.path, cwd)}`, `+++ ${relativeTo(f.moveTo ?? f.path, cwd)}`, ...f.lines.map((l) => (l.tone === "hunk" ? (l.text ? `@@ ${l.text} @@` : "@@") : `${l.tone === "add" ? "+" : l.tone === "del" ? "-" : " "}${l.text}`))])
        : patch.split("\n");
      if (patch.trim()) out.push(fence("diff", capDiff(lines)));
      break;
    }
    case "Bash": {
      const cmd = str(input.command);
      if (cmd.includes("\n") || cmd.length > CHIP_CHARS) out.push(fence("sh", cmd));
      break;
    }
  }
  const text = result && !QUIET_RESULTS.has(e.name) ? cleanResult(result.text) : "";
  if (text.trim()) out.push(fence("text", clipOutput(text, result!.truncated)));
  return out;
}

/** A readable transcript: user and agent text in full, thinking and usage left out, tool calls as one-line summaries. */
export function toMarkdown(entries: Entry[], o: MarkdownOptions): string {
  const tools = o.tools ?? "summary";
  const label = AGENT_LABEL[o.agent];
  const cwd = o.cwd;
  const results = new Map<string, ToolResult>();
  for (const e of entries) if (e.kind === "result") results.set(e.toolUseId, e.result);

  const head = [`# ${escapeInline(oneLine(o.title)) || "Session"}`, "", `- Agent: ${label}`];
  if (cwd) head.push(`- Folder: ${code(cwd)}`);
  const started = fmtDate(entries.find((e) => fmtDate(e.ts))?.ts);
  if (started) head.push(`- Started: ${started}`);
  head.push(`- Exported: ${fmtDate((o.exportedAt ?? new Date()).toISOString())}`);

  const blocks: string[] = [head.join("\n")];
  /* consecutive tool lines form one list */
  let list: string[] = [];
  let speaker: "user" | "agent" | null = null;
  const flush = () => {
    if (list.length) blocks.push(list.join("\n"));
    list = [];
  };
  const push = (block: string) => {
    flush();
    blocks.push(block);
  };
  const turn = (who: "user" | "agent") => {
    if (speaker === who) return;
    speaker = who;
    push(who === "user" ? "## User" : `## ${label}`);
  };
  /* keeps the author's markdown: only blank edges go */
  const body = (s: string) => s.replace(/^(?:[ \t]*\n)+/, "").trimEnd();

  for (const e of entries) {
    switch (e.kind) {
      case "user": {
        const handoff = parseHandoff(e.text);
        if (handoff) push(quote(`Continued from ${handoff.from}`));
        const { text, paths } = splitAttachments(handoff ? handoff.next : e.text);
        if (!body(text) && !paths.length && !e.images) break;
        turn("user");
        if (body(text)) push(body(text));
        if (e.images) push(`_${e.images === 1 ? "1 image" : `${e.images} images`}_`);
        if (paths.length) push(["Attached files:", ...paths.map((p) => `- ${code(p)}`)].join("\n"));
        break;
      }
      case "text":
        if (!body(e.text)) break;
        turn("agent");
        push(body(e.text));
        break;
      case "tool": {
        if (tools === "none") break;
        turn("agent");
        const result = results.get(e.toolUseId);
        list.push(toolLine(e, result, cwd));
        if (tools === "full") for (const d of toolDetails(e, result, cwd)) push(d);
        break;
      }
      case "notice":
        if (e.text.trim()) push(quote(e.text));
        break;
    }
  }
  flush();
  return `${blocks.join("\n\n")}\n`;
}
