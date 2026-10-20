import type { Entry, ToolResult } from "@/lib/types";
import { summarizeTool, type ToolIcon } from "./tools";
import { writesFiles } from "./file-edits";

export type RunItem = Extract<Entry, { kind: "tool" | "thinking" }>;
type UserEntry = Extract<Entry, { kind: "user" }>;
type TextEntry = Extract<Entry, { kind: "text" }>;
type NoticeEntry = Extract<Entry, { kind: "notice" }>;
type ToolEntry = Extract<Entry, { kind: "tool" }>;

export type Block =
  | { type: "user"; key: string; entry: UserEntry }
  /** `final`: the answer that closes a finished turn (it carries the message actions) */
  | { type: "text"; key: string; entry: TextEntry; final?: boolean }
  | { type: "notice"; key: string; entry: NoticeEntry }
  | { type: "run"; key: string; items: RunItem[] }
  /** a finished turn's work: runs and in-between prose, collapsed behind one row */
  | { type: "fold"; key: string; blocks: Block[]; tools: number; ms: number | null; /** the turn's tool calls that wrote files */ edits: ToolEntry[] }
  /** the files a finished turn edited; `turn` indexes splitTurns(entries) */
  | { type: "changes"; key: string; tools: ToolEntry[]; turn: number };

export type Turn = { user: UserEntry | null; entries: Entry[] };

/** Entries cut at each prompt. History loaded from the middle starts with a turn that has no prompt. */
export function splitTurns(entries: Entry[]): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  for (const e of entries) {
    if (e.kind === "user") {
      cur = { user: e, entries: [] };
      turns.push(cur);
    } else {
      if (!cur) {
        cur = { user: null, entries: [] };
        turns.push(cur);
      }
      cur.entries.push(e);
    }
  }
  return turns;
}

/* questions and plans wait on the reader, so a fold never hides them */
const PINNED_TOOLS = new Set(["ExitPlanMode", "AskUserQuestion"]);

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** the tool calls in a turn that wrote files (what the Changes panel counts) */
export const editsIn = (entries: Entry[]) => entries.filter(writesFiles);

function plainBlocks(entries: Entry[], pin: boolean, thinking: boolean): Block[] {
  const blocks: Block[] = [];
  let joinable = false;
  for (const e of entries) {
    /* models that keep reasoning private still log an empty thinking block; it carries nothing to show */
    if (e.kind === "thinking" && (!thinking || !String(e.text ?? "").trim())) continue;
    if (e.kind === "tool" || e.kind === "thinking") {
      if (pin && e.kind === "tool" && PINNED_TOOLS.has(e.name)) {
        blocks.push({ type: "run", key: e.id, items: [e] });
        joinable = false;
        continue;
      }
      const last = blocks[blocks.length - 1];
      if (joinable && last?.type === "run") last.items.push(e);
      else blocks.push({ type: "run", key: e.id, items: [e] });
      joinable = true;
    } else if (e.kind === "text" || e.kind === "notice") {
      blocks.push({ type: e.kind, key: e.id, entry: e } as Block);
      joinable = false;
    }
  }
  return blocks;
}

const isPinned = (b: Block) => b.type === "notice" || (b.type === "run" && b.items.length === 1 && b.items[0].kind === "tool" && PINNED_TOOLS.has(b.items[0].name));

function duration(turn: Turn): number | null {
  const start = Date.parse(turn.user?.ts ?? turn.entries[0]?.ts ?? "");
  let end = NaN;
  for (let i = turn.entries.length - 1; i >= 0; i--) {
    const e = turn.entries[i];
    if (e.kind === "result" || !e.ts) continue;
    end = Date.parse(e.ts);
    break;
  }
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

const toolCount = (blocks: Block[]) => blocks.reduce((n, b) => n + (b.type === "run" ? b.items.filter((i) => i.kind === "tool").length : 0), 0);

/**
 * What the thread renders. A finished turn becomes: its prompt, one fold holding the work
 * (tool runs and the prose between them), anything that needs the reader (notices, plans,
 * questions), the closing answer, and a changed-files card when it wrote files.
 * The live turn (`live`: the agent is still on the last one) keeps every block, so it streams as it happens.
 * `thinking: false` leaves reasoning out (Settings > Conversation > Show thinking).
 */
export function toBlocks(entries: Entry[], live = false, opts: { thinking?: boolean } = {}): Block[] {
  const out: Block[] = [];
  const turns = splitTurns(entries);
  turns.forEach((turn, t) => {
    if (turn.user) out.push({ type: "user", key: turn.user.id, entry: turn.user });
    const open = live && t === turns.length - 1;
    const flat = plainBlocks(turn.entries, !open, opts.thinking !== false);
    if (open) {
      out.push(...flat);
      return;
    }
    /* the answer: the last prose, plus prose right before it (notices and plans in between don't break it) */
    let end = -1;
    for (let i = flat.length - 1; i >= 0; i--)
      if (flat[i].type === "text") {
        end = i;
        break;
      }
    let start = end;
    for (let i = end - 1; i >= 0 && (flat[i].type === "text" || isPinned(flat[i])); i--) if (flat[i].type === "text") start = i;
    const answer = (i: number) => end >= 0 && i >= start && i <= end && flat[i].type === "text";
    const folded = flat.filter((b, i) => !isPinned(b) && !answer(i));
    const edits = editsIn(turn.entries);
    if (folded.length) out.push({ type: "fold", key: `fold:${folded[0].key}`, blocks: folded, tools: toolCount(folded), ms: duration(turn), edits });
    flat.forEach((b, i) => {
      if (isPinned(b)) out.push(b);
      else if (answer(i)) out.push(i === end ? { ...(b as Extract<Block, { type: "text" }>), final: true } : b);
    });
    if (edits.length) out.push({ type: "changes", key: `changes:${turn.user?.id ?? turn.entries[0]?.id}`, tools: edits, turn: t });
  });
  return out;
}

/** "45s", "2m 14s", "1h 3m" */
export function workedFor(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** The fold's row: "Worked for 2m 14s", the tool count beside it. */
export function foldLabel(ms: number | null, tools: number): { title: string; detail: string } {
  return {
    title: ms !== null && ms >= 1000 ? `Worked for ${workedFor(ms)}` : "Worked",
    detail: tools ? `${tools} tool ${tools === 1 ? "call" : "calls"}` : "",
  };
}

type Kind = "read" | "edit" | "search" | "run" | "web" | "agent" | "ask" | "plan" | "tool";
const ORDER: Kind[] = ["read", "edit", "search", "run", "web", "agent", "ask", "plan", "tool"];
const KIND: Record<ToolIcon, Kind> = { read: "read", edit: "edit", search: "search", run: "run", terminal: "run", web: "web", agent: "agent", ask: "ask", plan: "plan", tool: "tool" };

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

function phrase(kind: Kind, n: number, sameNoun: boolean): string {
  switch (kind) {
    case "read":
      return `read ${n} ${plural(n, "file")}`;
    case "edit":
      return sameNoun ? `edited ${n}` : `edited ${n} ${plural(n, "file")}`;
    case "search":
      return n === 1 ? "searched once" : `searched ${n} times`;
    case "run":
      return `ran ${n} ${plural(n, "command")}`;
    case "web":
      return `browsed ${n} ${plural(n, "page")}`;
    case "agent":
      return `started ${n} ${plural(n, "agent")}`;
    case "ask":
      return `asked ${n} ${plural(n, "question")}`;
    case "plan":
      return "updated the plan";
    case "tool":
      return `used ${n} ${plural(n, "tool")}`;
  }
}

/** A run's header: what it did as a whole, "Read 4 files, edited 2, ran 3 commands". */
export function runSummary(items: RunItem[]): string {
  const files: Partial<Record<Kind, Set<string>>> = {};
  for (const it of items) {
    if (it.kind !== "tool") continue;
    const input = it.input ?? {};
    const kind = KIND[summarizeTool(it.name, input).icon];
    const path = kind === "read" || kind === "edit" ? str(input.file_path) || str(input.notebook_path) || str(input.path) : "";
    (files[kind] ??= new Set()).add(path || it.id);
  }
  const kinds = ORDER.filter((k) => files[k]?.size);
  if (!kinds.length) return "Thought";
  const parts = kinds.map((k, i) => phrase(k, files[k]!.size, k === "edit" && kinds[i - 1] === "read"));
  const text = parts.join(", ");
  return text[0].toUpperCase() + text.slice(1);
}

/** how many of the run's tool calls came back as errors */
export const failedCount = (items: RunItem[], results: Record<string, ToolResult>) => items.filter((i) => i.kind === "tool" && results[i.toolUseId]?.isError).length;

/* ── undo: which checkpoint holds the files as they were before a turn ── */

export type CheckpointRef = { id: string; at: number; label: string };
export type TurnRef = { text: string; ts: string; edits: boolean };

/* a checkpoint is saved just before the message goes out, a few seconds at most before the prompt is logged */
const SLACK_MS = 30_000;
const norm = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 120);

/**
 * The checkpoint to rewind to so a turn's file changes go away, or null when that isn't known for sure.
 * Checkpoints are saved before each message sent from the web, labelled with it, and skipped when nothing
 * changed since the last one, so an earlier prompt's checkpoint counts as long as no turn since edited files.
 * Anything newer (a manual checkpoint, a rewind) means the files moved on in ways a transcript can't tell.
 */
export function undoCheckpoint(checkpoints: CheckpointRef[], turns: TurnRef[], target: number): string | null {
  const t = Date.parse(turns[target]?.ts ?? "");
  if (!Number.isFinite(t)) return null;
  const next = turns[target + 1];
  let cand: CheckpointRef | null = null;
  for (const c of checkpoints) {
    if (c.at > t + SLACK_MS) continue;
    if (next && c.at > t && c.label === norm(next.text)) continue;
    if (!cand || c.at > cand.at) cand = c;
  }
  if (!cand) return null;
  for (let j = target; j >= 0; j--) {
    if (j < target && turns[j].edits) break;
    const tj = Date.parse(turns[j].ts);
    const prev = j > 0 ? Date.parse(turns[j - 1].ts) : -Infinity;
    if (cand.label === norm(turns[j].text) && cand.at <= tj + SLACK_MS && !(cand.at <= prev)) return cand.id;
  }
  return null;
}
