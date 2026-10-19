import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Settings } from "@/lib/settings-schema";
import { childEnv } from "./child-env";
import { WORKTREE_ROOT } from "./git";
import { CONFIG_DIR } from "./profiles";
import { syncedSetting } from "./settings";

/* Settings > Storage: what agent-u keeps on the server's disk (worktrees for sessions, uploaded attachments,
 * checkpoint refs), and the cleanup policies for the first two. A cleanup never removes a worktree with uncommitted
 * or untracked changes, one a running session is in, or one it can't read; removing a worktree keeps its branch unless
 * the branch is merged. "Clean up now" lists first (a dry run) and then deletes only what it listed and still
 * qualifies. The policies also run on their own, at most once a day. */

export const ATTACH_ROOT = process.env.AGENT_U_ATTACH || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "agent-u", "attachments");
const STATE_PATH = path.join(CONFIG_DIR, "storage.json");
const DAY_MS = 86_400_000;

function run(cmd: string, args: string[], cwd?: string, timeout = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, env: childEnv({ GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }), timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr.trim() || err.message).split("\n").slice(-2).join(" ")));
      else resolve(stdout);
    });
  });
}
const git = (cwd: string, args: string[]) => run("git", args, cwd);

/** bytes on disk under `dir` (0 when it's missing); `du` when there is one, else a walk */
export async function dirBytes(dir: string): Promise<number> {
  if (!(await fs.stat(dir).catch(() => null))) return 0;
  const out = await run("du", ["-sk", dir], undefined, 60_000).catch(() => null);
  const kb = out ? Number(out.split(/\s/)[0]) : NaN;
  if (Number.isFinite(kb)) return kb * 1024;
  let total = 0;
  const walk = async (p: string) => {
    const st = await fs.lstat(p).catch(() => null);
    if (!st) return;
    total += st.size;
    if (st.isDirectory()) for (const e of await fs.readdir(p).catch(() => [])) await walk(path.join(p, e));
  };
  await walk(dir);
  return total;
}

/* ── worktrees ──────────────────────────────────────── */

/** what the cleanup needs to know about a session: where it runs and whether it's running now */
export type SessionLite = { cwd: string; mtime: number; running: boolean };

export type WorktreeInfo = {
  path: string;
  /** the main checkout it belongs to; null when that's gone or unreadable */
  repo: string | null;
  branch: string | null;
  bytes: number;
  /** newest of the folder, its git index and HEAD log, and the sessions in it (epoch ms) */
  lastActive: number;
  /** uncommitted or untracked changes */
  dirty: boolean;
  /** a session in it is running */
  running: boolean;
  /** its branch had commits of its own and all of them are in the default branch */
  merged: boolean;
  /** git couldn't read it; never removed */
  unreadable: boolean;
};

const inside = (dir: string, p: string) => p === dir || p.startsWith(`${dir}/`);

async function mtime(p: string) {
  return (await fs.stat(p).catch(() => null))?.mtimeMs ?? 0;
}

async function defaultBranch(dir: string): Promise<string | null> {
  for (const ref of ["refs/remotes/origin/HEAD", "refs/heads/main", "refs/heads/master"]) {
    const ok = await git(dir, ["rev-parse", "--verify", "-q", ref]).then(() => true, () => false);
    if (ok) return ref;
  }
  return null;
}

async function inspect(dir: string, sessions: SessionLite[]): Promise<WorktreeInfo> {
  const mine = sessions.filter((s) => s.cwd && inside(dir, path.resolve(s.cwd)));
  const base: WorktreeInfo = {
    path: dir,
    repo: null,
    branch: null,
    bytes: await dirBytes(dir),
    lastActive: Math.max(await mtime(dir), ...mine.map((s) => s.mtime)),
    dirty: false,
    running: mine.some((s) => s.running),
    merged: false,
    unreadable: false,
  };
  try {
    const [status, branch, gitDir, common] = await Promise.all([
      git(dir, ["status", "--porcelain", "--untracked-files=normal"]),
      git(dir, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => ""),
      git(dir, ["rev-parse", "--absolute-git-dir"]),
      git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    ]);
    const repo = path.basename(common.trim()) === ".git" ? path.dirname(common.trim()) : null;
    base.repo = repo && (await fs.stat(repo).catch(() => null)) ? repo : null;
    base.branch = branch.trim() || null;
    base.dirty = status.trim().length > 0;
    base.lastActive = Math.max(base.lastActive, await mtime(path.join(gitDir.trim(), "index")), await mtime(path.join(gitDir.trim(), "logs", "HEAD")));
    const target = await defaultBranch(dir);
    if (base.branch && target) {
      const ahead = Number((await git(dir, ["rev-list", "--count", `${target}..HEAD`])).trim());
      /* a branch made from the default one with nothing committed is "in" it too, but that's not merged work */
      const log = await git(dir, ["reflog", "show", "--format=%H", `refs/heads/${base.branch}`]).catch(() => "");
      base.merged = ahead === 0 && log.split("\n").filter(Boolean).length > 1;
    }
    if (!base.repo) base.unreadable = true;
  } catch {
    base.unreadable = true;
  }
  return base;
}

async function liveSessions(): Promise<SessionLite[]> {
  const { sessionRows } = await import("./rows");
  return (await sessionRows()).map((s) => ({ cwd: s.cwd, mtime: s.mtime, running: Boolean(s.terminal) || s.web?.status === "running" || s.web?.status === "starting" }));
}

/** Every worktree under `root` (one folder per repository, one per worktree inside). */
export async function listWorktrees(opts: { root?: string; sessions?: SessionLite[] } = {}): Promise<WorktreeInfo[]> {
  const root = opts.root ?? WORKTREE_ROOT;
  const sessions = opts.sessions ?? (await liveSessions().catch(() => []));
  const dirs: string[] = [];
  for (const repo of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!repo.isDirectory()) continue;
    for (const wt of await fs.readdir(path.join(root, repo.name), { withFileTypes: true }).catch(() => [])) {
      const dir = path.join(root, repo.name, wt.name);
      if (wt.isDirectory() && (await fs.stat(path.join(dir, ".git")).catch(() => null))) dirs.push(dir);
    }
  }
  return Promise.all(dirs.map((d) => inspect(d, sessions)));
}

/* ── attachments ────────────────────────────────────── */

export type AttachmentDir = { path: string; bytes: number; mtime: number };

async function listAttachments(root = ATTACH_ROOT): Promise<AttachmentDir[]> {
  const out: AttachmentDir[] = [];
  for (const d of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory()) continue;
    const p = path.join(root, d.name);
    out.push({ path: p, bytes: await dirBytes(p), mtime: await mtime(p) });
  }
  return out;
}

/** Deletes attachment folders past Settings > Storage > Remove attachments. Cheap; runs whenever one is made. */
export async function sweepAttachments(opts: { root?: string; days?: Settings["attachmentCleanupDays"]; now?: number } = {}) {
  const days = opts.days ?? syncedSetting("attachmentCleanupDays");
  if (days === "off") return 0;
  const root = opts.root ?? ATTACH_ROOT;
  const cutoff = (opts.now ?? Date.now()) - Number(days) * DAY_MS;
  let n = 0;
  for (const d of await fs.readdir(root).catch(() => [])) {
    const p = path.join(root, d);
    const t = await mtime(p);
    if (t && t < cutoff) await fs.rm(p, { recursive: true, force: true }).then(() => n++, () => undefined);
  }
  return n;
}

/* ── the plan and the cleanup ───────────────────────── */

export type Policy = { worktreeDays: Settings["worktreeCleanupDays"]; attachmentDays: Settings["attachmentCleanupDays"] };
export type PlanItem = { kind: "worktree" | "attachments"; path: string; bytes: number; reason: string; branch?: string | null; repo?: string | null; merged?: boolean };
export type Plan = { items: PlanItem[]; bytes: number; kept: { path: string; reason: string }[] };
export type Roots = { worktrees?: string; attachments?: string; sessions?: SessionLite[] };

export const currentPolicy = (): Policy => ({ worktreeDays: syncedSetting("worktreeCleanupDays"), attachmentDays: syncedSetting("attachmentCleanupDays") });

const daysAgo = (ms: number) => Math.max(0, Math.floor(ms / DAY_MS));
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** What a cleanup under `policy` would remove now, and the worktrees it would leave for a reason worth showing. */
export async function planCleanup(policy: Policy = currentPolicy(), opts: Roots & { now?: number } = {}): Promise<Plan> {
  const now = opts.now ?? Date.now();
  const items: PlanItem[] = [];
  const kept: Plan["kept"] = [];
  if (policy.worktreeDays !== "off") {
    const limit = Number(policy.worktreeDays) * DAY_MS;
    for (const w of await listWorktrees({ root: opts.worktrees, sessions: opts.sessions })) {
      const idle = now - w.lastActive;
      const due = w.merged || idle >= limit;
      if (!due) continue;
      const block = w.unreadable ? "Can't read it with git" : w.running ? "A session in it is running" : w.dirty ? "Has uncommitted changes" : null;
      if (block) {
        kept.push({ path: w.path, reason: block });
        continue;
      }
      items.push({ kind: "worktree", path: w.path, bytes: w.bytes, branch: w.branch, repo: w.repo, merged: w.merged, reason: w.merged ? "Branch merged" : `Idle ${plural(daysAgo(idle), "day")}` });
    }
  }
  if (policy.attachmentDays !== "off") {
    const limit = Number(policy.attachmentDays) * DAY_MS;
    for (const a of await listAttachments(opts.attachments)) {
      if (now - a.mtime >= limit) items.push({ kind: "attachments", path: a.path, bytes: a.bytes, reason: `${plural(daysAgo(now - a.mtime), "day")} old` });
    }
  }
  return { items, bytes: items.reduce((n, i) => n + i.bytes, 0), kept };
}

async function removeWorktree(item: PlanItem, root: string) {
  if (!item.repo) throw new Error("No repository");
  /* without --force git refuses a worktree with changes, so a file written since the plan still stops it */
  await git(item.repo, ["worktree", "remove", item.path]);
  if (item.merged && item.branch) await git(item.repo, ["branch", "-d", item.branch]).catch(() => undefined);
  const parent = path.dirname(item.path);
  if (inside(root, parent) && parent !== root) await fs.rmdir(parent).catch(() => undefined);
}

export type CleanupResult = { removed: PlanItem[]; failed: { path: string; error: string }[]; bytes: number; at: number };

/** Removes what a fresh plan lists; with `only`, just those of it (the paths a dry run showed). */
export async function runCleanup(opts: Roots & { policy?: Policy; only?: string[]; now?: number } = {}): Promise<CleanupResult> {
  const plan = await planCleanup(opts.policy ?? currentPolicy(), opts);
  const want = opts.only ? new Set(opts.only) : null;
  const removed: PlanItem[] = [];
  const failed: CleanupResult["failed"] = [];
  for (const item of plan.items) {
    if (want && !want.has(item.path)) continue;
    try {
      if (item.kind === "worktree") await removeWorktree(item, opts.worktrees ?? WORKTREE_ROOT);
      else await fs.rm(item.path, { recursive: true, force: true });
      removed.push(item);
    } catch (err) {
      failed.push({ path: item.path, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const result = { removed, failed, bytes: removed.reduce((n, i) => n + i.bytes, 0), at: opts.now ?? Date.now() };
  report = null;
  return result;
}

/* ── the report ─────────────────────────────────────── */

export type StorageReport = {
  worktrees: { root: string; bytes: number; items: WorktreeInfo[] };
  attachments: { root: string; bytes: number; count: number };
  checkpoints: { refs: number; repos: number };
  lastCleanup: { at: number; removed: number; bytes: number } | null;
  policy: Policy;
};

async function countCheckpoints(dirs: string[]): Promise<{ refs: number; repos: number }> {
  const roots = new Set<string>();
  for (const d of dirs.slice(0, 200)) {
    const common = await git(d, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => "");
    if (common.trim()) roots.add(common.trim());
  }
  let refs = 0;
  let repos = 0;
  for (const r of roots) {
    const n = (await git(r, ["for-each-ref", "--format=x", "refs/agent-u/cp/"]).catch(() => "")).split("\n").filter(Boolean).length;
    refs += n;
    if (n) repos++;
  }
  return { refs, repos };
}

let report: { at: number; p: Promise<StorageReport> } | null = null;
const REPORT_TTL_MS = 30_000;

/** Disk used by worktrees and attachments and the checkpoint refs in the repos sessions use; cached half a minute. */
export function storageReport(opts: Roots & { fresh?: boolean } = {}): Promise<StorageReport> {
  if (!opts.fresh && report && Date.now() - report.at < REPORT_TTL_MS) return report.p;
  const p = (async (): Promise<StorageReport> => {
    const sessions = opts.sessions ?? (await liveSessions().catch(() => []));
    const root = opts.worktrees ?? WORKTREE_ROOT;
    const attachRoot = opts.attachments ?? ATTACH_ROOT;
    const [items, attachments] = await Promise.all([listWorktrees({ root, sessions }), listAttachments(attachRoot)]);
    const cwds = [...new Set([...sessions.map((s) => s.cwd).filter((c) => c && path.isAbsolute(c)), ...items.map((w) => w.path)])];
    const existing = (await Promise.all(cwds.map(async (c) => ((await fs.stat(c).catch(() => null))?.isDirectory() ? c : null)))).filter((c): c is string => Boolean(c));
    return {
      worktrees: { root, bytes: items.reduce((n, w) => n + w.bytes, 0), items },
      attachments: { root: attachRoot, bytes: attachments.reduce((n, a) => n + a.bytes, 0), count: attachments.length },
      checkpoints: await countCheckpoints(existing),
      lastCleanup: readState().last,
      policy: currentPolicy(),
    };
  })();
  report = { at: Date.now(), p };
  p.catch(() => (report = null));
  return p;
}

/* ── once a day ─────────────────────────────────────── */

type State = { last: StorageReport["lastCleanup"] };

function readState(): State {
  try {
    const raw = JSON.parse(fsSync.readFileSync(STATE_PATH, "utf8")) as Partial<State>;
    const l = raw.last;
    return { last: l && typeof l.at === "number" ? { at: l.at, removed: Number(l.removed) || 0, bytes: Number(l.bytes) || 0 } : null };
  } catch {
    return { last: null };
  }
}

function writeState(s: State) {
  try {
    fsSync.mkdirSync(path.dirname(STATE_PATH), { recursive: true, mode: 0o700 });
    fsSync.writeFileSync(STATE_PATH, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
  } catch (err) {
    console.warn(`storage: can't save ${STATE_PATH}: ${(err as Error).message}`);
  }
}

/** Records a cleanup as the latest, so the daily one counts from it. */
export function noteCleanup(r: CleanupResult) {
  writeState({ last: { at: r.at, removed: r.removed.length, bytes: r.bytes } });
}

/** Runs the policies when one is on and the last cleanup is a day old. Resolves to the result, or null if it didn't. */
export async function dailyCleanup(now = Date.now()): Promise<CleanupResult | null> {
  const policy = currentPolicy();
  if (policy.worktreeDays === "off" && policy.attachmentDays === "off") return null;
  const last = readState().last;
  if (last && now - last.at < DAY_MS) return null;
  const r = await runCleanup({ policy, now });
  noteCleanup(r);
  if (r.removed.length) console.log(`storage: cleanup removed ${r.removed.length} (${Math.round(r.bytes / 1e6)} MB)`);
  return r;
}

const CHECK_EVERY_MS = 60 * 60_000;
const FIRST_CHECK_MS = 10 * 60_000;
const g = globalThis as { __agentuStorage?: boolean };

/** Checks hourly (first ten minutes after start) whether the daily cleanup is due. Once per server process. */
export function startStorageCleanup() {
  if (g.__agentuStorage) return;
  g.__agentuStorage = true;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await dailyCleanup();
    } catch (err) {
      console.warn(`storage: cleanup failed: ${(err as Error).message}`);
    } finally {
      busy = false;
    }
  };
  setTimeout(() => void tick(), FIRST_CHECK_MS).unref();
  setInterval(() => void tick(), CHECK_EVERY_MS).unref();
}
