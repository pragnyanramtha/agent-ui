import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { parseUnifiedPatch, type PatchFile, type PatchStatus } from "@/lib/client/diff";

/* Git for a session's folder: checkpoints of the working tree before each turn (hidden refs, made through a
 * throwaway index so HEAD, the branch and the staging area are never touched), rewinding to one, the branch's
 * status, commit, push, pull requests, and a worktree per session. */

export class GitError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/* checkpoint commits need an author even where git has no user configured */
const BOT = { GIT_AUTHOR_NAME: "agent-u", GIT_AUTHOR_EMAIL: "agent-u@localhost", GIT_COMMITTER_NAME: "agent-u", GIT_COMMITTER_EMAIL: "agent-u@localhost" };

function git(cwd: string, args: string[], opts: { env?: Record<string, string>; timeout?: number; bin?: string; input?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      opts.bin ?? "git",
      args,
      { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", ...opts.env }, timeout: opts.timeout ?? 20_000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const msg = (stderr.trim() ? stderr : stdout.trim() ? stdout : err.message).trim().split("\n").filter(Boolean).slice(-3).join(" ");
        reject(new GitError(msg || `${opts.bin ?? "git"} ${args[0]} failed`));
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

export async function repoRoot(cwd: string): Promise<string | null> {
  if (!path.isAbsolute(cwd)) return null;
  return git(cwd, ["rev-parse", "--show-toplevel"], { timeout: 5000 })
    .then((s) => s.trim() || null)
    .catch(() => null);
}

async function needRoot(cwd: string) {
  const root = await repoRoot(cwd);
  if (!root) throw new GitError(`${cwd} isn't a git repository.`, 404);
  return root;
}

/* ── checkpoints ─────────────────────────────────────── */

const MAX_CHECKPOINTS = 60;
export const refBase = (session: string) => `refs/agent-u/cp/${crypto.createHash("sha1").update(session).digest("hex").slice(0, 16)}`;

/** untracked files left out of a checkpoint because they're too large (at most SKIPPED_PATHS of them named) */
export type Skipped = { count: number; bytes: number; paths: string[] };
export type Checkpoint = { id: string; commit: string; tree: string; at: number; label: string; skipped?: Skipped };

const MB = 1024 * 1024;
const MAX_UNTRACKED = 20_000;
const SKIPPED_PATHS = 100;
const SKIPPED_TRAILER = "Agent-U-Skipped: ";
const PRUNE_EVERY_MS = 60 * 60 * 1000;
const envNumber = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const limits = () => ({
  file: envNumber("CHECKPOINT_MAX_FILE_MB", 20) * MB,
  total: envNumber("CHECKPOINT_MAX_TOTAL_MB", 200) * MB,
  days: envNumber("CHECKPOINT_MAX_AGE_DAYS", 30),
});

/** The folder had too much new, unignored data to snapshot without bloating the repository. */
export class CheckpointSkipped extends GitError {
  constructor(readonly reason: string) {
    super(`Checkpoint skipped: ${reason}. Add them to .gitignore to keep saving checkpoints.`, 413);
  }
}

const fmtMB = (bytes: number) => `${Math.max(1, Math.round(bytes / MB)).toLocaleString("en-US")} MB`;

/** untracked, unignored files, stopping once there are more than `limit` */
function untrackedFiles(root: string, env: Record<string, string>, limit = Infinity): Promise<{ paths: string[]; more: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["ls-files", "-o", "--exclude-standard", "-z"], { cwd: root, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    const decoder = new StringDecoder("utf8");
    const paths: string[] = [];
    let rest = "";
    let more = false;
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stdout.on("data", (b: Buffer) => {
      if (more) return;
      const parts = (rest + decoder.write(b)).split("\0");
      rest = parts.pop() ?? "";
      /* a nested repository shows as "dir/" and goes in as a link, not as files */
      for (const p of parts) if (p && !p.endsWith("/")) paths.push(p);
      if (paths.length > limit) {
        more = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (b: Buffer) => void (stderr.length < 4000 && (stderr += b.toString())));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new GitError(err.message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || more) resolve({ paths, more });
      else reject(new GitError(stderr.trim().split("\n").slice(-3).join(" ") || "git ls-files failed"));
    });
  });
}

type Snapshot = { tree: string; excluded: string[]; excludedBytes: number };

/** The working tree as git would commit it right now (ignored files left out), through a copy of the index.
 * Untracked files over CHECKPOINT_MAX_FILE_MB stay out too. With `strict` (a checkpoint, kept by a ref), too many
 * new files or too many bytes of them throw CheckpointSkipped instead of being copied into the object store. */
async function snapshotTree(root: string, opts: { strict?: boolean } = {}): Promise<Snapshot> {
  const gitDir = (await git(root, ["rev-parse", "--absolute-git-dir"])).trim();
  const id = `${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const tmp = path.join(os.tmpdir(), `agent-u-index-${id}`);
  const specs = path.join(os.tmpdir(), `agent-u-pathspec-${id}`);
  /* starting from the real index lets git reuse its stat cache, so a big repo snapshots fast */
  await fs.copyFile(path.join(gitDir, "index"), tmp).catch(() => undefined);
  try {
    const env = { GIT_INDEX_FILE: tmp };
    const max = limits();
    const { paths, more } = await untrackedFiles(root, env, opts.strict ? MAX_UNTRACKED : Infinity);
    if (more) throw new CheckpointSkipped(`more than ${MAX_UNTRACKED.toLocaleString("en-US")} new files that git doesn't ignore`);
    const excluded: string[] = [];
    let excludedBytes = 0;
    let total = 0;
    for (let i = 0; i < paths.length; i += 256) {
      const batch = paths.slice(i, i + 256);
      const sizes = await Promise.all(batch.map((p) => fs.lstat(path.join(root, p)).then((s) => s.size, () => 0)));
      sizes.forEach((size, j) => {
        if (size > max.file) {
          excluded.push(batch[j]);
          excludedBytes += size;
        } else total += size;
      });
    }
    if (opts.strict && total > max.total) throw new CheckpointSkipped(`${fmtMB(total)} of new files that git doesn't ignore`);
    /* a pathspec file, not argv: no length limit, and literal magic keeps any file name exact */
    if (excluded.length) {
      await fs.writeFile(specs, [".", ...excluded.map((p) => `:(exclude,literal)${p}`)].join("\0") + "\0", { mode: 0o600 });
      await git(root, ["add", "-A", `--pathspec-from-file=${specs}`, "--pathspec-file-nul"], { env, timeout: 60_000 });
    } else await git(root, ["add", "-A", "--", "."], { env, timeout: 60_000 });
    return { tree: (await git(root, ["write-tree"], { env })).trim(), excluded, excludedBytes };
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    await fs.rm(specs, { force: true }).catch(() => undefined);
  }
}

const skippedOf = (snap: Snapshot): Skipped | undefined =>
  snap.excluded.length ? { count: snap.excluded.length, bytes: snap.excludedBytes, paths: snap.excluded.slice(0, SKIPPED_PATHS) } : undefined;

function parseSkipped(body: string): Skipped | undefined {
  const line = body.split("\n").find((l) => l.startsWith(SKIPPED_TRAILER));
  if (!line) return undefined;
  try {
    const s = JSON.parse(line.slice(SKIPPED_TRAILER.length)) as Skipped;
    return typeof s.count === "number" && Array.isArray(s.paths) ? { count: s.count, bytes: Number(s.bytes) || 0, paths: s.paths.map(String) } : undefined;
  } catch {
    return undefined;
  }
}

export async function listCheckpoints(cwd: string, session: string): Promise<Checkpoint[]> {
  const root = await repoRoot(cwd);
  if (!root) return [];
  const out = await git(root, ["for-each-ref", "--sort=-refname", "--format=%(refname)%00%(objectname)%00%(tree)%00%(contents:subject)%00%(contents:body)%00", `${refBase(session)}/`]).catch(() => "");
  return out
    .split("\0\n")
    .filter(Boolean)
    .map((rec) => {
      const [ref, commit, tree, label = "", body = ""] = rec.split("\0");
      const id = ref.slice(ref.lastIndexOf("/") + 1);
      const skipped = parseSkipped(body);
      return { id, commit, tree, at: Number(id.split("-")[0]) || 0, label, ...(skipped ? { skipped } : {}) };
    });
}

/* why the last checkpoint of a session was skipped, until one is saved again (server memory only) */
const skips = new Map<string, { at: number; reason: string }>();
const skipKey = (root: string, session: string) => `${root}\0${session}`;

/** the reason this session's most recent checkpoint attempt was skipped, if it was */
export function checkpointSkip(root: string, session: string) {
  return skips.get(skipKey(root, session)) ?? null;
}

async function save(root: string, session: string, label: string): Promise<{ cp: Checkpoint; snap: Snapshot }> {
  let snap: Snapshot;
  try {
    snap = await snapshotTree(root, { strict: true });
  } catch (err) {
    if (err instanceof CheckpointSkipped) skips.set(skipKey(root, session), { at: Date.now(), reason: err.reason });
    throw err;
  }
  skips.delete(skipKey(root, session));
  const skipped = skippedOf(snap);
  const list = await listCheckpoints(root, session);
  if (list[0]?.tree === snap.tree && JSON.stringify(list[0].skipped) === JSON.stringify(skipped)) return { cp: list[0], snap };
  const head = (await git(root, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => "")).trim();
  const subject = label.replace(/\s+/g, " ").trim().slice(0, 120) || "Checkpoint";
  const message = skipped ? `${subject}\n\n${SKIPPED_TRAILER}${JSON.stringify(skipped)}` : subject;
  const commit = (await git(root, ["commit-tree", snap.tree, ...(head ? ["-p", head] : []), "-m", message], { env: BOT })).trim();
  const id = `${Date.now()}-${crypto.randomBytes(2).toString("hex")}`;
  await git(root, ["update-ref", `${refBase(session)}/${id}`, commit]);
  for (const old of list.slice(MAX_CHECKPOINTS - 1)) await git(root, ["update-ref", "-d", `${refBase(session)}/${old.id}`]).catch(() => undefined);
  await maybePrune(root);
  return { cp: { id, commit, tree: snap.tree, at: Number(id.split("-")[0]), label: subject, ...(skipped ? { skipped } : {}) }, snap };
}

/** Saves the folder's current state for this session, unless it's the same as the last checkpoint.
 * Throws CheckpointSkipped when there's too much new data to save. */
export async function checkpoint(cwd: string, session: string, label: string): Promise<Checkpoint | null> {
  const root = await repoRoot(cwd);
  if (!root) return null;
  return (await save(root, session, label)).cp;
}

/** Deletes checkpoints of every session in the repository whose commit is older than CHECKPOINT_MAX_AGE_DAYS. */
export async function pruneCheckpoints(cwd: string, now = Date.now()): Promise<number> {
  const root = await needRoot(cwd);
  const cutoff = Math.floor(now / 1000) - limits().days * 86_400;
  const out = await git(root, ["for-each-ref", "--format=%(refname)%00%(committerdate:unix)", "refs/agent-u/cp/"]);
  const old = out
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\0"))
    .filter(([, t]) => Number(t) > 0 && Number(t) < cutoff)
    .map(([ref]) => ref);
  if (old.length) await git(root, ["update-ref", "--stdin"], { input: old.map((r) => `delete ${r}\n`).join("") });
  return old.length;
}

const pruned = new Map<string, number>();

/** at most once an hour per repository, and never in the way of a checkpoint */
async function maybePrune(root: string) {
  const now = Date.now();
  if (now - (pruned.get(root) ?? 0) < PRUNE_EVERY_MS) return;
  pruned.set(root, now);
  await pruneCheckpoints(root, now).catch(() => 0);
}

/** Checkpoints taken before a session had its id (a first message) move to it once it does. */
export async function moveCheckpoints(cwd: string, from: string, to: string) {
  const root = await repoRoot(cwd);
  if (!root || from === to) return;
  for (const c of await listCheckpoints(root, from)) {
    await git(root, ["update-ref", `${refBase(to)}/${c.id}`, c.commit]);
    await git(root, ["update-ref", "-d", `${refBase(from)}/${c.id}`]);
  }
  const skip = skips.get(skipKey(root, from));
  if (skip) {
    skips.set(skipKey(root, to), skip);
    skips.delete(skipKey(root, from));
  }
}

export type FileStat = { path: string; added: number; removed: number; binary: boolean };

function numstat(out: string): FileStat[] {
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [a, r, ...p] = l.split("\t");
      return { path: p.join("\t"), added: a === "-" ? 0 : Number(a), removed: r === "-" ? 0 : Number(r), binary: a === "-" };
    });
}

/** what changed in the folder since a checkpoint */
export async function sinceCheckpoint(cwd: string, session: string, id: string): Promise<FileStat[]> {
  const root = await needRoot(cwd);
  const cp = (await listCheckpoints(root, session)).find((c) => c.id === id);
  if (!cp) throw new GitError("That checkpoint is gone.", 404);
  const now = (await snapshotTree(root)).tree;
  return numstat(await git(root, ["diff", "--numstat", "--no-renames", cp.tree, now]));
}

/* ── diffs ───────────────────────────────────────────── */

export type DiffScope = "uncommitted" | "checkpoint" | "branch";
export type GitDiff = {
  scope: DiffScope;
  /** the commit or tree the working tree is compared with */
  base: string;
  baseLabel: string;
  files: PatchFile[];
  additions: number;
  deletions: number;
  /** the patch hit the size cap, or some files were too large to include */
  truncated: boolean;
};

const DIFF_CAP = 2 * 1024 * 1024;
const HUGE_FILE_LINES = 4000;
const MAX_EXCLUDES = 1000;

/** stdout up to `cap` bytes; the process is stopped once it's reached */
function gitCapped(cwd: string, args: string[], cap: number): Promise<{ out: string; cut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let cut = false;
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stdout.on("data", (b: Buffer) => {
      if (cut) return;
      if (size + b.length >= cap) {
        chunks.push(b.subarray(0, cap - size));
        size = cap;
        cut = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(b);
      size += b.length;
    });
    child.stderr.on("data", (b: Buffer) => void (stderr.length < 4000 && (stderr += b.toString())));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new GitError(err.message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let out = Buffer.concat(chunks).toString("utf8");
      /* a cut can land mid-line (or mid-character); the parser only sees whole lines */
      if (cut) out = out.slice(0, out.lastIndexOf("\n") + 1);
      if (code === 0 || cut) resolve({ out, cut });
      else reject(new GitError(stderr.trim().split("\n").slice(-3).join(" ") || "git diff failed"));
    });
  });
}

type Stat = { path: string; oldPath?: string; status: PatchStatus; additions: number; deletions: number };

/** `--raw --numstat -z`: status letters first, then counts (files with no change left under -w have no counts) */
function rawNumstat(out: string): Stat[] {
  const t = out.split("\0");
  const kinds = new Map<string, string>();
  const stats: Stat[] = [];
  for (let i = 0; i < t.length; i++) {
    const tok = t[i];
    if (!tok) continue;
    if (tok.startsWith(":")) {
      const letter = tok.split(" ").pop()?.[0] ?? "M";
      const two = letter === "R" || letter === "C";
      const p = two ? t[i + 2] : t[i + 1];
      i += two ? 2 : 1;
      kinds.set(p, letter);
      continue;
    }
    const [a, d, name] = tok.split("\t");
    let p = name;
    let oldPath: string | undefined;
    if (!name) {
      oldPath = t[i + 1];
      p = t[i + 2];
      i += 2;
    }
    const k = kinds.get(p) ?? "M";
    const status: PatchStatus = a === "-" ? "binary" : k === "A" ? "added" : k === "D" ? "deleted" : oldPath ? "renamed" : "modified";
    stats.push({ path: p, oldPath, status, additions: a === "-" ? 0 : Number(a), deletions: d === "-" ? 0 : Number(d) });
  }
  return stats;
}

async function emptyTree(root: string) {
  return (await git(root, ["hash-object", "-t", "tree", "/dev/null"])).trim();
}

/** the default branch to compare a branch with: origin's HEAD, else main or master */
async function defaultBase(root: string): Promise<string | null> {
  const originHead = (await git(root, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]).catch(() => "")).trim();
  for (const ref of [originHead, "origin/main", "origin/master", "main", "master"]) {
    if (!ref) continue;
    const ok = await git(root, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]).then(() => true, () => false);
    if (ok) return ref;
  }
  return null;
}

/** The folder as it is now (untracked files in, ignored ones out) against HEAD, a checkpoint of this session, or where the branch left the default branch. */
export async function diff(cwd: string, session: string, opts: { scope: DiffScope; checkpoint?: string; ignoreWhitespace?: boolean; maxBytes?: number }): Promise<GitDiff> {
  const root = await needRoot(cwd);
  const head = (await git(root, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => "")).trim();
  let base: string;
  let baseLabel: string;
  if (opts.scope === "checkpoint") {
    const cp = (await listCheckpoints(root, session)).find((c) => c.id === opts.checkpoint);
    if (!cp) throw new GitError("That checkpoint is gone.", 404);
    base = cp.tree;
    baseLabel = cp.label;
  } else if (opts.scope === "branch") {
    if (!head) throw new GitError("The repository has no commits yet.");
    const ref = await defaultBase(root);
    if (!ref) throw new GitError("No main or master branch to compare with.", 404);
    base = (await git(root, ["merge-base", "HEAD", ref]).catch(() => "")).trim();
    if (!base) throw new GitError(`This branch shares no history with ${ref}.`);
    baseLabel = ref;
  } else {
    base = head || (await emptyTree(root));
    baseLabel = head ? "HEAD" : "Empty repository";
  }
  const now = (await snapshotTree(root)).tree;
  const flags = ["-c", "core.quotepath=off", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", ...(opts.ignoreWhitespace ? ["-w"] : [])];
  const stats = rawNumstat(await git(root, [...flags, "--raw", "--numstat", "-z", base, now], { timeout: 60_000 }));
  const huge = stats.filter((s) => s.additions + s.deletions > HUGE_FILE_LINES);
  const excludes = huge.length <= MAX_EXCLUDES ? huge.flatMap((s) => [s.path, ...(s.oldPath ? [s.oldPath] : [])]).map((p) => `:(exclude,literal)${p}`) : [];
  const patch = await gitCapped(root, [...flags, "--src-prefix=a/", "--dst-prefix=b/", "-U3", base, now, "--", ...(excludes.length ? [":/", ...excludes] : [])], opts.maxBytes ?? DIFF_CAP);
  const files = parseUnifiedPatch(patch.out);
  if (patch.cut && files.length) files[files.length - 1].truncated = true;
  const seen = new Set(files.map((f) => f.path));
  for (const s of stats) if (!seen.has(s.path)) files.push({ ...s, hunks: [], truncated: true });
  /* counts come from numstat, which sees whole files even when the patch was cut */
  const byPath = new Map(stats.map((s) => [s.path, s]));
  for (const f of files) {
    const s = byPath.get(f.path);
    if (s && f.truncated) {
      f.additions = s.additions;
      f.deletions = s.deletions;
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    scope: opts.scope,
    base,
    baseLabel,
    files,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    truncated: patch.cut || files.some((f) => f.truncated),
  };
}

/** Puts the folder's files back the way they were at a checkpoint. The state before is saved first, so this can be undone. */
export async function rewind(cwd: string, session: string, id: string) {
  const root = await needRoot(cwd);
  const cp = (await listCheckpoints(root, session)).find((c) => c.id === id);
  if (!cp) throw new GitError("That checkpoint is gone.", 404);
  const when = new Date(cp.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  let saved: Awaited<ReturnType<typeof save>>;
  try {
    saved = await save(root, session, `Before rewinding to ${when}`);
  } catch (err) {
    if (err instanceof CheckpointSkipped) throw new GitError(`Can't rewind: the files as they are now can't be saved first, so it couldn't be undone (${err.reason}).`, 413);
    throw err;
  }
  const before = saved.cp;
  if (before.tree === cp.tree) return { changed: 0, removed: 0, kept: 0, undo: before.id };
  /* Files left out of `before` (too large) aren't in its tree: they never count as made since, so they're never
   * removed, and one the checkpoint has an older copy of stays as it is, since the undo couldn't bring it back. */
  const excluded = new Set(saved.snap.excluded);
  const kept = (await git(root, ["diff", "--name-only", "--no-renames", "--diff-filter=D", "-z", cp.tree, before.tree])).split("\0").filter((p) => p && excluded.has(p));
  /* nor is one the checkpoint itself left out: it existed then, the checkpoint just has no copy of it */
  const leftOut = new Set(cp.skipped?.paths ?? []);
  const newer = (await git(root, ["diff", "--name-only", "--no-renames", "--diff-filter=A", "-z", cp.tree, before.tree])).split("\0").filter(Boolean);
  const added = newer.filter((p) => !leftOut.has(p));
  const keep = new Set([...kept, ...newer.filter((p) => leftOut.has(p))]);
  const changes = numstat(await git(root, ["diff", "--numstat", "--no-renames", cp.tree, before.tree])).filter((f) => !keep.has(f.path));
  const tmp = path.join(os.tmpdir(), `agent-u-index-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  try {
    const env = { GIT_INDEX_FILE: tmp };
    await git(root, ["read-tree", cp.tree], { env });
    if (kept.length) await git(root, ["update-index", "--force-remove", "-z", "--stdin"], { env, input: kept.join("\0") + "\0" });
    await git(root, ["checkout-index", "-a", "-f"], { env, timeout: 60_000 });
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
  for (const rel of added) {
    const abs = path.resolve(root, rel);
    if (abs.startsWith(`${root}${path.sep}`)) await fs.rm(abs, { force: true }).catch(() => undefined);
  }
  return { changed: changes.length, removed: added.length, kept: keep.size, undo: before.id };
}

/* ── status, commit, push, pull request ──────────────── */

export type GitStatus = {
  root: string;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: { path: string; state: string }[];
  remote: boolean;
  gh: boolean;
};

let ghPath: Promise<boolean> | null = null;
const hasGh = () => (ghPath ??= git(os.homedir(), ["--version"], { bin: "gh", timeout: 5000 }).then(() => true, () => false));

export async function status(cwd: string): Promise<GitStatus | null> {
  const root = await repoRoot(cwd);
  if (!root) return null;
  const [out, remotes, gh] = await Promise.all([git(root, ["status", "--porcelain=v1", "--branch", "-z", "--untracked-files=all"]), git(root, ["remote"]).catch(() => ""), hasGh()]);
  const parts = out.split("\0").filter(Boolean);
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: GitStatus["files"] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.startsWith("## ")) {
      /* "## main...origin/main [ahead 1, behind 2]", "## No commits yet on main", "## HEAD (no branch)" */
      let head = p.slice(3);
      const counts = / \[(.*)\]$/.exec(head);
      if (counts) head = head.slice(0, counts.index);
      const [b, up] = head.replace(/^(No commits yet|Initial commit) on /, "").split("...");
      branch = b.startsWith("HEAD (") ? null : b;
      upstream = up ?? null;
      ahead = Number(/ahead (\d+)/.exec(counts?.[1] ?? "")?.[1] ?? 0);
      behind = Number(/behind (\d+)/.exec(counts?.[1] ?? "")?.[1] ?? 0);
      continue;
    }
    const state = p.slice(0, 2);
    files.push({ path: p.slice(3), state });
    /* a rename carries its old name as the next part */
    if (state[0] === "R" || state[0] === "C") i++;
  }
  return { root, branch, upstream, ahead, behind, files, remote: Boolean(remotes.trim()), gh };
}

export async function commitAll(cwd: string, message: string) {
  const root = await needRoot(cwd);
  const msg = message.trim();
  if (!msg) throw new GitError("Write a commit message first.");
  await git(root, ["add", "-A"]);
  try {
    await git(root, ["commit", "-m", msg]);
  } catch (err) {
    const m = (err as Error).message;
    if (/Please tell me who you are|user\.email|user\.name/.test(m)) throw new GitError("Set git user.name and user.email on the server first.");
    if (/nothing to commit/.test(m)) throw new GitError("Nothing to commit.");
    throw err;
  }
  return (await git(root, ["rev-parse", "--short", "HEAD"])).trim();
}

export async function push(cwd: string) {
  const root = await needRoot(cwd);
  const st = await status(root);
  if (!st?.remote) throw new GitError("This repository has no remote to push to.");
  if (!st.branch) throw new GitError("Not on a branch (detached HEAD).");
  await git(root, st.upstream ? ["push"] : ["push", "-u", "origin", "HEAD"], { timeout: 120_000 });
  return st.branch;
}

export async function pullRequest(cwd: string, title?: string) {
  const root = await needRoot(cwd);
  if (!(await hasGh())) throw new GitError("Install the GitHub CLI (gh) on the server.");
  await push(root);
  const args = ["pr", "create", ...(title?.trim() ? ["--title", title.trim(), "--body", ""] : ["--fill"])];
  try {
    const out = await git(root, args, { bin: "gh", timeout: 60_000 });
    return out.trim().split("\n").pop() ?? "";
  } catch (err) {
    const m = (err as Error).message;
    const existing = /(https:\/\/\S+\/pull\/\d+)/.exec(m)?.[1];
    if (existing) return existing;
    if (/auth login|not logged/i.test(m)) throw new GitError("gh isn't logged in. Run gh auth login on the server.");
    throw err;
  }
}

/* ── worktrees ──────────────────────────────────────── */

export const WORKTREE_ROOT = process.env.AGENT_U_WORKTREES || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "agent-u", "worktrees");

/** A new branch checked out in its own folder, so a session can work without touching the main checkout. */
export async function newWorktree(cwd: string, name: string) {
  const root = await needRoot(cwd);
  const head = (await git(root, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => "")).trim();
  if (!head) throw new GitError("No commits yet.");
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "session";
  const stamp = new Date().toISOString().slice(5, 16).replace(/[-T:]/g, "");
  const branch = `agent-u/${slug}-${stamp}`;
  const dir = path.join(WORKTREE_ROOT, path.basename(root), `${slug}-${stamp}`);
  await fs.mkdir(path.dirname(dir), { recursive: true });
  await git(root, ["worktree", "add", "-b", branch, dir, "HEAD"], { timeout: 120_000 });
  /* the session starts in the same place inside the repo it was asked for */
  const sub = path.relative(root, path.resolve(cwd));
  const start = sub && !sub.startsWith("..") ? path.join(dir, sub) : dir;
  return { dir: await fs.stat(start).then(() => start, () => dir), branch };
}
