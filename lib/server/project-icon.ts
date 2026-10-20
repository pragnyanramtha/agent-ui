import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FAVICON_CANDIDATES } from "@/lib/project-identity";
import { childEnv } from "./child-env";

/* A project folder's favicon and branch for the sidebar, both cached per folder so a list or a hover asks the disk
 * (or git) at most now and then. */

const ICON_TTL_MS = 10 * 60_000;
const BRANCH_TTL_MS = 30_000;
const MAX_ENTRIES = 500;
/* an icon bigger than this is a picture, not a favicon */
const MAX_ICON_BYTES = 512 * 1024;
/* how far above a folder to look for the repository it belongs to */
const MAX_UP = 4;

type Cached<T> = { at: number; value: Promise<T> };
const icons = new Map<string, Cached<string | null>>();
const branches = new Map<string, Cached<string | null>>();

function cached<T>(map: Map<string, Cached<T>>, key: string, ttl: number, load: () => Promise<T>, now = Date.now()): Promise<T> {
  const hit = map.get(key);
  if (hit && now - hit.at < ttl) return hit.value;
  const value = load();
  map.delete(key);
  map.set(key, { at: now, value });
  if (map.size > MAX_ENTRIES) map.delete(map.keys().next().value!);
  return value;
}

const isFile = (p: string) =>
  fs
    .stat(p)
    .then((s) => s.isFile() && s.size > 0 && s.size <= MAX_ICON_BYTES)
    .catch(() => false);

const exists = (p: string) =>
  fs
    .stat(p)
    .then(() => true)
    .catch(() => false);

/** The folder itself, then the repository root above it (if it's inside one and not the home folder). */
async function lookIn(dir: string): Promise<string[]> {
  const out = [dir];
  const home = os.homedir();
  let cur = dir;
  for (let i = 0; i < MAX_UP; i++) {
    if (await exists(path.join(cur, ".git"))) {
      if (cur !== dir) out.push(cur);
      break;
    }
    const up = path.dirname(cur);
    if (up === cur || up === home || cur === home) break;
    cur = up;
  }
  return out;
}

/** The first favicon a folder (or its repository) has among FAVICON_CANDIDATES, as an absolute path, else null. */
export async function findProjectIcon(dir: string): Promise<string | null> {
  for (const base of await lookIn(dir)) {
    for (const rel of FAVICON_CANDIDATES) {
      const p = path.join(base, rel);
      if (await isFile(p)) return p;
    }
  }
  return null;
}

const usable = (dir: unknown): dir is string => typeof dir === "string" && dir.length > 1 && dir.length < 4096 && path.isAbsolute(dir) && !dir.includes("\0");

export function projectIcon(dir: string, now?: number): Promise<string | null> {
  if (!usable(dir)) return Promise.resolve(null);
  return cached(icons, path.normalize(dir), ICON_TTL_MS, () => findProjectIcon(path.normalize(dir)).catch(() => null), now);
}

/** The branch checked out in a folder, null when it isn't a repository or HEAD is detached. */
export function projectBranch(dir: string, now?: number): Promise<string | null> {
  if (!usable(dir)) return Promise.resolve(null);
  return cached(
    branches,
    path.normalize(dir),
    BRANCH_TTL_MS,
    () =>
      new Promise((resolve) => {
        /* symbolic-ref also names a branch with no commits yet, and fails on a detached HEAD */
        execFile("git", ["symbolic-ref", "--short", "-q", "HEAD"], { cwd: dir, timeout: 3000, env: childEnv({ GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }) }, (err, out) => {
          const b = String(out ?? "").trim();
          resolve(err || !b ? null : b);
        });
      }),
    now,
  );
}

/** For tests: forget everything cached. */
export function clearProjectCaches() {
  icons.clear();
  branches.clear();
}
