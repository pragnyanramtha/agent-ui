import type { AgentId, Entry, ToolResult } from "@/lib/types";
import { AGENT_LABEL } from "@/lib/types";
import { HANDOFF_LEAD } from "@/lib/handoff-text";

/* How a conversation from one agent is shown to another (see handoff.ts). Pure: no I/O. */

export type Source = { agent: AgentId; key: string; title: string; cwd: string; entries: Entry[]; results: Record<string, ToolResult>; file?: string };

/* ── shared shaping ──────────────────────────────────────── */

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more chars]` : s);

function toolLine(e: Extract<Entry, { kind: "tool" }>, result: ToolResult | undefined, budget: number) {
  const input = e.input ?? {};
  const main = ["command", "file_path", "path", "pattern", "url", "query", "description"].map((k) => input[k]).find((v) => typeof v === "string") as string | undefined;
  const head = `[${e.name}${main ? `: ${clip(main.replace(/\s+/g, " "), 300)}` : ""}]`;
  if (!result) return head;
  const out = result.text.trim();
  return out ? `${head}${result.isError ? " (failed)" : ""}\n${clip(out, budget)}` : head;
}

type Turn = { user: string; ts: string; assistant: string[] };

/** User turns with what the agent said and did in between. */
export function turns(src: Source, toolBudget = 1500): Turn[] {
  const out: Turn[] = [];
  let cur: Turn | null = null;
  for (const e of src.entries) {
    if (e.kind === "user") {
      cur = { user: e.text, ts: e.ts, assistant: [] };
      out.push(cur);
      continue;
    }
    if (!cur) {
      cur = { user: "", ts: e.ts, assistant: [] };
      out.push(cur);
    }
    if (e.kind === "text" && e.text.trim()) cur.assistant.push(e.text.trim());
    else if (e.kind === "tool") cur.assistant.push(toolLine(e, src.results[e.toolUseId], toolBudget));
    else if (e.kind === "notice" && e.tone === "warn") cur.assistant.push(`(${e.text})`);
  }
  return out.filter((t) => t.user.trim() || t.assistant.length);
}

/** Most history carried into a native transcript or injected thread: thousands of big tool outputs would overflow the
 * new session's context before its first turn. */
export const HISTORY_MAX_CHARS = 400_000;

const turnSize = (t: Turn) => t.user.length + t.assistant.reduce((n, a) => n + a.length, 0);

/** The newest turns that fit in `maxChars`, oldest first, and how many earlier ones were left out. A newest turn too
 * big on its own keeps its latest steps. */
export function recentTurns(src: Source, toolBudget = 4000, maxChars = HISTORY_MAX_CHARS): { turns: Turn[]; skipped: number } {
  const all = turns(src, toolBudget);
  const kept: Turn[] = [];
  let size = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const t = all[i];
    if (size + turnSize(t) <= maxChars) {
      kept.unshift(t);
      size += turnSize(t);
      continue;
    }
    if (kept.length) break;
    const user = clip(t.user, maxChars / 4);
    const steps: string[] = [];
    let room = maxChars - user.length;
    for (let j = t.assistant.length - 1; j >= 0 && t.assistant[j].length <= room; j--) {
      steps.unshift(t.assistant[j]);
      room -= t.assistant[j].length;
    }
    const dropped = t.assistant.length - steps.length;
    kept.unshift({ ...t, user, assistant: dropped ? [`(${dropped} earlier steps left out)`, ...steps] : steps });
    size = maxChars;
  }
  return { turns: kept, skipped: all.length - kept.length };
}

export const leftOut = (skipped: number) => `(${skipped} earlier ${skipped === 1 ? "turn" : "turns"} left out)`;

/** A readable transcript, newest turns kept when it doesn't fit. */
export function transcriptText(src: Source, maxChars = 80_000): string {
  const blocks = turns(src).map((t) => `### User\n${t.user.trim() || "(no message)"}\n\n### ${AGENT_LABEL[src.agent]}\n${t.assistant.join("\n\n") || "(no reply)"}`);
  const kept: string[] = [];
  let size = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (size + blocks[i].length > maxChars && kept.length) break;
    kept.unshift(clip(blocks[i], maxChars));
    size += blocks[i].length;
  }
  const skipped = blocks.length - kept.length;
  return `${skipped ? `(${skipped} earlier turns left out)\n\n` : ""}${kept.join("\n\n")}`;
}

export function handoffPrompt(src: Source, text: string) {
  return [
    `${HANDOFF_LEAD}${AGENT_LABEL[src.agent]}${src.title ? ` ("${src.title}")` : ""}, working in ${src.cwd}.`,
    "Here is what happened so far. Treat it as your own earlier work: the files on disk already reflect it.",
    "",
    "<previous_session>",
    transcriptText(src),
    "</previous_session>",
    "",
    text.trim() ? `Continue from there. The user's next message:\n\n${text.trim()}` : "Continue from there: pick up where it left off.",
  ].join("\n");
}

/* ── into Codex: Responses API items for thread/inject ──── */

export function responsesItems(src: Source, maxChars = HISTORY_MAX_CHARS): unknown[] {
  const items: unknown[] = [];
  const recent = recentTurns(src, 4000, maxChars);
  if (recent.skipped) items.push({ type: "message", role: "user", content: [{ type: "input_text", text: leftOut(recent.skipped) }] });
  for (const t of recent.turns) {
    if (t.user.trim()) items.push({ type: "message", role: "user", content: [{ type: "input_text", text: t.user }] });
    if (t.assistant.length) items.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: t.assistant.join("\n\n") }] });
  }
  return items;
}

