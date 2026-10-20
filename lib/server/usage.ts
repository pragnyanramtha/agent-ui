import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentId, Entry } from "@/lib/types";
import { addCall, buildReport, MAX_DAYS, type SessionUsage, type Tok, type UsageFilters, type UsageReport } from "@/lib/usage-report";
import { HIDDEN_PROJECTS, PROJECTS_DIR, projectDirName } from "./config";
import { isSessionId, sessionMeta } from "./sessions";
import { metaTitle, safeParse as claudeParse } from "./transcript";
import { allRollouts, fileMeta, idOfRollout, threadNames } from "./agents/codex-files";
import { parseRecord as codexRecord, safeParse as codexParse, type ParseCtx } from "./agents/codex-parse";
import { adapterFor, sessionKey } from "./agents/index";
import type { AgentSession } from "./agents/types";
import { allProfiles, allSessionMeta, allSessionProfiles } from "./profiles";

/* Usage across every session, for the Usage screen. Only the agents' own session stores are read: Claude transcripts
 * and Codex rollouts are streamed line by line from where the last read stopped (both are append-only), and other
 * agents' sessions go through their adapter's history. What each session used is kept per (mtime, size), so a
 * request only reads what changed since the last one, and a time budget stops a cold start from holding the
 * request: whatever is left is read on the next ask. Sessions untouched for longer than the widest range are
 * never opened. */

type Kind = "claude" | "codex" | "adapter";

type Scan = SessionUsage & {
  kind: Kind;
  /** the file streamed, or "<agent>:<id>" for adapter sessions */
  source: string;
  native: string;
  /** the file as of the last complete read */
  mtime: number;
  size: number;
  /** bytes consumed so far (files only): the start of the first line not read yet */
  offset: number;
  done: boolean;
  title?: string;
  /** a Codex subagent: its own thread, not a session anyone opens */
  skip?: boolean;
  /** Claude writes an API message once per content block; the last copy has the final counts */
  lastMsg?: { id: string; ts: number; model: string; tok: Partial<Tok> };
  ctx?: ParseCtx;
};

type Candidate = { kind: Kind; source: string; native: string; agent: AgentId; mtime: number; size: number; session?: AgentSession };

const g = globalThis as typeof globalThis & { __agentuUsage?: Map<string, Scan>; __agentuUsageRun?: Promise<number> | null };
const cache = (g.__agentuUsage ??= new Map());

const CHUNK = 1 << 20;
const POOL = 6;
const ADAPTER_PAGES = 200;
const ADAPTER_AGENTS: AgentId[] = ["opencode", "cursor", "devin", "kimi", "gemini", "antigravity"];

const hiddenCwd = (cwd: string) => Boolean(cwd) && HIDDEN_PROJECTS.some((h) => cwd.includes(h) || projectDirName(cwd).includes(h));

/* ── sources ───────────────────────────────────────────────── */

async function claudeFiles(cutoff: number): Promise<Candidate[]> {
  const dirs = await fs.readdir(PROJECTS_DIR, { withFileTypes: true }).catch(() => []);
  const out: Candidate[] = [];
  await Promise.all(
    dirs
      .filter((d) => d.isDirectory() && !HIDDEN_PROJECTS.some((h) => d.name.includes(h)))
      .map(async (d) => {
        const dir = path.join(PROJECTS_DIR, d.name);
        const names = await fs.readdir(dir).catch(() => [] as string[]);
        await Promise.all(
          names.filter((n) => n.endsWith(".jsonl") && isSessionId(n.slice(0, -6))).map(async (n) => {
            const file = path.join(dir, n);
            const st = await fs.stat(file).catch(() => null);
            if (!st?.isFile() || st.size === 0 || st.mtimeMs < cutoff) return;
            out.push({ kind: "claude", source: file, native: n.slice(0, -6), agent: "claude", mtime: st.mtimeMs, size: st.size });
          }),
        );
      }),
  );
  return out;
}

async function codexFiles(cutoff: number): Promise<Candidate[]> {
  const files = await allRollouts().catch(() => [] as string[]);
  const out = await Promise.all(
    files.map(async (file): Promise<Candidate | null> => {
      const id = idOfRollout(file);
      const st = await fs.stat(file).catch(() => null);
      if (!id || !st?.isFile() || st.size === 0 || st.mtimeMs < cutoff) return null;
      return { kind: "codex", source: file, native: id, agent: "codex", mtime: st.mtimeMs, size: st.size };
    }),
  );
  return out.filter((c): c is Candidate => c !== null);
}

async function adapterSessions(cutoff: number): Promise<Candidate[]> {
  const lists = await Promise.all(
    ADAPTER_AGENTS.map(async (agent) => {
      const a = await adapterFor(agent).catch(() => null);
      const list = a ? await a.list().catch(() => [] as AgentSession[]) : [];
      return list.filter((s) => s.mtime >= cutoff).map((s): Candidate => ({ kind: "adapter", source: `${agent}:${s.id}`, native: s.id, agent, mtime: s.mtime, size: s.size, session: s }));
    }),
  );
  return lists.flat();
}

/* ── reading ───────────────────────────────────────────────── */

function claudeLine(s: Scan, line: string) {
  if (!s.cwd && line.includes('"cwd":"')) s.cwd = claudeParse(line)?.cwd ?? "";
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return;
  const rec = claudeParse(line);
  if (!rec || rec.type !== "assistant" || rec.isSidechain) return;
  const u = rec.message?.usage;
  const model = rec.message?.model ?? "";
  if (!u || model === "<synthetic>") return;
  const ts = Date.parse(rec.timestamp ?? "");
  const id = rec.message?.id ?? rec.uuid ?? "";
  const tok = { input: u.input_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens, output: u.output_tokens };
  if (id && s.lastMsg?.id === id) addCall(s.slots, s.lastMsg.ts, s.lastMsg.model, s.lastMsg.tok, -1);
  if (!addCall(s.slots, ts, model, tok)) return;
  s.lastMsg = { id, ts, model, tok };
  s.last = Math.max(s.last, ts);
}

function codexLine(s: Scan, line: string, off: number) {
  if (line.includes('"type":"session_meta"')) {
    const p = codexParse(line)?.payload ?? {};
    if (typeof p.cwd === "string") s.cwd = p.cwd;
    const src = p.source;
    if (p.thread_source === "subagent" || (src && typeof src === "object" && "subagent" in src)) s.skip = true;
    return;
  }
  if (!line.includes('"token_count"') && !line.includes('"turn_context"') && !line.includes('"thread_settings_applied"')) return;
  const rec = codexParse(line);
  if (!rec) return;
  for (const e of codexRecord(rec, String(off), (s.ctx ??= { model: "" }))) if (e.kind === "usage") addUsage(s, e);
}

function addUsage(s: Scan, e: Extract<Entry, { kind: "usage" }>) {
  const ts = Date.parse(e.ts);
  if (addCall(s.slots, ts, e.model, e)) s.last = Math.max(s.last, ts);
}

/** Streams complete lines from `s.offset` to `size`; false when the deadline cut it short (offset says where). */
async function readLines(s: Scan, size: number, deadline: number, onLine: (line: string, off: number) => void): Promise<boolean> {
  if (s.offset >= size) return true;
  const stream = createReadStream(s.source, { start: s.offset, end: size - 1, highWaterMark: CHUNK });
  /* a line longer than a chunk: its pieces, joined once its end arrives */
  let parts: Buffer[] = [];
  let base = s.offset;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let pos = 0;
      let nl = chunk.indexOf(0x0a);
      if (nl !== -1 && parts.length) {
        const head = Buffer.concat([...parts, chunk.subarray(0, nl)]);
        onLine(head.toString("utf8"), base);
        base += head.length + 1;
        parts = [];
        pos = nl + 1;
        nl = chunk.indexOf(0x0a, pos);
      }
      while (nl !== -1) {
        if (nl > pos) onLine(chunk.toString("utf8", pos, nl), base);
        base += nl - pos + 1;
        pos = nl + 1;
        nl = chunk.indexOf(0x0a, pos);
      }
      if (pos < chunk.length) parts.push(chunk.subarray(pos));
      s.offset = base;
      if (Date.now() >= deadline) return false;
    }
  } finally {
    stream.destroy();
  }
  return true;
}

function fresh(c: Candidate): Scan {
  return { key: sessionKey(c.agent, c.native), agent: c.agent, cwd: c.session?.cwd ?? "", profile: c.agent, slots: new Map(), last: 0, kind: c.kind, source: c.source, native: c.native, mtime: 0, size: 0, offset: 0, done: false, title: c.session?.title };
}

const upToDate = (s: Scan | undefined, c: Candidate) => Boolean(s?.done && s.mtime === c.mtime && s.size === c.size);

async function scanFile(c: Candidate, deadline: number): Promise<boolean> {
  const old = cache.get(c.source);
  /* shorter than what was read: rewritten, not appended to */
  const s = old && c.size >= old.offset ? old : fresh(c);
  cache.set(c.source, s);
  s.done = false;
  const onLine = c.kind === "claude" ? (line: string) => claudeLine(s, line) : (line: string, off: number) => codexLine(s, line, off);
  const finished = await readLines(s, c.size, deadline, onLine).catch(() => true);
  if (!finished) return false;
  Object.assign(s, { mtime: c.mtime, size: c.size, done: true });
  return true;
}

async function scanAdapter(c: Candidate): Promise<boolean> {
  const a = await adapterFor(c.agent);
  if (!a) return true;
  const s = fresh(c);
  const seen = new Set<string>();
  let before: string | null = null;
  for (let page = 0; page < ADAPTER_PAGES; page++) {
    const h = await a.history(c.native, before);
    for (const e of h.entries) {
      if (e.kind !== "usage" || seen.has(e.id)) continue;
      seen.add(e.id);
      addUsage(s, e);
    }
    if (!h.cursor || h.cursor === before) break;
    before = h.cursor;
  }
  Object.assign(s, { mtime: c.mtime, size: c.size, done: true });
  cache.set(c.source, s);
  return true;
}

/** Brings the cache up to date as far as the budget allows; resolves to how many sessions are still unread. */
async function refresh(now: number, budgetMs: number): Promise<number> {
  const deadline = Date.now() + budgetMs;
  const cutoff = now - (MAX_DAYS + 2) * 86_400_000;
  const groups = await Promise.all([claudeFiles(cutoff).catch(() => []), codexFiles(cutoff).catch(() => []), adapterSessions(cutoff).catch(() => [])]);
  const all = groups.flat();
  const present = new Set(all.map((c) => c.source));
  for (const k of cache.keys()) if (!present.has(k)) cache.delete(k);
  const todo = all.filter((c) => !upToDate(cache.get(c.source), c)).sort((a, b) => b.mtime - a.mtime);
  let next = 0;
  let left = 0;
  const worker = async () => {
    while (next < todo.length) {
      const c = todo[next++];
      if (Date.now() >= deadline) {
        left++;
        continue;
      }
      const ok = await (c.kind === "adapter" ? scanAdapter(c) : scanFile(c, deadline)).catch(() => true);
      if (!ok) left++;
    }
  };
  await Promise.all(Array.from({ length: POOL }, worker));
  return left;
}

/* ── titles for the top list ───────────────────────────────── */

const oneLine = (s: string, max = 120) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

async function titleOf(s: Scan, codexNames: () => Promise<Map<string, string>>): Promise<string> {
  if (s.title) return s.title;
  if (s.kind === "claude") {
    const st = await fs.stat(s.source).catch(() => null);
    const meta = st ? await sessionMeta(s.source, st.mtimeMs, st.size).catch(() => null) : null;
    return (meta && metaTitle(meta)) || "";
  }
  if (s.kind === "codex") {
    const name = (await codexNames()).get(s.native);
    if (name) return name;
    const m = await fileMeta(s.source).catch(() => null);
    return m?.firstPrompt ? oneLine(m.firstPrompt) : "";
  }
  return "";
}

/* ── the report ────────────────────────────────────────────── */

export type UsageQuery = { tz: string; days: number; filters?: UsageFilters; budgetMs?: number; now?: number };

export async function usageReport(q: UsageQuery): Promise<UsageReport> {
  const now = q.now ?? Date.now();
  /* one refresh at a time: two would read the same file into the same totals */
  const run = (g.__agentuUsageRun ??= refresh(now, q.budgetMs ?? 2500).finally(() => {
    g.__agentuUsageRun = null;
  }));
  const pending = await run;
  const meta = allSessionMeta();
  const profiles = allSessionProfiles();
  const labels = new Map(allProfiles().map((p) => [p.id, p.label]));
  const sessions: Scan[] = [];
  for (const s of cache.values()) {
    if (s.skip || hiddenCwd(s.cwd) || !s.slots.size) continue;
    s.profile = profiles[s.key] ?? s.agent;
    sessions.push(s);
  }
  const report = buildReport({
    sessions,
    now,
    tz: q.tz,
    days: q.days,
    filters: q.filters,
    profileLabel: (id) => labels.get(id) ?? id,
    hidden: (key) => Boolean(meta[key]?.deleted),
    partial: pending > 0,
    pending,
  });
  const byKey = new Map(sessions.map((s) => [s.key, s]));
  let names: Promise<Map<string, string>> | null = null;
  const codexNames = () => (names ??= threadNames().catch(() => new Map<string, string>()));
  await Promise.all(
    report.sessions.map(async (row) => {
      const s = byKey.get(row.key);
      const own = meta[row.key]?.title;
      row.title = own || (s ? await titleOf(s, codexNames).catch(() => "") : "") || "Untitled session";
    }),
  );
  return report;
}

/** For tests: forget everything read so far. */
export const resetUsageCache = () => cache.clear();
