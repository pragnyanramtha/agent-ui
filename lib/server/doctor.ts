import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AGENT_IDS, type AgentId } from "@/lib/types";
import { childEnv } from "./child-env";
import { WORKTREE_ROOT } from "./git";
import { allProfiles, type ResolvedProfile } from "./profiles";
import { PUSH_PATH } from "./push";

/* Health check: what a failed turn on the phone usually comes down to (a missing or broken CLI, a signed-out
 * account, the terminal service down, a full disk). Every check is bounded, reads only, never starts a turn and
 * never reports a secret: commands run with stdin closed and are killed after the timeout. */

export type CheckStatus = "ok" | "warn" | "fail" | "unknown";
export type Check = { id: string; label: string; status: CheckStatus; detail: string; fix?: string; group: "agents" | "system" };
export type DoctorReport = { checks: Check[]; at: number; ms: number };

export type DoctorOptions = {
  profiles?: ResolvedProfile[];
  timeoutMs?: number;
  ptyPort?: number;
  ptyTimeoutMs?: number;
  home?: string;
  worktreeRoot?: string;
  pushPath?: string;
};

const RANK: Record<CheckStatus, number> = { ok: 0, unknown: 1, warn: 2, fail: 3 };
const worst = (...s: CheckStatus[]) => s.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "ok" as CheckStatus);

/* ── running a command, bounded ─────────────────────────── */

export type RunResult = { code: number | null; out: string; err: string; timedOut: boolean; missing: boolean };

/** Runs `bin args` with stdin closed; kills the whole process group after `timeoutMs`. Never rejects. */
export function run(bin: string, args: string[], o: { env?: NodeJS.ProcessEnv; timeoutMs?: number; cwd?: string } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let done = false;
    const finish = (r: Omit<RunResult, "out" | "err">) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ...r, out, err });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env: o.env ?? childEnv(), cwd: o.cwd ?? os.homedir(), detached: true });
    } catch {
      return resolve({ code: null, out, err, timedOut: false, missing: true });
    }
    const cap = (s: string, chunk: Buffer) => (s.length > 16_384 ? s : s + chunk.toString("utf8"));
    child.stdout?.on("data", (c: Buffer) => (out = cap(out, c)));
    child.stderr?.on("data", (c: Buffer) => (err = cap(err, c)));
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      finish({ code: null, timedOut: true, missing: false });
    }, o.timeoutMs ?? 2000);
    child.on("error", (e: NodeJS.ErrnoException) => finish({ code: null, timedOut: false, missing: e.code === "ENOENT" || e.code === "EACCES" }));
    child.on("close", (code) => finish({ code, timedOut: false, missing: false }));
  });
}

/** Resolves with `fallback` if `p` takes longer than `ms` (statfs on a dead network mount, a stuck socket). */
const bounded = <T>(p: Promise<T>, ms: number, fallback: T) =>
  new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      () => (clearTimeout(t), resolve(fallback)),
    );
  });

const SECRET_KEY = /KEY|TOKEN|SECRET|PASSWORD|AUTH/i;

/** First non-empty line, short, with any of the profile's secret values blanked out. */
export function firstLine(text: string, secrets: string[] = []) {
  let line = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  for (const s of secrets) if (s.length >= 4) line = line.split(s).join("••••••");
  /* strip ANSI colours some CLIs print even without a tty */
  line = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

/* ── agent profiles ─────────────────────────────────────── */

const DEFAULT_BIN: Record<AgentId, string> = { claude: "claude", codex: "codex", opencode: "opencode", cursor: "cursor-agent", devin: "devin", kimi: "kimi", gemini: "gemini", antigravity: "agy" };

const INSTALL: Partial<Record<AgentId, string>> = {
  claude: "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
  opencode: "npm install -g opencode-ai",
  cursor: "curl https://cursor.com/install -fsS | bash",
  gemini: "npm install -g @google/gemini-cli",
};

/* what to run after the binary to sign in; "" opens the CLI, which asks on first run */
const LOGIN: Record<AgentId, string> = { claude: "", codex: "login", opencode: "auth login", cursor: "login", devin: "", kimi: "", gemini: "", antigravity: "" };

/* where an agent keeps its login; safe to show in a fix command (paths, never keys) */
const STORE_VARS = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GEMINI_CLI_HOME", "CURSOR_CONFIG_DIR", "KIMI_CODE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "HOME"];

const quote = (s: string) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The profile's sign-in command, with the store folders it points at (so the login lands in the right account). */
export function loginCommand(p: ResolvedProfile) {
  const vars = STORE_VARS.filter((k) => p.env[k] && !SECRET_KEY.test(k)).map((k) => `${k}=${quote(p.env[k])}`);
  return [...vars, quote(p.bin || DEFAULT_BIN[p.agent]), LOGIN[p.agent]].filter(Boolean).join(" ");
}

function isExec(p: string) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The binary the profile would run: its own PATH first when its env sets one, else what profiles.ts found. */
export function profileBinary(p: ResolvedProfile): string | null {
  const bin = p.bin || DEFAULT_BIN[p.agent];
  if (p.env.PATH && !path.isAbsolute(bin) && !bin.includes("/")) {
    for (const dir of p.env.PATH.split(path.delimiter).filter(Boolean)) {
      const full = path.join(dir, bin);
      if (isExec(full)) return full;
    }
  }
  return p.binPath;
}

const exists = (f: string) => {
  try {
    return fs.statSync(f).isFile();
  } catch {
    return false;
  }
};

type Login = { status: CheckStatus; detail: string; fix?: string };

async function loginHint(p: ResolvedProfile, bin: string | null, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<Login> {
  const has = (...keys: string[]) => keys.find((k) => env[k]?.trim());
  const home = env.HOME || os.homedir();
  const signIn = (): Login => ({ status: "warn", detail: "Not signed in", fix: loginCommand(p) });
  const unknown: Login = { status: "unknown", detail: "Sign-in unknown" };
  switch (p.agent) {
    case "claude": {
      const key = has("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN");
      if (key) return { status: "ok", detail: `${key} set` };
      if (has("CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX")) return { status: "ok", detail: "Cloud provider set" };
      const dir = env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
      return exists(path.join(dir, ".credentials.json")) ? { status: "ok", detail: "Signed in" } : signIn();
    }
    case "codex": {
      if (!bin) return unknown;
      const r = await run(bin, [...p.args, "login", "status"], { env, timeoutMs });
      if (r.timedOut || r.missing) return unknown;
      return r.code === 0 ? { status: "ok", detail: "Signed in" } : signIn();
    }
    case "gemini": {
      const key = has("GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI");
      if (key) return { status: "ok", detail: `${key} set` };
      const root = path.join(env.GEMINI_CLI_HOME || home, ".gemini");
      return exists(path.join(root, "oauth_creds.json")) ? { status: "ok", detail: "Signed in" } : signIn();
    }
    case "cursor": {
      if (has("CURSOR_API_KEY")) return { status: "ok", detail: "CURSOR_API_KEY set" };
      if (!bin) return unknown;
      const r = await run(bin, ["status"], { env, timeoutMs });
      if (r.timedOut || r.missing) return unknown;
      const text = `${r.out}\n${r.err}`;
      if (r.code === 0 && !/not (logged|signed) in|unauthenticated|not authenticated/i.test(text)) return { status: "ok", detail: "Signed in" };
      return signIn();
    }
    default:
      return unknown;
  }
}

/** One row per profile: which binary, whether `--version` answers, and a sign-in hint when one is cheap to get. */
export async function checkProfile(p: ResolvedProfile, timeoutMs = 2000): Promise<Check> {
  const base = { id: `profile:${p.id}`, label: p.label, group: "agents" as const };
  const bin = profileBinary(p);
  const secrets = Object.entries(p.env)
    .filter(([k]) => SECRET_KEY.test(k))
    .map(([, v]) => v);
  const env = childEnv(p.env);
  if (!bin) {
    const name = p.bin || DEFAULT_BIN[p.agent];
    const install = p.bin && path.isAbsolute(p.bin) ? undefined : INSTALL[p.agent];
    /* the Agent SDK carries its own Claude Code, so web turns work without one on PATH */
    if (p.agent === "claude" && !p.bin) {
      const login = await loginHint(p, null, env, timeoutMs);
      return { ...base, status: "warn", detail: `Not on PATH, web turns use the bundled copy · ${login.detail}`, ...(install ? { fix: install } : {}) };
    }
    /* a built-in nobody configured is just an agent this server doesn't use */
    const untouched = p.builtin && AGENT_IDS.includes(p.id as AgentId) && !p.bin && !Object.keys(p.env).length && !p.args.length;
    return { ...base, status: untouched ? "unknown" : "fail", detail: untouched ? "Not installed" : `${name} not found`, ...(install ? { fix: install } : {}) };
  }
  const [ver, login] = await Promise.all([run(bin, [...p.args, "--version"], { env, timeoutMs }), loginHint(p, bin, env, timeoutMs)]);
  const parts = [bin];
  let status: CheckStatus = "ok";
  let fix: string | undefined;
  if (ver.missing) {
    status = "fail";
    parts.push("Can't run it");
  } else if (ver.timedOut) {
    status = "warn";
    parts.push(`No answer to --version in ${Math.round(timeoutMs / 100) / 10}s`);
  } else if (ver.code !== 0) {
    status = "fail";
    const why = firstLine(ver.err || ver.out, secrets);
    parts.push(`--version failed (exit ${ver.code})${why ? `: ${why}` : ""}`);
  } else {
    parts.push(firstLine(ver.out || ver.err, secrets) || "Runs");
  }
  if (status !== "fail") {
    parts.push(login.detail);
    status = worst(status, login.status === "unknown" ? "ok" : login.status);
    fix = login.fix;
  }
  return { ...base, status, detail: parts.join(" · "), ...(fix ? { fix } : {}) };
}

/* ── the server ─────────────────────────────────────────── */

type Tool = { id: string; label: string; bin: string; args: string[]; missing: CheckStatus; why: string; fix?: string };

async function checkTool(t: Tool, timeoutMs: number): Promise<Check> {
  const base = { id: `tool:${t.id}`, label: t.label, group: "system" as const };
  const r = await run(t.bin, t.args, { timeoutMs });
  if (r.missing) return { ...base, status: t.missing, detail: `Not installed. ${t.why}`, ...(t.fix ? { fix: t.fix } : {}) };
  if (r.timedOut) return { ...base, status: "warn", detail: `No answer in ${Math.round(timeoutMs / 100) / 10}s` };
  if (r.code !== 0) return { ...base, status: "warn", detail: firstLine(r.err || r.out) || `Exit ${r.code}` };
  return { ...base, status: "ok", detail: firstLine(r.out || r.err) };
}

const TOOLS: Tool[] = [
  { id: "tmux", label: "tmux", bin: "tmux", args: ["-V"], missing: "warn", why: "Agents started here stop when the terminal service restarts.", fix: "sudo apt install -y tmux" },
  { id: "zellij", label: "zellij", bin: "zellij", args: ["--version"], missing: "ok", why: "Optional." },
  { id: "python3", label: "Python 3", bin: "python3", args: ["--version"], missing: "fail", why: "The web terminal needs it.", fix: "sudo apt install -y python3" },
  { id: "git", label: "git", bin: "git", args: ["--version"], missing: "fail", why: "Checkpoints, rewind and commits need it.", fix: "sudo apt install -y git" },
  { id: "gh", label: "GitHub CLI", bin: "gh", args: ["--version"], missing: "warn", why: "Pull requests need it.", fix: "sudo apt install -y gh" },
];

/** GET the terminal service's own list (signed like the app's calls), so a wrong secret shows up too. */
export function checkTerminalService(port: number, timeoutMs = 1000): Promise<Check> {
  const base = { id: "pty", label: "Terminal service", group: "system" as const };
  const restart = "systemctl --user restart agent-u-pty";
  const key = createHmac("sha256", process.env.UI_SECRET ?? "").update("agent-u pty internal").digest("base64url");
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/internal/terminals", headers: { "x-agent-u-internal": key }, timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => body.length < 65_536 && (body += c));
      res.on("end", () => {
        if (res.statusCode === 200) {
          let n: number | null = null;
          try {
            const d = JSON.parse(body) as { terminals?: unknown[] };
            n = Array.isArray(d.terminals) ? d.terminals.length : null;
          } catch {}
          resolve({ ...base, status: "ok", detail: `Port ${port}${n === null ? "" : ` · ${n} running`}` });
        } else if (res.statusCode === 401) {
          resolve({ ...base, status: "fail", detail: `Port ${port} answers but rejects the app. Both services need the same UI_SECRET.`, fix: "systemctl --user restart agent-u agent-u-pty" });
        } else {
          resolve({ ...base, status: "warn", detail: `Port ${port} answered ${res.statusCode}`, fix: restart });
        }
      });
      res.on("error", () => resolve({ ...base, status: "fail", detail: `Port ${port} dropped the connection`, fix: restart }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e: NodeJS.ErrnoException) =>
      resolve({ ...base, status: "fail", detail: e.code === "ECONNREFUSED" ? `Nothing on port ${port}` : e.message === "timeout" ? `No answer on port ${port}` : `Port ${port}: ${e.code ?? e.message}`, fix: restart }),
    );
  });
}

/** Push keys and how many browsers subscribed; read straight from the file so a check never creates keys. */
export function checkPush(file = PUSH_PATH): Check {
  const base = { id: "push", label: "Notifications", group: "system" as const };
  let raw: { publicKey?: unknown; privateKey?: unknown; subs?: unknown } | null = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return { ...base, status: "fail", detail: "Push settings can't be read" };
  }
  if (!raw || !raw.publicKey || !raw.privateKey) return { ...base, status: "unknown", detail: "Not set up. Turn them on in Settings." };
  const n = Array.isArray(raw.subs) ? raw.subs.length : 0;
  if (!n) return { ...base, status: "warn", detail: "Keys ready, no device subscribed. Turn them on in Settings." };
  return { ...base, status: "ok", detail: `${n} ${n === 1 ? "device" : "devices"} subscribed` };
}

const GB = 1024 ** 3;
const size = (b: number) => (b >= 100 * GB ? `${Math.round(b / GB)} GB` : b >= GB ? `${(b / GB).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`);

/** The folder itself, or the nearest parent that exists (the worktree root appears on first use). */
function existing(dir: string) {
  let d = path.resolve(dir);
  while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  return d;
}

export async function checkDisk(dirs: { id: string; label: string; dir: string }[]): Promise<Check[]> {
  const seen = new Map<number, string>();
  const out: Check[] = [];
  for (const { id, label, dir } of dirs) {
    const base = { id: `disk:${id}`, label, group: "system" as const };
    const at = existing(dir);
    let dev: number;
    try {
      dev = fs.statSync(at).dev;
    } catch {
      out.push({ ...base, status: "unknown", detail: "Can't read" });
      continue;
    }
    /* one row per filesystem */
    if (seen.has(dev)) continue;
    seen.set(dev, id);
    try {
      const s = await fs.promises.statfs(at);
      const free = s.bavail * s.bsize;
      const total = s.blocks * s.bsize;
      const pct = total ? Math.round((free / total) * 100) : 0;
      const status: CheckStatus = free < 0.5 * GB ? "fail" : free < 2 * GB || pct < 5 ? "warn" : "ok";
      out.push({ ...base, status, detail: `${size(free)} free of ${size(total)} (${pct}%)` });
    } catch {
      out.push({ ...base, status: "unknown", detail: "Can't read" });
    }
  }
  return out;
}

/* ── all of it ──────────────────────────────────────────── */

export async function runDoctor(o: DoctorOptions = {}): Promise<DoctorReport> {
  const t0 = Date.now();
  const timeoutMs = o.timeoutMs ?? 2000;
  const profiles = o.profiles ?? allProfiles();
  const failed = (id: string, label: string, group: Check["group"]): Check => ({ id, label, group, status: "unknown", detail: "Check didn't finish" });
  /* a ceiling over each check's own timeouts, so one stuck check can't hold the rest */
  const cap = timeoutMs + 500;
  const home = o.home ?? os.homedir();
  const homeLabel = "Disk space";
  const [agents, tools, pty, disk] = await Promise.all([
    Promise.all(profiles.map((p) => bounded(checkProfile(p, timeoutMs), cap, failed(`profile:${p.id}`, p.label, "agents")))),
    Promise.all(TOOLS.map((t) => bounded(checkTool(t, timeoutMs), cap, failed(`tool:${t.id}`, t.label, "system")))),
    bounded(checkTerminalService(o.ptyPort ?? Number(process.env.PTY_PORT ?? 3312), o.ptyTimeoutMs ?? 1000), cap, failed("pty", "Terminal service", "system")),
    bounded(
      checkDisk([
        { id: "home", label: homeLabel, dir: home },
        { id: "worktrees", label: "Disk space (worktrees)", dir: o.worktreeRoot ?? WORKTREE_ROOT },
      ]),
      cap,
      [failed("disk:home", homeLabel, "system")],
    ),
  ]);
  const tmux = tools.find((t) => t.id === "tool:tmux");
  const zellij = tools.find((t) => t.id === "tool:zellij");
  /* zellij only matters when tmux is missing too */
  if (tmux?.status !== "ok" && zellij && /^Not installed/.test(zellij.detail)) zellij.status = "warn";
  let push: Check;
  try {
    push = checkPush(o.pushPath);
  } catch {
    push = failed("push", "Notifications", "system");
  }
  return { checks: [...agents, pty, ...tools, push, ...disk], at: Date.now(), ms: Date.now() - t0 };
}
