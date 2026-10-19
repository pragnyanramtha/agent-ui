import fs from "node:fs/promises";
import path from "node:path";
import type { SessionSummary, TerminalInfo } from "@/lib/types";
import { HIDDEN_PROJECTS, LIVE_SESSIONS_DIR, PROJECTS_DIR } from "./config";
import { newestFirst } from "./order";
import { emptyMeta, metaTitle, readEdges, scanMeta, type Meta } from "./transcript";

type Cached = { mtime: number; size: number; meta: Meta };

const g = globalThis as typeof globalThis & {
  __claudeUiMeta?: Map<string, Cached>;
  __claudeUiPaths?: Map<string, string>;
  __claudeUiTerminals?: { at: number; map: Map<string, TerminalInfo> };
};
const metaCache = (g.__claudeUiMeta ??= new Map());
/** more than the list ever shows, so listing stays cached; fewer than a server's whole history */
const META_CACHE_MAX = 2000;
const pathIndex = (g.__claudeUiPaths ??= new Map());

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isSessionId = (id: string) => UUID.test(id);

/** Head + tail scan, cached on (mtime, size) so listing stays cheap on multi-GB project dirs. */
export async function sessionMeta(file: string, mtime: number, size: number) {
  const hit = metaCache.get(file);
  /* re-inserted on every use, so the Map's order is least recently used first */
  metaCache.delete(file);
  if (hit && hit.mtime === mtime && hit.size === size) {
    metaCache.set(file, hit);
    return hit.meta;
  }
  const { head, tail } = await readEdges(file, size);
  const meta = scanMeta(tail, scanMeta(head, emptyMeta()));
  metaCache.set(file, { mtime, size, meta });
  for (const old of metaCache.keys()) {
    if (metaCache.size <= META_CACHE_MAX) break;
    metaCache.delete(old);
  }
  return meta;
}

/** Forgets cached metadata of transcripts under `dir` that are gone (deleted sessions, removed projects). */
function pruneMeta(dir: string, present: Set<string>) {
  for (const file of metaCache.keys()) if (file.startsWith(dir + path.sep) && !present.has(file)) metaCache.delete(file);
}

/* ── live terminal sessions ───────────────────────────────────
 * Every interactive `claude` writes ~/.claude/sessions/<pid>.json with its
 * session id and status. A live pid (with a matching start time, so a
 * recycled pid doesn't count) means the session is open in a terminal. */

/** Fields after "(comm)": [0] state, [1] ppid, [19] starttime. */
async function procStat(pid: number) {
  const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);
  if (!stat) return null;
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return { zombie: fields[0] === "Z", ppid: Number(fields[1]), start: fields[19] ?? null };
}

/** A claude process this server spawned (a web run, possibly through a wrapper script), even after its Run ended. */
async function descendsFromUs(ppid: number) {
  for (let depth = 0; depth < 5 && ppid > 1; depth++) {
    if (ppid === process.pid) return true;
    ppid = (await procStat(ppid))?.ppid ?? 0;
  }
  return false;
}

export async function multiplexer(pid: number) {
  const env = await fs.readFile(`/proc/${pid}/environ`, "utf8").catch(() => "");
  const vars = Object.fromEntries(env.split("\0").map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
  if (vars.ZELLIJ_SESSION_NAME) return `zellij ${vars.ZELLIJ_SESSION_NAME}`;
  if (vars.TMUX) return "tmux";
  if (vars.STY) return "screen";
  return null;
}

/** While a web run owns the session it isn't "open elsewhere" (our own claude processes are already filtered out). */
export async function terminalFor(id: string, ownedByWeb: boolean, maxAgeMs?: number) {
  return ownedByWeb ? null : (await liveTerminals(maxAgeMs)).get(id) ?? null;
}

export async function liveTerminals(maxAgeMs = 1500): Promise<Map<string, TerminalInfo>> {
  const cached = g.__claudeUiTerminals;
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.map;
  const map = new Map<string, TerminalInfo>();
  const files = await fs.readdir(LIVE_SESSIONS_DIR).catch(() => [] as string[]);
  await Promise.all(
    files.filter((f) => /^\d+\.json$/.test(f)).map(async (f) => {
      const raw = await fs.readFile(path.join(LIVE_SESSIONS_DIR, f), "utf8").catch(() => null);
      if (!raw) return;
      try {
        const info = JSON.parse(raw) as { pid: number; sessionId: string; procStart?: string; status?: string; name?: string; cwd?: string; entrypoint?: string };
        if (!Number.isInteger(info.pid) || info.pid <= 1 || typeof info.sessionId !== "string") return;
        const stat = await procStat(info.pid);
        if (!stat?.start || stat.zombie || (info.procStart && info.procStart !== stat.start)) return;
        if (await descendsFromUs(stat.ppid)) return;
        map.set(info.sessionId, { pid: info.pid, cwd: typeof info.cwd === "string" ? info.cwd : undefined, status: info.status ?? "unknown", name: info.name ?? null, multiplexer: await multiplexer(info.pid), ...(info.entrypoint?.startsWith("sdk") ? { headless: true } : {}) });
      } catch {
        /* a half-written status file; the next poll picks it up */
      }
    }),
  );
  g.__claudeUiTerminals = { at: Date.now(), map };
  return map;
}

/* ── listing ───────────────────────────────────────────────── */

export type ListingSeen = { total: number; oldest?: { id: string; mtime: number } };

/** The `limit` newest transcripts as rows (untitled ones skipped). `seen` gets how many transcripts there are and
 * the oldest one looked at, where a page of rows merged with other agents' has to stop. */
export async function listSessions(limit = 120, seen?: ListingSeen): Promise<Omit<SessionSummary, "web">[]> {
  const projects = await fs.readdir(PROJECTS_DIR, { withFileTypes: true }).catch(() => []);
  const files: { file: string; id: string; mtime: number; size: number }[] = [];
  await Promise.all(
    projects
      .filter((d) => d.isDirectory() && !HIDDEN_PROJECTS.some((h) => d.name.includes(h)))
      .map(async (d) => {
        const dir = path.join(PROJECTS_DIR, d.name);
        const names = await fs.readdir(dir).catch(() => [] as string[]);
        await Promise.all(
          names.filter((n) => n.endsWith(".jsonl") && isSessionId(n.slice(0, -6))).map(async (n) => {
            const file = path.join(dir, n);
            const stat = await fs.stat(file).catch(() => null);
            if (!stat || stat.size === 0) return;
            const id = n.slice(0, -6);
            pathIndex.set(id, file);
            files.push({ file, id, mtime: stat.mtimeMs, size: stat.size });
          }),
        );
      }),
  );
  files.sort(newestFirst);
  pruneMeta(PROJECTS_DIR, new Set(files.map((f) => f.file)));
  const terminals = await liveTerminals();
  const rows = await Promise.all(
    files.slice(0, limit).map(async ({ file, id, mtime, size }) => {
      const meta = await sessionMeta(file, mtime, size);
      const title = metaTitle(meta);
      if (!title) return null;
      const cwd = meta.cwd ?? "";
      return { id, agent: "claude" as const, title, cwd, project: path.basename(cwd) || cwd, mtime, size, terminal: terminals.get(id) ?? null };
    }),
  );
  if (seen) Object.assign(seen, { total: files.length, oldest: files[Math.min(limit, files.length) - 1] });
  return rows.filter((r): r is NonNullable<typeof r> => r !== null);
}

export async function findSessionFile(id: string): Promise<string | null> {
  if (!isSessionId(id)) return null;
  const known = pathIndex.get(id);
  if (known && (await fs.stat(known).catch(() => null))) return known;
  const projects = await fs.readdir(PROJECTS_DIR).catch(() => [] as string[]);
  for (const p of projects) {
    const file = path.join(PROJECTS_DIR, p, `${id}.jsonl`);
    if (await fs.stat(file).catch(() => null)) {
      pathIndex.set(id, file);
      return file;
    }
  }
  return null;
}
