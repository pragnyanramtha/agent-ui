import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Entry, PermissionMode, ToolResult } from "@/lib/types";
import { AGENT_LABEL } from "@/lib/types";
import { adapterFor, parseSessionKey, sessionKey } from "./agents";
import { projectDirFor } from "./config";
import { sessionContext } from "./http";
import { setSessionProfile, withProfile, type ResolvedProfile } from "./profiles";
import { startRun } from "./runner";
import { metaTitle, parseLines, readLines } from "./transcript";
import { handoffPrompt, leftOut, recentTurns, type Source } from "./handoff-shape";

export type { Source };

/* Moving a conversation from one agent to another, so a session can carry on under a
 * different agent, account, or model:
 *  - into Claude: a real Claude Code transcript is written and resumed (native history)
 *  - into Codex: a new thread gets the earlier turns injected as model-visible history
 *    (app-server `thread/inject_items`, what Codex's own session importer builds on)
 *  - into anything else: a new session starts with the earlier conversation in its first prompt
 * The source session is left as it was. */

const MAX_ENTRIES = 4000;
const TAIL_BYTES = 24 * 1024 * 1024;

/** The whole conversation of a session, oldest first (capped). */
export async function loadSource(raw: string): Promise<Source | null> {
  const key = parseSessionKey(raw);
  if (!key) return null;
  let entries: Entry[] = [];
  let title = "";
  let cwd = "";
  let file: string | undefined;
  if (key.agent === "claude") {
    const ctx = await sessionContext(key.native);
    if (!ctx) return null;
    /* only the newest entries are carried over; a session of hundreds of MB isn't read whole */
    const { lines } = await readLines(ctx.file, Math.max(0, ctx.size - TAIL_BYTES), ctx.size);
    entries = parseLines(lines);
    title = metaTitle(ctx.meta) ?? "";
    cwd = ctx.cwd;
    file = ctx.file;
  } else {
    const a = await adapterFor(key.agent);
    const s = a ? await a.get(key.native) : null;
    if (!a || !s) return null;
    let page = await a.history(key.native, null);
    entries = page.entries;
    for (let i = 0; page.cursor && entries.length < MAX_ENTRIES && i < 200; i++) {
      page = await a.history(key.native, page.cursor);
      entries = [...page.entries, ...entries];
    }
    title = s.title;
    cwd = s.cwd;
  }
  const results: Record<string, ToolResult> = {};
  for (const e of entries) if (e.kind === "result") results[e.toolUseId] = e.result;
  return { agent: key.agent, key: sessionKey(key.agent, key.native), title, cwd, entries: entries.slice(-MAX_ENTRIES), results, file };
}

/* ── into Claude: a native transcript ───────────────────── */

export async function writeClaudeTranscript(src: Source): Promise<string> {
  const id = randomUUID();
  const dir = projectDirFor(src.cwd);
  await fs.mkdir(dir, { recursive: true });
  const base = { isSidechain: false, userType: "external", entrypoint: "sdk-ts", cwd: src.cwd, sessionId: id, version: "2.1.0" };
  const lines: string[] = [JSON.stringify({ type: "custom-title", customTitle: `${src.title || "Session"} (from ${AGENT_LABEL[src.agent]})`, sessionId: id })];
  let parent: string | null = null;
  const push = (rec: Record<string, unknown>) => {
    const uuid = randomUUID();
    lines.push(JSON.stringify({ parentUuid: parent, ...base, ...rec, uuid }));
    parent = uuid;
  };
  const recent = recentTurns(src, 4000);
  const note = recent.skipped ? ` ${leftOut(recent.skipped)}` : "";
  push({
    type: "user",
    message: { role: "user", content: `<imported-session>This session was moved here from ${AGENT_LABEL[src.agent]} (${src.key}). The earlier turns below were produced there; tool runs are summarised as text.${note}</imported-session>` },
    timestamp: src.entries[0]?.ts ?? new Date().toISOString(),
    origin: { kind: "system" },
  });
  push({ type: "assistant", message: { id: `msg_import_${randomUUID().replace(/-/g, "")}`, type: "message", role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "Understood." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }, timestamp: src.entries[0]?.ts ?? new Date().toISOString() });
  for (const t of recent.turns) {
    push({ type: "user", message: { role: "user", content: t.user.trim() || "(continued)" }, timestamp: t.ts, origin: { kind: "human" } });
    push({
      type: "assistant",
      message: { id: `msg_import_${randomUUID().replace(/-/g, "")}`, type: "message", role: "assistant", model: "<synthetic>", content: [{ type: "text", text: t.assistant.join("\n\n") || "(no reply)" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
      timestamp: t.ts,
    });
  }
  await fs.writeFile(path.join(dir, `${id}.jsonl`), `${lines.join("\n")}\n`, { mode: 0o600 });
  return id;
}

/* ── the move ────────────────────────────────────────────── */

export type HandoffOptions = { text: string; mode: PermissionMode; model?: string; profile: ResolvedProfile };

/** Starts a session under `profile` that carries on from `src`. Resolves with the new session key. */
export async function handoff(src: Source, o: HandoffOptions): Promise<string> {
  const target = o.profile.agent;
  if (!src.cwd) throw new Error("This session has no folder.");
  if (target === "claude") {
    const id = await writeClaudeTranscript(src);
    const run = startRun({ resume: id, cwd: src.cwd, model: o.model, permissionMode: o.mode, profile: o.profile });
    run.send(o.text.trim() || "Continue where the previous session left off.");
    setSessionProfile(id, o.profile.id);
    return id;
  }
  const a = await adapterFor(target);
  if (!a) throw new Error(`Unknown agent ${target}.`);
  const { id } = await withProfile(o.profile, async () => {
    if (a.importStart) return a.importStart({ cwd: src.cwd, text: o.text.trim() || "Continue where the previous session left off.", model: o.model, mode: o.mode }, src);
    return a.start({ cwd: src.cwd, text: handoffPrompt(src, o.text), model: o.model, mode: o.mode });
  });
  const key = sessionKey(target, id);
  setSessionProfile(key, o.profile.id);
  return key;
}
