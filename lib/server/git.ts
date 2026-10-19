import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseUnifiedPatch, type PatchFile, type PatchStatus } from "@/lib/client/diff";
import { childEnv } from "./child-env";

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

function git(cwd: string, args: string[], opts: { env?: Record<string, string>; timeout?: number; bin?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      opts.bin ?? "git",
      args,
      { cwd, env: childEnv({ GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }, opts.env), timeout: opts.timeout ?? 20_000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const msg = (stderr.trim() ? stderr : stdout.trim() ? stdout : err.message).trim().split("\n").filter(Boolean).slice(-3).join(" ");
        reject(new GitError(msg || `${opts.bin ?? "git"} ${args[0]} failed`));
      },
    );
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

export type Checkpoint = { id: string; commit: string; tree: string; at: number; label: string };

/** the working tree as git would commit it right now (ignored files left out), through a copy of the index */
async function snapshotTree(root: string) {
  return (await snapshot(root)).tree;
}

/** plus the paths git couldn't add (an unreadable file, a nested repo without commits), which the tree leaves out */
async function snapshot(root: string): Promise<{ tree: string; skipped: string[] }> {
  const gitDir = (await git(root, ["rev-parse", "--absolute-git-dir"])).trim();
  const tmp = path.join(os.tmpdir(), `agent-u-index-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  /* starting from the real index lets git reuse its stat cache, so a big repo snapshots fast */
  await fs.copyFile(path.join(gitDir, "index"), tmp).catch(() => undefined);
  try {
    const env = { GIT_INDEX_FILE: tmp };
    /* --ignore-errors: what git can't add is left out and git exits 1 after writing the rest; a fatal error (128),
     * a timeout, no index at all, or an error that names no path still fail the snapshot */
    const failed = await new Promise<{ code: unknown; message: string; stderr: string } | null>((resolve) =>
      execFile(
        "git",
        ["add", "-A", "--ignore-errors", "--", "."],
        { cwd: root, env: childEnv({ GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }, env), timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },
        (err, _out, stderr) => resolve(err ? { code: err.code, stderr, message: stderr.trim().split("\n").filter(Boolean).slice(-3).join(" ") || err.message } : null),
      ),
    );
    const skipped = failed ? skippedPaths(failed.stderr) : [];
    if (failed && !(failed.code === 1 && skipped.length && (await fs.stat(tmp).then(() => true, () => false)))) throw new GitError(failed.message);
    return { tree: (await git(root, ["write-tree"], { env })).trim(), skipped };
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

export function skippedPaths(stderr: string): string[] {
  const out = new Set<string>();
  for (const line of stderr.split("\n")) {
    const m = /^error: unable to index file '(.+)'$/.exec(line) ?? /^error: '(.+?)\/?' does not have a commit checked out$/.exec(line);
    if (m) out.add(m[1]);
  }
  return [...out];
}

export async function listCheckpoints(cwd: string, session: string): Promise<Checkpoint[]> {
  const root = await repoRoot(cwd);
  if (!root) return [];
  const out = await git(root, ["for-each-ref", "--sort=-refname", "--format=%(refname)%09%(objectname)%09%(tree)%09%(contents:subject)", `${refBase(session)}/`]).catch(() => "");
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ref, commit, tree, ...rest] = line.split("\t");
      const id = ref.slice(ref.lastIndexOf("/") + 1);
      return { id, commit, tree, at: Number(id.split("-")[0]) || 0, label: rest.join("\t") };
    });
}

/** Saves the folder's current state for this session, unless it's the same as the last checkpoint. */
export async function checkpoint(cwd: string, session: string, label: string): Promise<Checkpoint | null> {
  const root = await repoRoot(cwd);
  if (!root) return null;
  const { tree, skipped } = await snapshot(root);
  const list = await listCheckpoints(root, session);
  if (list[0]?.tree === tree) return list[0];
  const head = (await git(root, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => "")).trim();
  const subject = label.replace(/\s+/g, " ").trim().slice(0, 120) || "Checkpoint";
  /* rewinding must not delete what this checkpoint couldn't see */
  const body = skipped.map((p) => `${SKIPPED}${JSON.stringify(p)}`).join("\n");
  const commit = (await git(root, ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", subject, ...(body ? ["-m", body] : [])], { env: BOT })).trim();
  const id = `${Date.now()}-${crypto.randomBytes(2).toString("hex")}`;
  await git(root, ["update-ref", `${refBase(session)}/${id}`, commit]);
  for (const old of list.slice(MAX_CHECKPOINTS - 1)) await git(root, ["update-ref", "-d", `${refBase(session)}/${old.id}`]).catch(() => undefined);
  return { id, commit, tree, at: Number(id.split("-")[0]), label: subject };
}

/** Checkpoints taken before a session had its id (a first message) move to it once it does. */
const SKIPPED = "Skipped: ";

async function skippedIn(root: string, commit: string): Promise<string[]> {
  const body = await git(root, ["show", "-s", "--format=%b", commit]).catch(() => "");
  return body.split("\n").flatMap((l) => {
    if (!l.startsWith(SKIPPED)) return [];
    try {
      const p: unknown = JSON.parse(l.slice(SKIPPED.length));
      return typeof p === "string" && p ? [p] : [];
    } catch {
      return [];
    }
  });
}

export async function moveCheckpoints(cwd: string, from: string, to: string) {
  const root = await repoRoot(cwd);
  if (!root || from === to) return;
  for (const c of await listCheckpoints(root, from)) {
    await git(root, ["update-ref", `${refBase(to)}/${c.id}`, c.commit]);
    await git(root, ["update-ref", "-d", `${refBase(from)}/${c.id}`]);
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
  const now = await snapshotTree(root);
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
    const child = spawn("git", args, { cwd, env: childEnv({ GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }), stdio: ["ignore", "pipe", "pipe"] });
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

type Stat = { path: string; oldPath?: string; status: PatchStatus; additions: number; deletions: number; binary?: boolean };

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
    const [a, d, ...rest] = tok.split("\t");
    const name = rest.join("\t");
    let p = name;
    let oldPath: string | undefined;
    if (!name) {
      oldPath = t[i + 1];
      p = t[i + 2];
      i += 2;
    }
    const k = kinds.get(p) ?? "M";
    const binary = a === "-";
    const status: PatchStatus = k === "A" ? "added" : k === "D" ? "deleted" : oldPath ? "renamed" : binary ? "binary" : "modified";
    stats.push({ path: p, oldPath, status, additions: binary ? 0 : Number(a), deletions: d === "-" ? 0 : Number(d), ...(binary ? { binary } : {}) });
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

type DiffOpts = { scope: DiffScope; checkpoint?: string; ignoreWhitespace?: boolean; maxBytes?: number };
/* several tabs poll the same diff, so identical requests share runs. A run that started more than JOIN_MS ago
 * snapshotted before the request (a refresh after a turn or a commit), so the request waits for the next run
 * instead, which everyone who asked meanwhile shares. */
type Flight = { p: Promise<GitDiff>; at: number; next?: Promise<GitDiff> };
const diffsInFlight = new Map<string, Flight>();
const JOIN_MS = 50;

/** The folder as it is now (untracked files in, ignored ones out) against HEAD, a checkpoint of this session, or where the branch left the default branch. */
export async function diff(cwd: string, session: string, opts: DiffOpts): Promise<GitDiff> {
  const root = await needRoot(cwd);
  const key = [root, opts.scope, opts.scope === "checkpoint" ? `${session}/${opts.checkpoint}` : "", opts.ignoreWhitespace ? "w" : "", opts.maxBytes ?? ""].join("|");
  const fly = (): Promise<GitDiff> => {
    const f: Flight = { at: Date.now(), p: diffAt(root, session, opts).finally(() => diffsInFlight.get(key) === f && diffsInFlight.delete(key)) };
    diffsInFlight.set(key, f);
    return f.p;
  };
  const cur = diffsInFlight.get(key);
  if (!cur) return fly();
  if (Date.now() - cur.at < JOIN_MS) return cur.p;
  return (cur.next ??= cur.p.then(fly, fly));
}

async function diffAt(root: string, session: string, opts: DiffOpts): Promise<GitDiff> {
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
  const now = await snapshotTree(root);
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
  const before = await checkpoint(root, session, `Before rewinding to ${when}`);
  if (!before || before.tree === cp.tree) return { changed: 0, removed: 0, undo: before?.id ?? null };
  const changes = numstat(await git(root, ["diff", "--numstat", "--no-renames", cp.tree, before.tree]));
  const added = (await git(root, ["diff", "--name-only", "--no-renames", "--diff-filter=A", "-z", cp.tree, before.tree])).split("\0").filter(Boolean);
  const tmp = path.join(os.tmpdir(), `agent-u-index-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  try {
    const env = { GIT_INDEX_FILE: tmp };
    await git(root, ["read-tree", cp.tree], { env });
    await git(root, ["checkout-index", "-a", "-f"], { env, timeout: 60_000 });
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
  const skipped = await skippedIn(root, cp.commit);
  const removable = added.filter((rel) => !skipped.some((s) => rel === s || rel.startsWith(`${s}/`)));
  for (const rel of removable) {
    const abs = path.resolve(root, rel);
    if (abs.startsWith(`${root}${path.sep}`)) await fs.rm(abs, { force: true }).catch(() => undefined);
  }
  return { changed: changes.length, removed: removable.length, undo: before.id };
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
