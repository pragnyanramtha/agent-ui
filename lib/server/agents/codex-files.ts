import { watch, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Entry } from "@/lib/types";
import { parseLines, safeParse, userTitle, type ParseCtx } from "./codex-parse";

/* Where Codex keeps sessions and how to read them cheaply: rollout files are
 * append-only JSONL, so history pages back by byte offset and the live view
 * tails forward from the last complete line. */

export const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
export const rolloutRoots = () => [path.join(codexHome(), "sessions"), path.join(codexHome(), "archived_sessions")];

const ROLLOUT = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
export const idOfRollout = (file: string) => ROLLOUT.exec(path.basename(file))?.[1] ?? null;

type Cache = {
  files: Map<string, string>;
  meta: Map<string, FileMeta>;
};
const cache = (): Cache => {
  const g = globalThis as typeof globalThis & { __codexCache?: Cache };
  return (g.__codexCache ??= { files: new Map(), meta: new Map() });
};

async function readdirSafe(dir: string) {
  return fs.readdir(dir, { withFileTypes: true }).catch(() => []);
}

/** Every rollout file, newest directory first (sessions/YYYY/MM/DD, archived_sessions flat). */
export async function allRollouts(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number) => {
    const items = (await readdirSafe(dir)).sort((a, b) => (a.name < b.name ? 1 : -1));
    for (const it of items) {
      const p = path.join(dir, it.name);
      if (it.isDirectory() && depth < 3) await walk(p, depth + 1);
      else if (it.isFile() && ROLLOUT.test(it.name)) out.push(p);
    }
  };
  for (const root of rolloutRoots()) await walk(root, 0);
  const files = cache().files;
  for (const f of out) files.set(idOfRollout(f)!, f);
  return out;
}

export async function findRollout(id: string): Promise<string | null> {
  const known = cache().files.get(id);
  if (known && (await fs.stat(known).catch(() => null))) return known;
  await allRollouts();
  return cache().files.get(id) ?? null;
}

export type Line = { off: number; line: string };

/**
 * Complete lines inside [start, end) with their byte offsets. A start mid-line
 * skips to the next line; a trailing partial line (still being written) is left
 * out. `begin` is where the first returned line starts, `end` just past the last.
 */
export async function readRecords(file: string, start: number, end: number): Promise<{ lines: Line[]; begin: number; end: number }> {
  start = Math.max(0, Math.floor(start));
  end = Math.floor(end);
  if (end <= start) return { lines: [], begin: start, end: start };
  const handle = await fs.open(file, "r");
  try {
    const from = Math.max(0, start - 1);
    const buf = Buffer.alloc(end - from);
    const { bytesRead } = await handle.read(buf, 0, buf.length, from);
    const data = buf.subarray(0, bytesRead);
    const last = data.lastIndexOf(0x0a);
    const first = start === 0 ? 0 : data.indexOf(0x0a) + 1;
    if (last === -1 || first > last + 1 || (start !== 0 && first === 0)) return { lines: [], begin: start, end: start };
    const lines: Line[] = [];
    let pos = first;
    while (pos <= last) {
      const nl = data.indexOf(0x0a, pos);
      if (nl > pos) lines.push({ off: from + pos, line: data.subarray(pos, nl).toString("utf8") });
      pos = nl + 1;
    }
    return { lines, begin: from + first, end: from + last + 1 };
  } finally {
    await handle.close();
  }
}

/* ---------- metadata for the list ---------- */

export type FileMeta = {
  id: string;
  file: string;
  cwd: string;
  firstPrompt: string | null;
  subagent: boolean;
  /** last model seen (turn_context / thread settings) */
  model: string | null;
  mtime: number;
  size: number;
  /** head facts never change once found; only the tail is re-read on growth */
  headDone: boolean;
};

const HEAD_STEPS = [64_000, 256_000, 1_000_000];
const TAIL_BYTES = 96_000;

function modelOf(line: string): string | null {
  if (!line.includes('"type":"turn_context"') && !line.includes('"thread_settings_applied"')) return null;
  const rec = safeParse(line);
  const p = rec?.payload ?? {};
  const m = rec?.type === "turn_context" ? p.model : (p.thread_settings as { model?: unknown } | undefined)?.model;
  return typeof m === "string" && m ? m : null;
}

async function scanHead(file: string, size: number, meta: FileMeta) {
  for (const step of HEAD_STEPS) {
    const { lines } = await readRecords(file, 0, Math.min(size, step));
    for (const { line } of lines) {
      if (line.includes('"type":"session_meta"')) {
        const p = safeParse(line)?.payload ?? {};
        if (typeof p.cwd === "string") meta.cwd = p.cwd;
        const src = p.source;
        meta.subagent = p.thread_source === "subagent" || Boolean(src && typeof src === "object" && "subagent" in src);
      } else if (!meta.firstPrompt && line.includes('"role":"user"')) {
        const rec = safeParse(line);
        meta.firstPrompt = rec ? userTitle(rec) : null;
      } else if (!meta.model) meta.model = modelOf(line);
      if (meta.firstPrompt) break;
    }
    if (meta.firstPrompt || step >= size) {
      meta.headDone = true;
      return;
    }
  }
  /* a session with no prompt within the first megabyte: keep what we have */
  meta.headDone = true;
}

async function scanTail(file: string, size: number, meta: FileMeta) {
  const { lines } = await readRecords(file, Math.max(0, size - TAIL_BYTES), size);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = modelOf(lines[i].line);
    if (m) {
      meta.model = m;
      return;
    }
  }
}

export async function fileMeta(file: string): Promise<FileMeta | null> {
  const stat = await fs.stat(file).catch(() => null);
  const id = idOfRollout(file);
  if (!stat || !id) return null;
  const c = cache().meta;
  const prev = c.get(file);
  if (prev && prev.size === stat.size && prev.mtime === stat.mtimeMs) return prev;
  const meta: FileMeta = prev ?? { id, file, cwd: "", firstPrompt: null, subagent: false, model: null, mtime: 0, size: 0, headDone: false };
  if (!meta.headDone || !meta.firstPrompt) await scanHead(file, stat.size, meta);
  await scanTail(file, stat.size, meta);
  meta.mtime = stat.mtimeMs;
  meta.size = stat.size;
  c.set(file, meta);
  return meta;
}

/** thread names Codex stores (session_index.jsonl, later lines win) */
export async function threadNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const text = await fs.readFile(path.join(codexHome(), "session_index.jsonl"), "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    const rec = line ? (safeParse(line) as { id?: unknown; thread_name?: unknown } | null) : null;
    if (rec && typeof rec.id === "string" && typeof rec.thread_name === "string" && rec.thread_name.trim()) names.set(rec.id, rec.thread_name.trim());
  }
  return names;
}

/* ---------- live tail ---------- */

type Listener = (entries: Entry[], end: number) => void;

/** most bytes one live-tail step reads, so a big backlog doesn't land in memory at once */
const LIVE_STEP = 8 * 1024 * 1024;

/** Follows one rollout from `from`; waits for the file if the session was just started. */
export function tailRollout(locate: () => Promise<string | null>, from: number, ctx: ParseCtx, fn: Listener) {
  let offset = from;
  let file: string | null = null;
  let watcher: FSWatcher | null = null;
  let reading = false;
  let dirty = false;
  let closed = false;

  const attach = () => {
    if (!file || watcher) return;
    try {
      const w = watch(file, () => void read());
      w.on("error", () => {
        w.close();
        if (watcher === w) watcher = null;
      });
      watcher = w;
    } catch {
      watcher = null;
    }
  };

  const read = async () => {
    if (closed) return;
    if (reading) {
      dirty = true;
      return;
    }
    reading = true;
    try {
      do {
        dirty = false;
        if (!file) file = await locate();
        if (!file) break;
        attach();
        const stat = await fs.stat(file).catch(() => null);
        if (closed) break;
        if (!stat) {
          /* moved (archived_sessions) or deleted: find it again next time */
          file = null;
          watcher?.close();
          watcher = null;
          break;
        }
        if (stat.size < offset) offset = 0;
        if (stat.size === offset) continue;
        const stop = Math.min(stat.size, offset + LIVE_STEP);
        let { lines, end } = await readRecords(file, offset, stop);
        /* one record longer than a step */
        if (end <= offset && stop < stat.size) ({ lines, end } = await readRecords(file, offset, stat.size));
        if (end <= offset) continue;
        offset = end;
        if (stop < stat.size) dirty = true;
        const entries = parseLines(lines, ctx);
        if (!closed) fn(entries, end);
      } while (dirty && !closed);
    } catch {
      /* vanished mid-read; the poll retries */
    } finally {
      reading = false;
    }
  };

  const poll = setInterval(() => {
    attach();
    void read();
  }, 1500);
  void read();
  return () => {
    closed = true;
    clearInterval(poll);
    watcher?.close();
    watcher = null;
  };
}
