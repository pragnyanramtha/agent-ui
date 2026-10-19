import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseUnifiedPatch, type PatchFile, type PatchStatus } from "@/lib/client/diff";
import { geminiRoot } from "./agents/gemini-store";
import { getProfile, type ResolvedProfile } from "./profiles";

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
      { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", ...opts.env }, timeout: opts.timeout ?? 20_000, maxBuffer: 32 * 1024 * 1024 },
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
        { cwd: root, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", ...env }, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },
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
  /** origin's HEAD branch, else main or master when one exists */
  defaultBranch: string | null;
  /** the open (or merged/closed) pull request for this branch; undefined when gh can't tell */
  pr?: PullRequestInfo | null;
  /** when the background fetch last finished, and why it failed if it did */
  fetchedAt: number | null;
  fetchError: string | null;
};

export type PullRequestInfo = { number: number; url: string; state: string };

let ghPath: Promise<boolean> | null = null;
const hasGh = () => (ghPath ??= git(os.homedir(), ["--version"], { bin: "gh", timeout: 5000 }).then(() => true, () => false));

async function defaultBranchOf(root: string): Promise<string | null> {
  const originHead = (await git(root, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]).catch(() => "")).trim();
  if (originHead) return originHead.replace(/^origin\//, "");
  for (const b of ["main", "master"]) {
    for (const ref of [`refs/heads/${b}`, `refs/remotes/origin/${b}`]) {
      if (await git(root, ["rev-parse", "--verify", "-q", ref]).then(() => true, () => false)) return b;
    }
  }
  return null;
}

/* gh asks GitHub, so answers are kept a minute per branch */
const PR_TTL_MS = 60_000;
const prCache = new Map<string, { at: number; p: Promise<PullRequestInfo | null | undefined> }>();

function prFor(root: string, branch: string): Promise<PullRequestInfo | null | undefined> {
  const key = `${root}\0${branch}`;
  const hit = prCache.get(key);
  if (hit && Date.now() - hit.at < PR_TTL_MS) return hit.p;
  const p = git(root, ["pr", "view", "--json", "number,url,state"], { bin: "gh", timeout: 10_000 }).then(
    (out) => {
      const j = JSON.parse(out) as Partial<PullRequestInfo>;
      return typeof j.number === "number" && typeof j.url === "string" ? { number: j.number, url: j.url, state: String(j.state ?? "OPEN") } : undefined;
    },
    (err: Error) => (/no (open )?pull requests? found/i.test(err.message) ? null : undefined),
  );
  prCache.set(key, { at: Date.now(), p });
  if (prCache.size > 200) prCache.delete(prCache.keys().next().value!);
  return p;
}

export async function status(cwd: string): Promise<GitStatus | null> {
  const root = await repoRoot(cwd);
  if (!root) return null;
  const [out, remotes, gh, defaultBranch] = await Promise.all([
    git(root, ["status", "--porcelain=v1", "--branch", "-z", "--untracked-files=all"]),
    git(root, ["remote"]).catch(() => ""),
    hasGh(),
    defaultBranchOf(root),
  ]);
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
  const remote = Boolean(remotes.trim());
  const fetched = fetches.get(root);
  const st: GitStatus = { root, branch, upstream, ahead, behind, files, remote, gh, defaultBranch, fetchedAt: fetched?.done ?? null, fetchError: fetched?.error ?? null };
  if (gh && remote && branch && branch !== defaultBranch) {
    if (upstream) st.pr = await prFor(root, branch);
    /* an unpublished branch has no pull request yet, if origin is on GitHub at all */
    else if (/github/i.test(await git(root, ["remote", "get-url", "origin"]).catch(() => ""))) st.pr = null;
  }
  return st;
}

/* ── background fetch ───────────────────────────────── */

/** How often a repo someone is looking at gets fetched; 0 turns it off. */
export const GIT_FETCH_INTERVAL_MS = 60_000;
const FETCH_TIMEOUT_MS = 20_000;

type FetchState = { started: number; done: number | null; error: string | null; p: Promise<void> | null };
const fetches = new Map<string, FetchState>();

/** Starts `git fetch` for a repo with a remote unless one ran within the interval or is still running.
 * Never throws; a failure shows up as `fetchError` in its status. Resolves when the fetch (if any) is over. */
export async function autoFetch(cwd: string, opts: { intervalMs?: number; timeoutMs?: number } = {}): Promise<void> {
  const interval = opts.intervalMs ?? GIT_FETCH_INTERVAL_MS;
  if (interval <= 0) return;
  const root = await repoRoot(cwd);
  if (!root) return;
  const cur = fetches.get(root);
  if (cur?.p) return cur.p;
  if (cur && Date.now() - cur.started < interval) return;
  if (!(await git(root, ["remote"]).catch(() => "")).trim()) return;
  const again = fetches.get(root);
  if (again?.p) return again.p;
  if (again && again !== cur && Date.now() - again.started < interval) return;
  const timeout = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const st: FetchState = { started: Date.now(), done: cur?.done ?? null, error: cur?.error ?? null, p: null };
  st.p = git(root, ["fetch", "--quiet", "--no-tags"], { timeout, env: { GCM_INTERACTIVE: "never" } })
    .then(
      () => void (st.error = null),
      (err: Error) => void (st.error = Date.now() - st.started >= timeout ? `Fetch timed out after ${Math.round(timeout / 1000)} s.` : err.message),
    )
    .finally(() => {
      st.done = Date.now();
      st.p = null;
    });
  fetches.set(root, st);
  if (fetches.size > 500) fetches.delete(fetches.keys().next().value!);
  return st.p;
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

/** Fast-forwards the branch to its upstream; never merges or rebases. */
export async function pull(cwd: string) {
  const root = await needRoot(cwd);
  const st = await status(root);
  if (!st?.branch) throw new GitError("Not on a branch (detached HEAD).");
  if (!st.upstream) throw new GitError("This branch doesn't track a remote branch yet.");
  if (st.ahead && st.behind) throw new GitError(`${st.branch} and ${st.upstream} have both moved on. Merge or rebase in a terminal.`, 409);
  try {
    await git(root, ["pull", "--ff-only", "--no-rebase"], { timeout: 120_000 });
  } catch (err) {
    const m = (err as Error).message;
    if (/would be overwritten/.test(m)) throw new GitError("Uncommitted changes would be overwritten. Commit them first.");
    throw err;
  }
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
  } finally {
    for (const k of prCache.keys()) if (k.startsWith(`${root}\0`)) prCache.delete(k);
  }
}

/* ── generated commit messages ──────────────────────── */

const MESSAGE_DIFF_CAP = 60 * 1024;
const MESSAGE_TIMEOUT_MS = 60_000;
const SUBJECT_MAX = 72;

export type MessageAgent = "claude" | "codex" | "gemini";
export type CommitSuggestion = { message: string; source: MessageAgent | "summary"; staged: boolean };

/** A commit message for what would be committed: the staged changes, or everything when nothing is staged.
 * Asks a small model through the first installed agent CLI that answers, else summarizes the file list. */
export async function suggestCommitMessage(cwd: string, opts: { timeoutMs?: number; agents?: MessageAgent[] } = {}): Promise<CommitSuggestion> {
  const root = await needRoot(cwd);
  const head = (await git(root, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => "")).trim();
  const base = head || (await emptyTree(root));
  const flags = ["-c", "core.quotepath=off", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M"];
  let range = ["--cached", base];
  let stats = rawNumstat(await git(root, [...flags, "--raw", "--numstat", "-z", ...range]));
  const staged = stats.length > 0;
  if (!staged) {
    range = [base, await snapshotTree(root)];
    stats = rawNumstat(await git(root, [...flags, "--raw", "--numstat", "-z", ...range]));
  }
  if (!stats.length) throw new GitError("No changes to describe.");
  const [patch, log] = await Promise.all([
    gitCapped(root, [...flags, "-U3", ...range], MESSAGE_DIFF_CAP),
    head ? git(root, ["log", "-n", "10", "--no-merges", "--format=%s"]).catch(() => "") : Promise.resolve(""),
  ]);
  const prompt = commitPrompt({ patch: patch.out, cut: patch.cut, stats, subjects: log.split("\n").filter(Boolean) });
  const deadline = Date.now() + (opts.timeoutMs ?? MESSAGE_TIMEOUT_MS);
  for (const agent of opts.agents ?? (["claude", "codex", "gemini"] as const)) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    const profile = getProfile(agent);
    if (!profile?.binPath) continue;
    const message = cleanCommitMessage((await askOnce(agent, profile, prompt, left)) ?? "");
    if (message) return { message, source: agent, staged };
  }
  return { message: summaryMessage(stats), source: "summary", staged };
}

export function commitPrompt(o: { patch: string; cut: boolean; stats: { path: string; status: PatchStatus; additions: number; deletions: number }[]; subjects: string[] }) {
  const files = o.stats.map((s) => `${s.status} ${s.path} (+${s.additions} -${s.deletions})`).join("\n");
  return [
    "Write a git commit message for the changes below.",
    `Reply with the message only: a subject line of at most ${SUBJECT_MAX} characters in the imperative mood, then optionally a blank line and a short body saying why. No quotes, no code fences, no preamble.`,
    o.subjects.length ? `Match the style of this repository's recent commit subjects:\n${o.subjects.map((s) => `- ${s}`).join("\n")}` : "",
    `Files changed:\n${files}`,
    `Diff${o.cut ? " (cut off)" : ""}:\n${o.patch}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** a model id from the profile that looks cheap, if it lists any */
const cheapModel = (p: ResolvedProfile) => p.models?.find((m) => /haiku|mini|flash|lite|nano|small|low/i.test(m));

function messageArgs(agent: MessageAgent, p: ResolvedProfile, o: { lastMessageFile: string; sessionId: string }): string[] {
  const model = cheapModel(p);
  if (agent === "claude") return [...p.args, "-p", "--output-format", "text", "--model", model ?? (p.models?.length ? (p.defaultModel ?? p.models[0]) : "haiku"), "--max-turns", "1", "--no-session-persistence"];
  if (agent === "codex")
    return [...p.args, "exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "-c", 'model_reasoning_effort="low"', ...(model ? ["--model", model] : []), "--output-last-message", o.lastMessageFile, "-"];
  return [...p.args, "-p", "", "--output-format", "text", "--skip-trust", "--session-id", o.sessionId, ...(model ? ["-m", model] : [])];
}

/* runs start in an empty folder of their own, away from the repo, so the agent doesn't wander its files or file
 * the run under the user's project; one fixed folder keeps agents' per-project bookkeeping to a single entry */
const messageCwd = () => path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "agent-u", "commit-message");

/** Gemini CLI has no way to skip saving a chat, so the one-shot's chat is removed after it ran. */
async function forgetGeminiChat(p: ResolvedProfile, cwd: string, id: string) {
  const root = geminiRoot(p.env.GEMINI_CLI_HOME || process.env.GEMINI_CLI_HOME || os.homedir());
  let slug = path.basename(cwd).toLowerCase();
  try {
    const j = JSON.parse(await fs.readFile(path.join(root, "projects.json"), "utf8")) as { projects?: Record<string, unknown> };
    const s = j.projects?.[cwd];
    if (typeof s === "string" && s && !s.includes("/")) slug = s;
  } catch {}
  const chats = path.join(root, "tmp", slug, "chats");
  const names = await fs.readdir(chats).catch(() => [] as string[]);
  for (const n of names) if (n.startsWith("session-") && (n.endsWith(`-${id.slice(0, 8)}.jsonl`) || n.endsWith(`-${id.slice(0, 8)}.json`))) await fs.rm(path.join(chats, n), { force: true }).catch(() => undefined);
}

/** one print-mode run with the prompt on stdin; its answer, or null when it fails or runs out of time */
async function askOnce(agent: MessageAgent, p: ResolvedProfile, prompt: string, timeoutMs: number): Promise<string | null> {
  const cwd = messageCwd();
  await fs.mkdir(cwd, { recursive: true, mode: 0o700 });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-u-commit-msg-"));
  const out = path.join(dir, "last-message.txt");
  const sessionId = crypto.randomUUID();
  try {
    const stdout = await new Promise<string | null>((resolve) => {
      /* its own process group, so a timeout also stops whatever the CLI started */
      const child = spawn(p.binPath!, messageArgs(agent, p, { lastMessageFile: out, sessionId }), { cwd, env: { ...process.env, ...p.env, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "ignore"], detached: true });
      let text = "";
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
        resolve(null);
      }, timeoutMs);
      child.stdout.on("data", (b: Buffer) => void (text.length < 64 * 1024 && (text += b.toString())));
      child.on("error", () => (clearTimeout(timer), resolve(null)));
      child.on("close", (code) => (clearTimeout(timer), resolve(code === 0 ? text : null)));
      child.stdin.on("error", () => undefined);
      child.stdin.end(prompt);
    });
    if (stdout === null) return null;
    if (agent === "codex") return (await fs.readFile(out, "utf8").catch(() => "")) || stdout;
    return stdout;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    if (agent === "gemini") await forgetGeminiChat(p, cwd, sessionId).catch(() => undefined);
  }
}

/** A model's reply as a commit message: a subject of at most 72 characters and an optional body; "" when nothing usable. */
export function cleanCommitMessage(raw: string): string {
  let text = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r\n?/g, "\n");
  const fenced = /```[^\n]*\n([\s\S]*?)(?:```|$)/.exec(text);
  if (fenced) text = fenced[1];
  const lines = text.split("\n").map((l) => l.trimEnd());
  while (lines.length && (!lines[0].trim() || /^(sure|okay|ok|here(?:'s| is| are)\b|commit message\b).*:\s*$/i.test(lines[0].trim()))) lines.shift();
  if (!lines.length) return "";
  const subject = shortenSubject(
    lines[0]
      .trim()
      .replace(/^#+\s*/, "")
      .replace(/^(commit message|subject|title)\s*:\s*/i, "")
      .replace(/^(\*\*|__)|(\*\*|__)$/g, "")
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/\s+/g, " ")
      .replace(/\.$/, "")
      .trim(),
  );
  if (!subject) return "";
  const body = lines
    .slice(1)
    .filter((l) => !/^\s*(co-authored-by:|generated (with|by)\b|🤖)/i.test(l))
    .join("\n")
    .replace(/^\s*(body\s*:\s*)?/i, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(/["'`]+$/, "")
    .trim()
    .slice(0, 2000);
  return body ? `${subject}\n\n${body}` : subject;
}

function shortenSubject(s: string): string {
  if (s.length <= SUBJECT_MAX) return s;
  const cut = s.slice(0, SUBJECT_MAX + 1);
  const space = cut.lastIndexOf(" ");
  return (space > 30 ? cut.slice(0, space) : s.slice(0, SUBJECT_MAX)).replace(/[\s,;:.-]+$/, "");
}

/** "Update GitPanel.tsx and git.ts": what a commit touches, when no model can say more */
export function summaryMessage(stats: { path: string; status: PatchStatus }[]): string {
  if (!stats.length) return "Update files";
  const verb = stats.every((s) => s.status === "added") ? "Add" : stats.every((s) => s.status === "deleted") ? "Remove" : stats.every((s) => s.status === "renamed") ? "Rename" : "Update";
  const names = [...new Set(stats.map((s) => path.posix.basename(s.path)))];
  const list = (shown: string[], more: number) =>
    more > 0 ? `${shown.join(", ")} and ${more} more ${more === 1 ? "file" : "files"}` : shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}` : shown[0];
  for (const n of names.length <= 3 ? [names.length, 2, 1] : [2, 1]) {
    if (n > names.length) continue;
    const line = `${verb} ${list(names.slice(0, n), names.length - n)}`;
    if (line.length <= SUBJECT_MAX) return line;
  }
  return `${verb} ${names.length} ${names.length === 1 ? "file" : "files"}`;
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
