import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { childEnv } from "@/lib/server/child-env";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentu-storage-"));
const repo = path.join(tmp, "repo");
const wtRoot = path.join(tmp, "worktrees");
const attachRoot = path.join(tmp, "attachments");
process.env.AGENT_U_WORKTREES = wtRoot;
process.env.AGENT_U_ATTACH = attachRoot;
process.env.AGENT_U_SETTINGS = path.join(tmp, "settings.json");

const live = vi.hoisted(() => ({ rows: [] as { cwd: string; mtime: number; terminal: null; web: { status: string } | null }[] }));
vi.mock("@/lib/server/rows", () => ({ sessionRows: async () => live.rows }));

const DAY = 86_400_000;
const LATER = Date.now() + 40 * DAY;
const env = childEnv({ GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
const sh = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8", env });
const wt = (name: string) => path.join(wtRoot, "repo", name);
const addWorktree = (name: string) => sh(["worktree", "add", "-q", "-b", `agent-u/${name}`, wt(name), "HEAD"]);
const branches = () => sh(["branch", "--list", "--format=%(refname:short)"]).split("\n").filter(Boolean);

let s: typeof import("@/lib/server/storage");
const policy = { worktreeDays: "7", attachmentDays: "30" } as const;
let sessions: import("@/lib/server/storage").SessionLite[];

beforeAll(async () => {
  s = await import("@/lib/server/storage");
  fs.mkdirSync(repo);
  sh(["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  sh(["add", "-A"]);
  sh(["commit", "-qm", "init"]);
  fs.mkdirSync(path.join(wtRoot, "repo"), { recursive: true });

  addWorktree("idle");
  addWorktree("dirty");
  fs.writeFileSync(path.join(wt("dirty"), "notes.md"), "draft\n");
  addWorktree("running");
  addWorktree("recent");
  addWorktree("merged");
  fs.writeFileSync(path.join(wt("merged"), "b.txt"), "bee\n");
  sh(["add", "-A"], wt("merged"));
  sh(["commit", "-qm", "add b"], wt("merged"));
  sh(["merge", "-q", "--ff-only", "agent-u/merged"]);
  /* a worktree whose repository is gone */
  fs.mkdirSync(wt("orphan"));
  fs.writeFileSync(path.join(wt("orphan"), ".git"), `gitdir: ${path.join(tmp, "gone", ".git", "worktrees", "orphan")}\n`);

  for (const [name, age] of [["2026-01-01-old", 60], ["2026-09-30-new", 1]] as const) {
    const d = path.join(attachRoot, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "shot.png"), "x".repeat(2048));
    const t = new Date(LATER - age * DAY);
    fs.utimesSync(d, t, t);
  }
  sh(["update-ref", "refs/agent-u/cp/0123456789abcdef/1", "HEAD"]);
  sh(["update-ref", "refs/agent-u/cp/0123456789abcdef/2", "HEAD"]);

  sessions = [
    { cwd: path.join(wt("running"), "src"), mtime: Date.now(), running: true },
    { cwd: wt("recent"), mtime: LATER - DAY, running: false },
    { cwd: repo, mtime: Date.now(), running: false },
  ];
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const opts = () => ({ worktrees: wtRoot, attachments: attachRoot, sessions, now: LATER });

describe("storage report", () => {
  it("lists worktrees with what keeps them, sizes and checkpoint refs", async () => {
    const r = await s.storageReport({ ...opts(), fresh: true });
    const by = Object.fromEntries(r.worktrees.items.map((w) => [path.basename(w.path), w]));
    expect(Object.keys(by).sort()).toEqual(["dirty", "idle", "merged", "orphan", "recent", "running"]);
    expect(by.dirty).toMatchObject({ dirty: true, branch: "agent-u/dirty", repo: fs.realpathSync(repo), merged: false });
    expect(by.running.running).toBe(true);
    expect(by.merged.merged).toBe(true);
    /* a fresh branch with no commits of its own isn't "merged" */
    expect(by.idle.merged).toBe(false);
    expect(by.orphan.unreadable).toBe(true);
    expect(r.worktrees.bytes).toBeGreaterThan(0);
    expect(r.attachments).toMatchObject({ count: 2 });
    expect(r.attachments.bytes).toBeGreaterThanOrEqual(4096);
    expect(r.checkpoints).toEqual({ refs: 2, repos: 1 });
  });
});

describe("cleanup", () => {
  it("does nothing with both policies off", async () => {
    expect(await s.planCleanup({ worktreeDays: "off", attachmentDays: "off" }, opts())).toEqual({ items: [], bytes: 0, kept: [] });
  });

  it("plans idle and merged worktrees and old attachments, and keeps the rest with a reason", async () => {
    const plan = await s.planCleanup(policy, opts());
    const names = plan.items.map((i) => `${i.kind}:${path.basename(i.path)}:${i.reason.replace(/\d+/, "N")}`).sort();
    expect(names).toEqual(["attachments:2026-01-01-old:N days old", "worktree:idle:Idle N days", "worktree:merged:Branch merged"]);
    const kept = Object.fromEntries(plan.kept.map((k) => [path.basename(k.path), k.reason]));
    expect(kept).toEqual({ dirty: "Has uncommitted changes", running: "A session in it is running", orphan: "Can't read it with git" });
    expect(plan.bytes).toBe(plan.items.reduce((n, i) => n + i.bytes, 0));
    /* a dry run touches nothing */
    expect(fs.existsSync(wt("idle"))).toBe(true);
    expect(fs.existsSync(path.join(attachRoot, "2026-01-01-old"))).toBe(true);
  });

  it("removes a merged worktree as soon as it's merged, even when the idle limit is longer", async () => {
    const plan = await s.planCleanup({ worktreeDays: "30", attachmentDays: "off" }, { ...opts(), now: Date.now() });
    expect(plan.items.map((i) => path.basename(i.path))).toEqual(["merged"]);
  });

  it("deletes only what the dry run listed, and keeps unmerged branches", async () => {
    const r = await s.runCleanup({ ...opts(), policy, only: [wt("idle"), wt("dirty"), path.join(attachRoot, "2026-01-01-old")] });
    expect(r.removed.map((i) => path.basename(i.path)).sort()).toEqual(["2026-01-01-old", "idle"]);
    expect(r.failed).toEqual([]);
    expect(fs.existsSync(wt("idle"))).toBe(false);
    expect(fs.existsSync(wt("dirty"))).toBe(true);
    expect(fs.existsSync(wt("merged"))).toBe(true);
    expect(sh(["worktree", "list"])).not.toContain(wt("idle"));
    expect(branches()).toContain("agent-u/idle");
    expect(fs.existsSync(path.join(attachRoot, "2026-09-30-new"))).toBe(true);
  });

  it("deletes a merged worktree's branch with it", async () => {
    const r = await s.runCleanup({ ...opts(), policy });
    expect(r.removed.map((i) => path.basename(i.path))).toEqual(["merged"]);
    expect(branches()).not.toContain("agent-u/merged");
    expect(fs.readFileSync(path.join(repo, "b.txt"), "utf8")).toBe("bee\n");
    /* what's left is what must stay */
    expect((await s.listWorktrees({ root: wtRoot, sessions })).map((w) => path.basename(w.path)).sort()).toEqual(["dirty", "orphan", "recent", "running"]);
  });

  it("won't remove a worktree that changed after the dry run", async () => {
    addWorktree("late");
    const plan = await s.planCleanup(policy, opts());
    expect(plan.items.map((i) => path.basename(i.path))).toContain("late");
    fs.writeFileSync(path.join(wt("late"), "new.txt"), "fresh\n");
    const r = await s.runCleanup({ ...opts(), policy, only: [wt("late")] });
    expect(r.removed).toEqual([]);
    expect(fs.existsSync(path.join(wt("late"), "new.txt"))).toBe(true);
  });

  it("sweeps attachments past the setting, and none when it's off", async () => {
    const d = path.join(attachRoot, "2026-08-01-mid");
    fs.mkdirSync(d);
    const t = new Date(Date.now() - 20 * DAY);
    fs.utimesSync(d, t, t);
    expect(await s.sweepAttachments({ root: attachRoot, days: "off" })).toBe(0);
    expect(await s.sweepAttachments({ root: attachRoot, days: "30" })).toBe(0);
    expect(await s.sweepAttachments({ root: attachRoot, days: "14" })).toBe(1);
    expect(fs.existsSync(d)).toBe(false);
  });
});

describe("the daily cleanup", () => {
  it("runs only with a policy on, then not again within a day", async () => {
    live.rows = [{ cwd: wt("running"), mtime: Date.now(), terminal: null, web: { status: "running" } }];
    const set = (settings: object) => fs.writeFileSync(process.env.AGENT_U_SETTINGS!, JSON.stringify({ settings, updatedAt: Math.random() }));
    set({ worktreeCleanupDays: "off", attachmentCleanupDays: "off" });
    expect(await s.dailyCleanup(LATER)).toBeNull();
    set({ worktreeCleanupDays: "7" });
    const first = await s.dailyCleanup(LATER);
    expect(first).not.toBeNull();
    expect(first!.removed.map((i) => path.basename(i.path))).toEqual(["recent"]);
    expect(await s.dailyCleanup(LATER + 60_000)).toBeNull();
    expect((await s.storageReport({ ...opts(), fresh: true })).lastCleanup).toMatchObject({ at: LATER, removed: 1 });
    expect(await s.dailyCleanup(LATER + 2 * DAY)).not.toBeNull();
  });
});
