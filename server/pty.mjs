/* Web terminal backend on 127.0.0.1:3312. Cloudflare routes /pty here.
 *
 * WebSocket /pty (same login as the app: the signed cui_session cookie and a same-origin check):
 *   ?term=<id>&since=<n>  reattach to a terminal this server keeps (output after byte n is replayed)
 *   ?tmux=<name>          attach to a tmux session (agents launched from the web live in tmux)
 *   ?pid= / ?session=     attach to the zellij/tmux a running CLI / Claude session lives in
 *   ?cwd=<abs>            a new login shell, kept running when the socket drops
 * Binary frames carry terminal bytes both ways; text frames are JSON control messages
 * (client: input, resize; server: hello, reset, exit).
 *
 * HTTP /internal/* is for the Next app only (header x-agent-u-internal, an HMAC of UI_SECRET):
 * list, launch and kill terminals. */

import { spawn, execFileSync } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

/* the env files the Next app reads, parsed the same way ($VAR expansion, comments), so UI_SECRET matches */
try {
  const nextPkg = createRequire(import.meta.url).resolve("next/package.json");
  createRequire(nextPkg)("@next/env").loadEnvConfig(root, process.env.NODE_ENV !== "production", { info() {}, error() {} });
} catch {
  try {
    for (const line of fs.readFileSync(path.join(root, ".env.local"), "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* env from the service unit only */
  }
}

const PORT = Number(process.env.PTY_PORT ?? 3312);
const MAX_SOCKETS = 24;
const MAX_TERMINALS = 24;
/** output kept per terminal for replay on reattach */
const BUFFER_BYTES = 2 * 1024 * 1024;
/** shells nobody is looking at are closed after this long */
const SHELL_IDLE_MS = Number(process.env.SHELL_IDLE_MS ?? 12 * 3600_000);
/** finished terminals stay listed (with their output) this long */
const EXITED_KEEP_MS = 30 * 60_000;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERM_ID = /^[a-z0-9]{6,32}$/;
const TMUX_NAME = /^[A-Za-z0-9._@-]{1,80}$/;
const TMUX_PREFIX = "agentu-";

const SECRET = process.env.UI_SECRET ?? "";
if (SECRET.length < 32) throw new Error("UI_SECRET must be set to at least 32 characters");
const CLAUDE_HOME = process.env.CLAUDE_HOME ?? path.join(os.homedir(), ".claude");
const INTERNAL_KEY = createHmac("sha256", SECRET).update("agent-u pty internal").digest("base64url");

const which = (bin) => {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = path.join(dir || ".", bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return null;
};
const TMUX = which("tmux");
/* a tmux server started from this service would live in its cgroup and die on restart; give it its own scope */
const SYSTEMD_RUN = process.env.INVOCATION_ID && which("systemd-run") ? which("systemd-run") : null;

function validCookie(header) {
  const raw = /(?:^|;\s*)cui_session=([^;]+)/.exec(header ?? "")?.[1];
  if (!raw) return false;
  let value;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return false;
  }
  const [expires, sig, extra] = value.split(".");
  if (!/^\d+$/.test(expires ?? "") || !sig || extra !== undefined || Number(expires) < Date.now()) return false;
  const want = createHmac("sha256", SECRET).update(expires).digest("base64url");
  return want.length === sig.length && timingSafeEqual(Buffer.from(want), Buffer.from(sig));
}

function sameOrigin(req) {
  try {
    const origin = new URL(req.headers.origin ?? "").host;
    const hosts = [req.headers.host, String(req.headers["x-forwarded-host"] ?? "").split(",")[0].trim()].filter(Boolean);
    return hosts.includes(origin);
  } catch {
    return false;
  }
}

const envOf = (pid, key) => {
  try {
    const m = new RegExp(`(?:^|\0)${key}=([^\0]*)`).exec(fs.readFileSync(`/proc/${pid}/environ`, "utf8"));
    return m?.[1] || null;
  } catch {
    return null;
  }
};
const ppidOf = (pid) => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  } catch {
    return 0;
  }
};

const procStart = (pid) => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
};

/** Attach command for the zellij/tmux a process runs in (walking up its parents), or null. */
function attachForPid(start) {
  for (let pid = start, depth = 0; pid > 1 && depth < 6; pid = ppidOf(pid), depth++) {
    const zellij = envOf(pid, "ZELLIJ_SESSION_NAME");
    if (zellij) return ["zellij", "attach", zellij];
    const pane = envOf(pid, "TMUX_PANE");
    if (pane) {
      /* the pane may live on another tmux server (-L/-S, TMUX_TMPDIR): its socket is the first field of $TMUX */
      const sock = (envOf(pid, "TMUX") ?? "").split(",")[0];
      const via = sock ? ["-S", sock] : [];
      try {
        const name = execFileSync(TMUX ?? "tmux", [...via, "display-message", "-p", "-t", pane, "#S"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
        return name ? ["tmux", ...via, "attach-session", "-t", `=${name}`] : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** The multiplexer attach command for the terminal a Claude session is open in, or null. */
function attachForSession(sessionId) {
  const dir = path.join(CLAUDE_HOME, "sessions");
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((x) => x.endsWith(".json"));
  } catch {
    return null;
  }
  for (const f of files) {
    let info;
    try {
      info = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    } catch {
      continue;
    }
    if (info.sessionId !== sessionId || !Number.isInteger(info.pid) || !fs.existsSync(`/proc/${info.pid}`)) continue;
    /* a recycled pid is someone else's process */
    if (info.procStart && procStart(info.pid) !== String(info.procStart)) continue;
    const cmd = attachForPid(info.pid);
    if (cmd) return cmd;
  }
  return null;
}

/* ── tmux ─────────────────────────────────────────────────── */

const tmux = (args) => execFileSync(TMUX, args, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
const tmuxHas = (name) => {
  if (!TMUX) return false;
  try {
    tmux(["has-session", "-t", `=${name}`]);
    return true;
  } catch {
    return false;
  }
};

const META = ["label", "kind", "cwd", "profile", "session", "created"];
function tmuxList() {
  if (!TMUX) return [];
  let out = "";
  try {
    const fmt = ["#{session_name}", "#{session_attached}", "#{pane_dead}", "#{pane_dead_status}", "#{pane_pid}", ...META.map((k) => `#{@agentu_${k}}`)].join("\t");
    out = tmux(["list-panes", "-a", "-F", fmt]);
  } catch {
    return [];
  }
  const seen = new Set();
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"))
    .filter(([name]) => name.startsWith(TMUX_PREFIX) && !seen.has(name) && seen.add(name))
    .map(([name, attached, dead, deadStatus, pid, ...meta]) => {
      const m = Object.fromEntries(META.map((k, i) => [k, meta[i] ?? ""]));
      return {
        id: name,
        backing: "tmux",
        tmux: name,
        kind: m.kind || "agent",
        label: m.label || name,
        cwd: m.cwd || "",
        profile: m.profile || null,
        session: m.session || null,
        createdAt: Number(m.created) || 0,
        clients: Number(attached) || 0,
        pid: Number(pid) || null,
        exited: dead === "1" ? { code: Number(deadStatus) || 0 } : null,
      };
    });
}

const shellQuote = (s) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
const LOGIN_SHELL = process.env.SHELL || "/bin/bash";
/** through a login shell, so the agent sees the same PATH and profile as an ssh session */
const loginArgv = (cmd, args) => [LOGIN_SHELL, "-lc", `exec ${[cmd, ...args].map(shellQuote).join(" ")}`];

function tmuxLaunch({ cmd, args, env, cwd, label, kind, profile, session, cols, rows }) {
  const name = `${TMUX_PREFIX}${randomBytes(4).toString("hex")}`;
  const line = loginArgv(cmd, args).map(shellQuote).join(" ");
  /* the pane starts with remain-on-exit already set (via the chained commands), so a crash at startup stays readable */
  const argv = ["new-session", "-d", "-s", name, "-x", String(cols), "-y", String(rows), "-c", cwd];
  for (const [k, v] of Object.entries(env)) argv.push("-e", `${k}=${v}`);
  argv.push(line);
  const meta = { label, kind, cwd, profile, session, created: Date.now() };
  for (const [k, v] of Object.entries(meta)) if (v !== undefined && v !== null && v !== "") argv.push(";", "set-option", `@agentu_${k}`, String(v));
  /* phones can't spare a status bar's worth of rows; the mouse wheel scrolls tmux history */
  argv.push(";", "set-option", "-w", "remain-on-exit", "on", ";", "set-option", "status", "off", ";", "set-option", "mouse", "on");
  const [bin, all] = SYSTEMD_RUN ? [SYSTEMD_RUN, ["--user", "--scope", "--quiet", "--collect", TMUX, ...argv]] : [TMUX, argv];
  execFileSync(bin, all, { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TERM: "xterm-256color" } });
  return name;
}

/* ── kept terminals (a pty this server owns) ──────────────── */

/** @type {Map<string, any>} */
const terms = new Map();

/* started from inside tmux/zellij (dev), attaching would be refused as nesting */
const NESTING = ["TMUX", "TMUX_PANE", "ZELLIJ", "ZELLIJ_SESSION_NAME", "ZELLIJ_PANE_ID"];
const EXTRA_PATH = [".local/bin", ".cargo/bin", ".npm-global/bin", ".local/npm-global/bin", ".bun/bin", ".opencode/bin"].map((d) => path.join(os.homedir(), d));

function bridge(cmd, { cwd, env, cols, rows }) {
  const base = { ...process.env };
  for (const k of NESTING) delete base[k];
  base.PATH = [...new Set([...(base.PATH ?? "").split(":").filter(Boolean), ...EXTRA_PATH, "/usr/local/bin", "/usr/bin", "/bin"])].join(":");
  return spawn("python3", [path.join(here, "pty_bridge.py"), ...cmd], {
    cwd,
    env: { ...base, ...env, TERM: "xterm-256color", COLORTERM: "truecolor", PTY_COLS: String(cols), PTY_ROWS: String(rows) },
    stdio: ["pipe", "pipe", "ignore", "pipe"],
  });
}

function createTerm({ cmd, cwd, env = {}, cols, rows, label, kind, profile = null, session = null }) {
  const id = randomBytes(6).toString("hex");
  const child = bridge(cmd, { cwd, env, cols, rows });
  const t = {
    id,
    backing: "pty",
    kind,
    label,
    cwd,
    profile,
    session,
    createdAt: Date.now(),
    child,
    ctl: child.stdio[3],
    chunks: [],
    size: 0,
    /** total bytes ever written; replay offsets are in this space */
    seq: 0,
    clients: new Set(),
    lastSeen: Date.now(),
    exited: null,
    cols,
    rows,
  };
  child.stdin.on("error", () => undefined);
  t.ctl.on("error", () => undefined);
  child.stdout.on("data", (chunk) => {
    t.chunks.push(chunk);
    t.size += chunk.length;
    t.seq += chunk.length;
    while (t.size > BUFFER_BYTES && t.chunks.length > 1) t.size -= t.chunks.shift().length;
    for (const ws of t.clients) sendBytes(ws, chunk);
  });
  const finish = (code) => {
    if (t.exited) return;
    t.exited = { code: code ?? 0, at: Date.now() };
    for (const ws of t.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      ws.send(JSON.stringify({ type: "exit", code: t.exited.code }));
      ws.close(1000, "exited");
    }
    /* a closed shell has nothing worth keeping; an agent's last words do */
    if (kind === "shell") terms.delete(id);
  };
  child.on("exit", (code) => finish(code));
  child.on("error", () => finish(127));
  terms.set(id, t);
  return t;
}

function resize(t, cols, rows) {
  t.cols = cols;
  t.rows = rows;
  if (!t.exited) t.ctl.write(`${cols} ${rows}\n`);
}

function killTerm(t) {
  if (!t.exited) t.child.kill("SIGHUP");
  setTimeout(() => t.child.exitCode === null && t.child.kill("SIGKILL"), 3000).unref();
  terms.delete(t.id);
}

const reaper = setInterval(() => {
  const now = Date.now();
  for (const t of terms.values()) {
    if (t.clients.size) continue;
    if (t.exited && now - t.exited.at > EXITED_KEEP_MS) terms.delete(t.id);
    else if (!t.exited && t.kind === "shell" && now - t.lastSeen > SHELL_IDLE_MS) killTerm(t);
  }
}, 60_000);
reaper.unref();

const describe = (t) => ({
  id: t.id,
  backing: t.backing,
  kind: t.kind,
  label: t.label,
  cwd: t.cwd,
  profile: t.profile,
  session: t.session,
  createdAt: t.createdAt,
  clients: t.clients.size,
  pid: t.child.pid ?? null,
  exited: t.exited ? { code: t.exited.code } : null,
});

/* ── sockets ──────────────────────────────────────────────── */

let sockets = 0;

const clamp = (n, lo, hi, d) => (Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n | 0)) : d);
const sendJson = (ws, msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));

/* A socket this far behind (a phone on a weak link under a flood of output) is dropped instead of buffering without
 * bound; the client reconnects at once and catches up from the replay buffer (an attach redraws its screen). */
const BEHIND_BYTES = 4 * 1024 * 1024;
function sendBytes(ws, chunk) {
  if (ws.readyState !== ws.OPEN) return;
  if (ws.bufferedAmount > BEHIND_BYTES) return ws.close(4090, "Reconnecting…");
  ws.send(chunk, { binary: true });
}

/** text frames are JSON control/input; binary frames are raw input */
function onClientMessage(ws, raw, isBinary, write, onResize) {
  if (isBinary) return write(raw);
  try {
    const msg = JSON.parse(String(raw));
    if (msg.type === "input" && typeof msg.data === "string") write(msg.data);
    else if (msg.type === "resize") onResize(clamp(msg.cols, 10, 500, 100), clamp(msg.rows, 5, 200, 30));
  } catch {
    /* ignore malformed frames */
  }
}

/** Cloudflare drops idle sockets; ping, and drop sockets that stopped answering */
function keepAlive(ws) {
  let alive = true;
  ws.on("pong", () => (alive = true));
  const timer = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    if (ws.readyState === ws.OPEN) ws.ping();
  }, 20_000);
  ws.on("close", () => clearInterval(timer));
}

function attachKept(ws, t, since, cols, rows) {
  t.clients.add(ws);
  t.lastSeen = Date.now();
  /* replay what this client hasn't seen; a client too far behind starts over from what's kept.
   * `offset` tells the client where the bytes it gets next start, so its next `since` is exact */
  const start = t.seq - t.size;
  let from = Number.isFinite(since) && since >= 0 ? since : 0;
  if (from > t.seq) from = 0;
  const reset = from < start && from > 0;
  if (from < start) from = start;
  sendJson(ws, { type: "hello", id: t.id, kind: t.kind, label: t.label, cwd: t.cwd, backing: "pty", persistent: true, offset: from });
  if (reset) sendJson(ws, { type: "reset" });
  let skip = from - start;
  for (const c of t.chunks) {
    if (skip >= c.length) {
      skip -= c.length;
      continue;
    }
    ws.send(skip ? c.subarray(skip) : c, { binary: true });
    skip = 0;
  }
  if (t.exited) {
    sendJson(ws, { type: "exit", code: t.exited.code });
    ws.close(1000, "exited");
    return;
  }
  const changed = cols !== t.cols || rows !== t.rows;
  resize(t, cols, rows);
  /* full-screen programs redraw on SIGWINCH; nudge one when nothing changed so a fresh screen isn't blank */
  if (!changed && since === 0) {
    resize(t, cols, Math.max(5, rows - 1));
    setTimeout(() => resize(t, cols, rows), 60);
  }
  ws.on("message", (raw, isBinary) =>
    onClientMessage(
      ws,
      raw,
      isBinary,
      (d) => !t.exited && t.child.stdin.write(d),
      (c, r) => resize(t, c, r),
    ),
  );
  ws.on("close", () => {
    t.clients.delete(ws);
    t.lastSeen = Date.now();
  });
}

/** One attach process per socket (tmux/zellij keep the session itself). */
function attachOnce(ws, cmd, cols, rows, hello) {
  const child = bridge(cmd, { cwd: os.homedir(), env: {}, cols, rows });
  const ctl = child.stdio[3];
  child.stdin.on("error", () => undefined);
  ctl.on("error", () => undefined);
  sendJson(ws, { type: "hello", ...hello, persistent: false });
  child.stdout.on("data", (chunk) => sendBytes(ws, chunk));
  child.on("exit", (code) => {
    sendJson(ws, { type: "exit", code: code ?? 0 });
    if (ws.readyState === ws.OPEN) ws.close(1000, "exited");
  });
  child.on("error", (err) => ws.readyState === ws.OPEN && ws.close(4500, `Couldn't start the terminal: ${err.code ?? err.message}`.slice(0, 120)));
  ws.on("message", (raw, isBinary) =>
    onClientMessage(
      ws,
      raw,
      isBinary,
      (d) => child.stdin.write(d),
      (c, r) => ctl.write(`${c} ${r}\n`),
    ),
  );
  ws.on("close", () => {
    child.stdin.end();
    setTimeout(() => child.exitCode === null && child.kill("SIGTERM"), 2000).unref();
  });
}

function start(ws, url) {
  const q = url.searchParams;
  const cols = clamp(Number(q.get("cols")), 10, 500, 100);
  const rows = clamp(Number(q.get("rows")), 5, 200, 30);
  sockets++;
  ws.on("close", () => sockets--);
  keepAlive(ws);

  const termId = q.get("term");
  if (termId) {
    const t = TERM_ID.test(termId) ? terms.get(termId) : null;
    if (!t) return ws.close(4404, "That terminal has ended.");
    return attachKept(ws, t, Number(q.get("since") ?? 0), cols, rows);
  }
  const name = q.get("tmux");
  if (name) {
    if (!TMUX_NAME.test(name) || !tmuxHas(name)) return ws.close(4404, "That terminal has ended.");
    const info = tmuxList().find((x) => x.tmux === name);
    return attachOnce(ws, ["tmux", "attach-session", "-t", `=${name}`], cols, rows, { id: name, kind: info?.kind ?? "tmux", label: info?.label ?? name, cwd: info?.cwd ?? "", backing: "tmux" });
  }
  const pid = Number(q.get("pid"));
  if (Number.isInteger(pid) && pid > 1 && fs.existsSync(`/proc/${pid}`)) {
    const cmd = attachForPid(pid);
    if (!cmd) return ws.close(4404, "This session can't be opened in a terminal.");
    return attachOnce(ws, cmd, cols, rows, { id: `pid-${pid}`, kind: "attach", label: cmd.slice(-1)[0], cwd: "", backing: cmd[0] });
  }
  const session = q.get("session");
  if (session) {
    const cmd = SESSION_ID.test(session) ? attachForSession(session) : null;
    if (!cmd) return ws.close(4404, "This session isn't open in a terminal.");
    return attachOnce(ws, cmd, cols, rows, { id: `session-${session}`, kind: "attach", label: cmd.slice(-1)[0], cwd: "", backing: cmd[0] });
  }
  if (terms.size >= MAX_TERMINALS) return ws.close(4429, "Too many terminals are open. Close one first.");
  const want = q.get("cwd");
  const cwd = want && path.isAbsolute(want) && fs.existsSync(want) && fs.statSync(want).isDirectory() ? want : os.homedir();
  const t = createTerm({ cmd: [process.env.SHELL || "/bin/bash", "-l"], cwd, cols, rows, label: `Shell: ${cwd.replace(os.homedir(), "~")}`, kind: "shell" });
  attachKept(ws, t, 0, cols, rows);
}

/* ── internal HTTP API (the Next app) ─────────────────────── */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 256 * 1024) {
        reject(new Error("too large"));
        req.destroy();
      } else parts.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString("utf8") || "{}"));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

const reply = (res, status, body) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));

function internalOk(req) {
  const got = String(req.headers["x-agent-u-internal"] ?? "");
  return got.length === INTERNAL_KEY.length && timingSafeEqual(Buffer.from(got), Buffer.from(INTERNAL_KEY));
}

const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
const strMap = (v) => Object.fromEntries(Object.entries(v && typeof v === "object" ? v : {}).filter(([k, x]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof x === "string"));

async function internal(req, res, url) {
  if (!internalOk(req)) return reply(res, 401, { error: "unauthorized" });
  if (req.method === "GET" && url.pathname === "/internal/terminals") {
    return reply(res, 200, { terminals: [...[...terms.values()].map(describe), ...tmuxList()].sort((a, b) => b.createdAt - a.createdAt), tmux: Boolean(TMUX) });
  }
  if (req.method === "POST" && url.pathname === "/internal/launch") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return reply(res, 400, { error: "Bad request." });
    }
    const cmd = typeof body.cmd === "string" ? body.cmd : "";
    const cwd = typeof body.cwd === "string" && path.isAbsolute(body.cwd) && fs.existsSync(body.cwd) ? body.cwd : null;
    if (!cmd) return reply(res, 400, { error: "No command to run." });
    if (!cwd) return reply(res, 400, { error: body.cwd ? `Folder not found: ${body.cwd}` : "Choose a folder." });
    const spec = {
      cmd,
      args: strList(body.args),
      env: strMap(body.env),
      cwd,
      label: typeof body.label === "string" ? body.label.slice(0, 120) : cmd,
      kind: "agent",
      profile: typeof body.profile === "string" ? body.profile : null,
      session: typeof body.session === "string" ? body.session : null,
      cols: clamp(Number(body.cols), 10, 500, 120),
      rows: clamp(Number(body.rows), 5, 200, 40),
    };
    const useTmux = TMUX && body.backing !== "pty";
    try {
      if (useTmux) return reply(res, 200, { id: tmuxLaunch(spec), backing: "tmux" });
      if (terms.size >= MAX_TERMINALS) return reply(res, 429, { error: "Too many terminals are open. Close one first." });
      const t = createTerm({ ...spec, cmd: loginArgv(spec.cmd, spec.args) });
      return reply(res, 200, { id: t.id, backing: "pty" });
    } catch (err) {
      return reply(res, 500, { error: `Couldn't start: ${String(err?.stderr || err?.message || err).trim().slice(0, 300)}` });
    }
  }
  if (req.method === "POST" && url.pathname === "/internal/kill") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return reply(res, 400, { error: "Bad request." });
    }
    const id = String(body.id ?? "");
    const t = terms.get(id);
    if (t) {
      killTerm(t);
      return reply(res, 200, { ok: true });
    }
    if (id.startsWith(TMUX_PREFIX) && TMUX_NAME.test(id) && tmuxHas(id)) {
      try {
        tmux(["kill-session", "-t", `=${id}`]);
      } catch {
        /* already gone */
      }
      return reply(res, 200, { ok: true });
    }
    return reply(res, 404, { error: "No such terminal." });
  }
  return reply(res, 404, { error: "not found" });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://local");
  if (url.pathname.startsWith("/internal/")) {
    internal(req, res, url).catch((err) => reply(res, 500, { error: String(err?.message ?? err) }));
    return;
  }
  res.writeHead(404).end();
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://local");
  const refuse = (code, msg) => {
    socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };
  if (url.pathname !== "/pty") return refuse(404, "Not Found");
  if (!sameOrigin(req)) return refuse(403, "Bad Origin");
  /* past the origin check, refusals go over the socket: a browser only sees a raw HTTP refusal as a network error */
  const why = !validCookie(req.headers.cookie) ? [4401, "Signed out. Reload to sign in."] : sockets >= MAX_SOCKETS ? [4429, "Too many terminals are open. Close one first."] : null;
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (why) return ws.close(why[0], why[1]);
    try {
      start(ws, url);
    } catch (err) {
      console.error("pty start failed:", err);
      if (ws.readyState === ws.OPEN) ws.close(4500, `The terminal failed to start: ${String(err?.message ?? err)}`.slice(0, 120));
    }
  });
});

const shutdown = () => {
  for (const t of terms.values()) if (!t.exited) t.child.kill("SIGHUP");
  process.exit(0);
};
process.on("SIGTERM", shutdown);
/* one bad request must not take every open shell down with it */
process.on("uncaughtException", (err) => console.error("pty uncaught:", err));
process.on("SIGINT", shutdown);

server.listen(PORT, "127.0.0.1", () => console.log(`pty server on 127.0.0.1:${PORT}${TMUX ? " (tmux available)" : ""}`));
