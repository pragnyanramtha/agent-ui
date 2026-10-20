import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { childEnv } from "./child-env";
import { fuzzyCost } from "@/lib/file-match";

/* Files under a session's folder for the composer's @ picker: what git tracks plus untracked files it
 * doesn't ignore, or a bounded walk outside a repo. Lists are cached per folder for a few seconds, so
 * typing a query doesn't rescan on every key. Paths are relative to the folder, with "/" separators. */

export const MAX_FILES = 20_000;
const SCAN_MS = 2_000;
const TTL_MS = 10_000;
const SKIP = new Set(["node_modules", ".git"]);

export type FileList = { files: string[]; truncated: boolean };

const g = globalThis as { __agentuFileLists?: Map<string, { at: number; list: Promise<FileList> }> };
const cache = (g.__agentuFileLists ??= new Map());

function gitFiles(root: string): Promise<FileList | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-c", "core.quotepath=off", "ls-files", "-co", "--exclude-standard", "-z"],
      { cwd: root, timeout: SCAN_MS, maxBuffer: 64 * 1024 * 1024, env: childEnv({ GIT_OPTIONAL_LOCKS: "0" }) },
      (err, stdout) => {
        if (err) return resolve(null);
        /* deleted-but-tracked files are still listed; a picker can't tell, which is fine */
        const all = [...new Set(stdout.split("\0").filter(Boolean))];
        resolve({ files: all.slice(0, MAX_FILES), truncated: all.length > MAX_FILES });
      },
    );
  });
}

/** Breadth first, so a cut-off keeps the shallow files; skips node_modules, .git and dot folders. */
export async function walkFiles(root: string, o: { max?: number; ms?: number } = {}): Promise<FileList> {
  const max = o.max ?? MAX_FILES;
  const deadline = Date.now() + (o.ms ?? SCAN_MS);
  const files: string[] = [];
  let queue = [""];
  while (queue.length) {
    const next: string[] = [];
    for (const rel of queue) {
      if (files.length >= max || Date.now() > deadline) return { files: files.slice(0, max), truncated: true };
      const dirents = await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
      dirents.sort((a, b) => a.name.localeCompare(b.name));
      for (const d of dirents) {
        const p = rel ? `${rel}/${d.name}` : d.name;
        if (d.isDirectory()) {
          if (!SKIP.has(d.name) && !d.name.startsWith(".")) next.push(p);
        } else if (d.isFile() || d.isSymbolicLink()) files.push(p);
      }
    }
    queue = next;
  }
  return { files: files.slice(0, max), truncated: files.length > max };
}

/** The folder's files, from the cache when it's fresh. `root` must already be a real, absolute folder. */
export function listFiles(root: string): Promise<FileList> {
  const hit = cache.get(root);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.list;
  const list = gitFiles(root).then((r) => r ?? walkFiles(root));
  cache.set(root, { at: Date.now(), list });
  if (cache.size > 50) cache.delete(cache.keys().next().value!);
  list.catch(() => cache.delete(root));
  return list;
}

export const clearFileCache = () => cache.clear();

/** each query character in order, anywhere after the previous one */
function subsequence(hay: string, q: string) {
  let i = 0;
  for (const c of hay) if (c === q[i] && ++i === q.length) return true;
  return q.length === 0;
}

/**
 * Best matches first: the file name (with or without its extension) equal to, starting with, then containing the query; then the path
 * containing it; then the query's characters in order along the path, tightest first. Ties go to shorter paths.
 * An empty query lists the shallowest files.
 */
export function rankFiles(files: string[], query: string, limit = 50): string[] {
  const q = query.trim().toLowerCase().replace(/^\.\//, "");
  const scored: { f: string; s: number; cost: number }[] = [];
  for (const f of files) {
    const p = f.toLowerCase();
    if (!q) {
      scored.push({ f, s: 0, cost: 0 });
      continue;
    }
    const base = p.slice(p.lastIndexOf("/") + 1);
    const s = base === q || base.replace(/\.[^.]*$/, "") === q ? 0 : base.startsWith(q) ? 1 : base.includes(q) ? 2 : p.includes(q) ? 3 : subsequence(p, q) ? 4 : -1;
    if (s >= 0) scored.push({ f, s, cost: s === 4 ? fuzzyCost(f, q) : 0 });
  }
  const depth = (f: string) => f.split("/").length;
  scored.sort((a, b) => a.s - b.s || a.cost - b.cost || (q ? 0 : depth(a.f) - depth(b.f)) || a.f.length - b.f.length || a.f.localeCompare(b.f));
  return scored.slice(0, limit).map((x) => x.f);
}
