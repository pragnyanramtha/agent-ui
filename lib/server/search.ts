import { execFile, spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type { AgentId, Entry } from "@/lib/types";
import { childEnv } from "./child-env";
import { HIDDEN_PROJECTS, PROJECTS_DIR } from "./config";
import { isSessionId, sessionMeta } from "./sessions";
import { metaTitle, parseRecord as claudeRecord, safeParse as claudeParse } from "./transcript";
import { allRollouts, fileMeta, idOfRollout, threadNames } from "./agents/codex-files";
import { parseRecord as codexRecord, safeParse as codexParse } from "./agents/codex-parse";
import { chatFiles, chatSummary, geminiEntries, geminiRoot, type GeminiMessage } from "./agents/gemini-store";
import { sessionKey } from "./agents/index";
import { allProfiles, allSessionMeta } from "./profiles";

/* Full-text search over what was said in every session (Claude transcripts, Codex rollouts,
 * Gemini chats). Files are scanned newest first for the query as it appears inside JSON
 * (ripgrep when it's on PATH, else a line stream), and only lines whose user or assistant
 * text contains it count: tool output, thinking and injected context never match. */

export type MessageHit = {
  key: string;
  agent: AgentId;
  title: string;
  cwd: string;
  role: "user" | "assistant";
  /** ~120 chars of the message around the match, whitespace collapsed */
  snippet: string;
  /** [start, end) of the match inside `snippet` */
  match: [number, number];
  ts: string;
  mtime: number;
};

export type SearchResult = { hits: MessageHit[]; /** stopped by the time budget or a cancel */ partial: boolean };

export type SearchOptions = { limit?: number; budgetMs?: number; signal?: AbortSignal; engine?: "auto" | "node" };

type Said = { role: "user" | "assistant"; text: string; ts: string };
type Source = {
  file: string;
  agent: AgentId;
  native: string;
  mtime: number;
  /** title and folder, or null when the file isn't a listed session (a Codex subagent) */
  describe: () => Promise<{ title: string; cwd: string } | null>;
  said: (line: string) => Said[];
};

const LINES_PER_FILE = 5;
const BATCH = 48;
const SNIPPET = 120;

const saidOf = (entries: Entry[]): Said[] =>
  entries.flatMap((e): Said[] => (e.kind === "user" ? [{ role: "user", text: e.text, ts: e.ts }] : e.kind === "text" ? [{ role: "assistant", text: e.text, ts: e.ts }] : []));

const oneLine = (s: string, max = 120) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/* ── sources ───────────────────────────────────────────────── */

async function claudeSources(): Promise<Source[]> {
  const projects = await fs.readdir(PROJECTS_DIR, { withFileTypes: true }).catch(() => []);
  const out: Source[] = [];
  const said = (line: string) => {
    const rec = claudeParse(line);
    return rec ? saidOf(claudeRecord(rec)) : [];
  };
  await Promise.all(
    projects
      .filter((d) => d.isDirectory() && !HIDDEN_PROJECTS.some((h) => d.name.includes(h)))
      .map(async (d) => {
        const dir = path.join(PROJECTS_DIR, d.name);
        const names = await fs.readdir(dir).catch(() => [] as string[]);
        await Promise.all(
          names.filter((n) => n.endsWith(".jsonl") && isSessionId(n.slice(0, -6))).map(async (n) => {
            const file = path.join(dir, n);
            const st = await fs.stat(file).catch(() => null);
            if (!st?.isFile() || st.size === 0) return;
            const describe = async () => {
              const meta = await sessionMeta(file, st.mtimeMs, st.size);
              return { title: metaTitle(meta) ?? "Claude session", cwd: meta.cwd ?? "" };
            };
            out.push({ file, agent: "claude", native: n.slice(0, -6), mtime: st.mtimeMs, describe, said });
          }),
        );
      }),
  );
  return out;
}

async function codexSources(): Promise<Source[]> {
  const files = await allRollouts().catch(() => [] as string[]);
  let names: Promise<Map<string, string>> | null = null;
  const said = (line: string) => {
    const rec = codexParse(line);
    return rec ? saidOf(codexRecord(rec, "0", { model: "" })) : [];
  };
  const out = await Promise.all(
    files.map(async (file): Promise<Source | null> => {
      const id = idOfRollout(file);
      const st = await fs.stat(file).catch(() => null);
      if (!id || !st?.isFile() || st.size === 0) return null;
      const describe = async () => {
        const m = await fileMeta(file).catch(() => null);
        if (!m || m.subagent) return null;
        const title = (await (names ??= threadNames().catch(() => new Map<string, string>()))).get(id) ?? (m.firstPrompt ? oneLine(m.firstPrompt) : "Codex session");
        return { title, cwd: m.cwd };
      };
      return { file, agent: "codex", native: id, mtime: st.mtimeMs, describe, said };
    }),
  );
  return out.filter((s): s is Source => s !== null);
}

function geminiRoots(): string[] {
  const out = new Set<string>([geminiRoot()]);
  for (const p of allProfiles()) if (p.agent === "gemini" && p.env.GEMINI_CLI_HOME) out.add(geminiRoot(p.env.GEMINI_CLI_HOME));
  return [...out];
}

function geminiSources(): Source[] {
  const said = (line: string) => {
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      return [];
    }
    const m = rec as Partial<GeminiMessage> | null;
    if (!m || typeof m !== "object" || typeof m.id !== "string" || typeof m.type !== "string") return [];
    return saidOf(geminiEntries({ meta: {}, messages: [m as GeminiMessage] }));
  };
  /* legacy single-object .json chats aren't line-oriented */
  return [...chatFiles(geminiRoots()).values()]
    .filter((c) => c.file.endsWith(".jsonl") && c.size > 0)
    .map((c) => ({
      file: c.file,
      agent: "gemini" as const,
      native: c.id,
      mtime: c.mtime,
      describe: async () => ({ title: chatSummary(c).title || "Gemini session", cwd: c.cwd }),
      said,
    }));
}

async function allSources(): Promise<Source[]> {
  const groups = await Promise.all([claudeSources().catch(() => []), codexSources().catch(() => []), Promise.resolve().then(geminiSources).catch(() => [])]);
  return groups.flat().sort((a, b) => b.mtime - a.mtime);
}

/* ── matching ──────────────────────────────────────────────── */

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const flat = (s: string) => s.replace(/\s+/g, " ");

/** ~`width` chars of `text` around [at, at+len), with ellipses where it was cut. */
export function snippetAround(text: string, at: number, len: number, width = SNIPPET): { snippet: string; match: [number, number] } {
  const match = flat(text.slice(at, at + len));
  const lead = Math.max(0, Math.min(40, Math.floor((width - match.length) / 2)));
  const from = Math.max(0, at - lead * 4);
  let before = flat(text.slice(from, at));
  let cutBefore = from > 0;
  if (before.length > lead) {
    before = before.slice(before.length - lead);
    cutBefore = true;
  }
  if (!cutBefore) before = before.trimStart();
  before = before.replace(/^[\uDC00-\uDFFF]/, "");
  const room = Math.max(0, width - before.length - match.length);
  const to = at + len + room * 4;
  let after = flat(text.slice(at + len, to));
  let cutAfter = to < text.length;
  if (after.length > room) {
    after = after.slice(0, room);
    cutAfter = true;
  }
  if (!cutAfter) after = after.trimEnd();
  after = after.replace(/[\uD800-\uDBFF]$/, "");
  const pre = cutBefore ? "…" : "";
  const start = pre.length + before.length;
  return { snippet: `${pre}${before}${match}${after}${cutAfter ? "…" : ""}`, match: [start, start + match.length] };
}

type Found = { said: Said; at: number; len: number };

function firstMatch(src: Source, line: string, re: RegExp): Found | null {
  for (const s of src.said(line)) {
    const m = re.exec(s.text);
    if (m) return { said: s, at: m.index, len: m[0].length };
  }
  return null;
}

/* ── engines ───────────────────────────────────────────────── */

let rgCheck: Promise<boolean> | null = null;
/** Whether `rg` runs from PATH (checked once per process). */
export const hasRipgrep = () => (rgCheck ??= new Promise((resolve) => execFile("rg", ["--version"], { timeout: 3000, env: childEnv() }, (err) => resolve(!err))));

type OnLine = (file: string, line: string) => void;

/** Up to LINES_PER_FILE raw matches per file, in line order per file. Never sees the query as a flag: -F and `--`. */
function rgBatch(needle: string, files: string[], onLine: OnLine, deadline: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let cut = false;
    const child = spawn("rg", ["--json", "--no-config", "--no-messages", "-a", "-F", "-i", "-m", String(LINES_PER_FILE), "--", needle, ...files], { stdio: ["ignore", "pipe", "ignore"], env: childEnv() });
    const stop = () => {
      cut = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(stop, Math.max(0, deadline - Date.now()));
    signal?.addEventListener("abort", stop, { once: true });
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (raw) => {
      if (!raw.startsWith('{"type":"match"')) return;
      try {
        const d = (JSON.parse(raw) as { data: { path?: { text?: string }; lines?: { text?: string; bytes?: string } } }).data;
        const file = d.path?.text;
        const text = d.lines?.text ?? (d.lines?.bytes ? Buffer.from(d.lines.bytes, "base64").toString("utf8") : undefined);
        if (file && text !== undefined) onLine(file, text.replace(/\r?\n$/, ""));
      } catch {
        /* not ours to worry about */
      }
    });
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      rl.close();
      resolve(cut);
    };
    child.on("close", done);
    child.on("error", done);
  });
}

/** The same scan in Node: lines containing the needle (case-insensitive), stopping once `onLine` says the file is done. */
async function nodeFile(file: string, needle: string, onLine: (line: string) => boolean, deadline: number, signal?: AbortSignal): Promise<boolean> {
  const stream = createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let seen = 0;
  try {
    for await (const line of rl) {
      if (signal?.aborted || Date.now() >= deadline) return true;
      if (!line.toLowerCase().includes(needle)) continue;
      if (onLine(line) || ++seen >= LINES_PER_FILE) break;
    }
  } catch {
    /* vanished or unreadable */
  } finally {
    rl.close();
    stream.destroy();
  }
  return false;
}

/* ── search ────────────────────────────────────────────────── */

/** Sessions whose messages contain `q` (case-insensitive, literal), newest first, one hit per session. */
export async function searchMessages(q: string, opts: SearchOptions = {}): Promise<SearchResult> {
  const limit = opts.limit ?? 30;
  const deadline = Date.now() + (opts.budgetMs ?? 2500);
  const { signal } = opts;
  const query = q.trim();
  if (query.length < 2 || limit <= 0) return { hits: [], partial: false };
  const useRg = opts.engine !== "node" && (await hasRipgrep());
  const meta = allSessionMeta();
  /* a deleted session's transcript can stay on disk; it must not come back through search */
  const sources = (await allSources()).filter((src) => !meta[sessionKey(src.agent, src.native)]?.deleted);
  const re = new RegExp(escapeRe(query), "iu");
  /* the query as it's written inside a JSON string (quotes and backslashes escaped) */
  const needle = JSON.stringify(query).slice(1, -1);
  const lowerNeedle = needle.toLowerCase();
  const hits: MessageHit[] = [];
  let partial = false;

  for (let i = 0; i < sources.length && hits.length < limit; i += BATCH) {
    if (signal?.aborted || Date.now() >= deadline) {
      partial = true;
      break;
    }
    const batch = sources.slice(i, i + BATCH);
    const found = new Map<Source, Found>();
    if (useRg) {
      const byFile = new Map(batch.map((s) => [s.file, s]));
      partial = await rgBatch(
        needle,
        batch.map((s) => s.file),
        (file, line) => {
          const src = byFile.get(file);
          if (!src || found.has(src)) return;
          const f = firstMatch(src, line, re);
          if (f) found.set(src, f);
        },
        deadline,
        signal,
      );
    } else {
      for (const src of batch) {
        partial = await nodeFile(
          src.file,
          lowerNeedle,
          (line) => {
            const f = firstMatch(src, line, re);
            if (f) found.set(src, f);
            return Boolean(f);
          },
          deadline,
          signal,
        );
        if (partial) break;
      }
    }
    for (const src of batch) {
      if (hits.length >= limit) break;
      const f = found.get(src);
      if (!f) continue;
      const about = await src.describe().catch(() => null);
      if (!about) continue;
      const { snippet, match } = snippetAround(f.said.text, f.at, f.len);
      hits.push({ key: sessionKey(src.agent, src.native), agent: src.agent, title: about.title, cwd: about.cwd, role: f.said.role, snippet, match, ts: f.said.ts, mtime: src.mtime });
    }
    if (partial) break;
  }
  return { hits, partial };
}
