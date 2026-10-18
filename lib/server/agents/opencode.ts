import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Entry } from "@/lib/types";
import { liveStream, rekeyTurn, startTurn, stopTurn, turnState, type Run } from "./cli-run";
import { activeProfile, profileBin } from "../profiles";
import { changedSince, getSession, historyPage, listSessions, sessionEnd, sessionsSince } from "./opencode-store";
import type { AgentAdapter, AgentSession, CliRunState, SendOptions, StartOptions } from "./types";

/* OpenCode (sst/opencode, >= 1.x). History comes read-only from its SQLite store
 * (see opencode-store.ts); web turns run `opencode run --format json` with the
 * prompt on stdin (positional args get re-quoted by the CLI), tracked by cli-run
 * under "opencode:<sessionId>". */

const POLL_MS = 1000;
/** re-read this far behind the watermark: rows are stamped before their transaction commits */
const SLACK_MS = 5000;
const START_TIMEOUT_MS = 60_000;

/** error text from the JSON stream ({"type":"error"}), which is better than stderr's last line */
const turnErrors = (() => {
  const g = globalThis as typeof globalThis & { __opencodeTurnErrors?: Map<string, string> };
  return (g.__opencodeTurnErrors ??= new Map());
})();

const keyOf = (id: string) => `opencode:${id}`;

let binCache: { path: string | null; at: number } | null = null;

async function binary(): Promise<string | null> {
  if (binCache && Date.now() - binCache.at < 30_000) return binCache.path;
  const home = os.homedir();
  const dirs = [
    ...(process.env.OPENCODE_BIN ? [path.dirname(process.env.OPENCODE_BIN)] : []),
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean),
    path.join(home, ".opencode", "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".npm-global", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ];
  const names = process.env.OPENCODE_BIN ? [path.basename(process.env.OPENCODE_BIN)] : ["opencode"];
  let found: string | null = null;
  outer: for (const dir of dirs) {
    for (const name of names) {
      const p = path.join(dir, name);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        if (fs.statSync(p).isFile()) {
          found = p;
          break outer;
        }
      } catch {}
    }
  }
  binCache = { path: found, at: Date.now() };
  return found;
}

const toSession = (s: { id: string; title: string; directory: string; time_updated: number; model: string | null }): AgentSession => ({
  id: s.id,
  title: s.title.replace(/^New session - \d{4}-\d\d-\d\dT[\d:.]+Z$/, "") || "",
  cwd: s.directory,
  mtime: s.time_updated,
  size: 0,
  model: s.model,
});

function runArgs(opts: SendOptions): string[] {
  // ERROR logs on stderr: the JSON error event often only says "Unexpected server error" plus a ref into them
  const args = ["run", "--format", "json", "--print-logs", "--log-level", "ERROR"];
  if (opts.model) args.push("--model", opts.model);
  if (opts.mode === "plan") args.push("--agent", "plan");
  // `opencode run` auto-rejects anything the agent's permissions mark "ask"; --auto approves it instead
  if (opts.mode === "bypassPermissions") args.push("--auto");
  return args;
}

/* ── live streaming ──────────────────────────────────────────
 * `opencode run --format json` only prints finished parts. To stream, each web turn gets
 * its own `opencode serve` on a free loopback port (password-protected), `opencode run
 * --attach` drives it exactly like a standalone run, and we read the server's /event
 * stream: message.part.updated announces a part (type "text" | "reasoning" | ...),
 * message.part.delta {partID, field: "text", delta} grows it (older versions put a
 * `delta` on message.part.updated instead). If the server can't start, the turn runs
 * standalone without live text. */

const SERVE_TIMEOUT_MS = 15_000;

type Serve = { url: string; password: string; child: ChildProcess; stderr: () => string };

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function startServe(bin: string, cwd: string): Promise<Serve | null> {
  try {
    const port = await freePort();
    const password = randomBytes(24).toString("base64url");
    const profile = activeProfile();
    const child = spawn(bin, [...(profile?.args ?? []), "serve", "--port", String(port), "--hostname", "127.0.0.1", "--print-logs", "--log-level", "ERROR"], {
      cwd,
      env: { ...process.env, ...profile?.env, PWD: cwd, OPENCODE_SERVER_PASSWORD: password },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (c: Buffer) => (stderr = (stderr + c.toString("utf8")).slice(-8000)));
    const url = await new Promise<string | null>((resolve) => {
      let out = "";
      const timer = setTimeout(() => resolve(null), SERVE_TIMEOUT_MS);
      child.stdout?.on("data", (c: Buffer) => {
        out += c.toString("utf8");
        const m = /listening on (https?:\/\/[^\s]+)/.exec(out);
        if (m) {
          clearTimeout(timer);
          resolve(m[1].replace(/\/$/, ""));
        }
      });
      child.once("exit", () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.once("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
    if (!url) {
      child.kill("SIGTERM");
      return null;
    }
    return { url, password, child, stderr: () => stderr };
  } catch {
    return null;
  }
}

/** Reads the server's event stream and pushes text/reasoning deltas of the turn's session. */
async function streamEvents(serve: Serve, cwd: string, signal: AbortSignal, session: () => string | null, adoptRoot: (id: string) => void, push: (part: string, kind: "text" | "thinking", text: string) => void) {
  const res = await fetch(`${serve.url}/event?directory=${encodeURIComponent(cwd)}`, {
    headers: { authorization: `Basic ${Buffer.from(`opencode:${serve.password}`).toString("base64")}`, accept: "text/event-stream" },
    signal,
  });
  if (!res.ok || !res.body) return;
  const kinds = new Map<string, string>();
  const mine = (id: unknown) => typeof id === "string" && id === session();
  const kindOf = (part: string) => {
    const t = kinds.get(part);
    return t === "text" ? "text" : t === "reasoning" ? "thinking" : null;
  };
  const handle = (raw: string) => {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const ev = (m.payload && typeof m.payload === "object" ? m.payload : m) as { type?: string; properties?: Record<string, unknown> };
    const p = ev.properties ?? {};
    if (ev.type === "session.created") {
      const info = (p.info ?? {}) as { id?: string; parentID?: string };
      if (info.id && !info.parentID) adoptRoot(info.id);
    } else if (ev.type === "message.part.updated") {
      const part = (p.part ?? {}) as { id?: string; type?: string; sessionID?: string };
      if (!part.id || !mine(part.sessionID)) return;
      kinds.set(part.id, String(part.type));
      const kind = kindOf(part.id);
      if (kind && typeof p.delta === "string") push(part.id, kind, p.delta);
    } else if (ev.type === "message.part.delta") {
      if (p.field !== "text" || !mine(p.sessionID) || typeof p.partID !== "string" || typeof p.delta !== "string") return;
      const kind = kindOf(p.partID);
      if (kind) push(p.partID, kind, p.delta);
    }
  };
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += value;
    let cut;
    while ((cut = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) handle(data);
    }
  }
}

/** Spawns one turn; `onSession` sees the session id from the first JSON event. */
async function spawnTurn(key: string, cwd: string, text: string, opts: SendOptions, extra: string[], onSession?: (id: string) => void) {
  const bin = await profileBin(binary);
  if (!bin) throw new Error("OpenCode isn't installed.");
  if (turnState(key)?.status === "running") throw new Error("A turn is already running for this session.");
  const serve = await startServe(bin, cwd);
  let current = key;
  turnErrors.delete(current);
  /** move the run (and any error seen so far) from the provisional key to the real session id */
  const adopt = (id: string) => {
    const next = keyOf(id);
    if (next === current) return;
    rekeyTurn(current, next);
    const err = turnErrors.get(current);
    turnErrors.delete(current);
    if (err) turnErrors.set(next, err);
    else turnErrors.delete(next);
    current = next;
  };
  /** the turn's top-level session (subagent sessions stream too, but aren't shown live) */
  let root: string | null = extra[0] === "--session" ? extra[1] : null;
  const learn = (id: string) => {
    if (root && root !== id && extra[0] === "--session") return;
    root = id;
    if (onSession) {
      adopt(id);
      onSession(id);
    }
  };
  let stderr = () => "";
  const raw: unknown[] = [];
  let run: Run;
  try {
    run = startTurn(
      key,
      // PWD matters: `opencode run` resolves its project from $PWD before process.cwd()
      {
        cmd: bin,
        args: [...runArgs(opts), ...(serve ? ["--attach", serve.url] : []), ...extra],
        cwd,
        env: serve ? { PWD: cwd, OPENCODE_SERVER_PASSWORD: serve.password } : { PWD: cwd },
        stdin: text,
      },
      (line) => {
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        if (typeof ev.sessionID === "string") learn(ev.sessionID);
        if (ev.type === "error") {
          raw.push(ev.error);
          turnErrors.set(current, raw.map((e) => describeError(e, stderr())).join("\n"));
        }
      },
    );
  } catch (err) {
    serve?.child.kill("SIGTERM");
    throw err;
  }
  // with --attach the server logs the errors that JSON `error` events refer to
  stderr = () => run.stderr + (serve ? `\n${serve.stderr()}` : "");
  // stderr and stdout race: resolve log refs again once both pipes are drained
  run.child.on("close", () => {
    if (raw.length) turnErrors.set(current, raw.map((e) => describeError(e, stderr())).join("\n"));
  });
  if (serve) {
    const live = liveStream(run);
    const abort = new AbortController();
    void streamEvents(serve, cwd, abort.signal, () => root, (id) => !root && learn(id), live.push).catch(() => undefined);
    run.child.on("exit", () => {
      abort.abort();
      serve.child.kill("SIGTERM");
    });
    /* a server that dies mid-turn takes the attached run with it */
    serve.child.on("exit", () => {
      if (run.state.status === "running") setTimeout(() => run.state.status === "running" && run.child.kill("SIGTERM"), 3000);
    });
  }
  return { run, key: () => current, adopt };
}

/** Readable text for a JSON `error` event, resolving `data.ref` against the ERROR log lines on stderr. */
function describeError(raw: unknown, stderr: string): string {
  const e = (raw ?? {}) as { name?: string; data?: { message?: string; ref?: string } };
  let msg = e.data?.message || e.name || "OpenCode reported an error";
  const ref = e.data?.ref;
  if (ref) {
    const m = new RegExp(`ref=${ref.replace(/[^\w-]/g, "")} error="((?:[^"\\\\]|\\\\.)*)"`).exec(stderr);
    if (m) msg = m[1].replace(/\\"/g, '"').replace(/\\n/g, " ");
  }
  const kind = `${e.name ?? ""} ${/^(\w+Error): /.exec(msg)?.[1] ?? ""}`;
  msg = msg.replace(/^\w+Error: /, "");
  if (/ProviderModelNotFound/.test(kind) || /model not found/i.test(msg))
    return `${msg}. Run opencode auth login on the server, or pick another model.`;
  if (/ProviderAuthError/.test(kind) || /api key|unauthori[sz]ed|credential|401/i.test(msg)) return `${msg}. Run opencode auth login on the server.`;
  return msg;
}

const adapter: AgentAdapter = {
  id: "opencode",
  label: "OpenCode",
  binary,

  async list() {
    return listSessions().map(toSession);
  },

  async get(id) {
    const s = getSession(id);
    return s ? toSession(s) : null;
  },

  async history(id, before) {
    const end = sessionEnd(id);
    const page = historyPage(id, before);
    return { entries: page.entries, cursor: page.cursor, end: String(end || Date.now()) };
  },

  watch(id, from, onEntries) {
    let mark = Number(from);
    if (!Number.isFinite(mark) || mark <= 0) mark = Date.now();
    const sent = new Set<string>();
    let busy = false;
    let closed = false;
    const tick = () => {
      if (busy || closed) return;
      busy = true;
      try {
        const { entries, end } = changedSince(id, mark - SLACK_MS);
        // results can repeat harmlessly (the UI replaces them by tool id); everything else once per id
        const fresh = entries.filter((e: Entry) => {
          const k = e.kind === "result" ? `r:${e.id}` : e.id;
          if (sent.has(k)) return false;
          sent.add(k);
          return true;
        });
        const changed = end > mark;
        if (changed) mark = end;
        if (fresh.length || changed) onEntries(fresh, String(mark));
      } catch {
        // locked or mid-migration database: try again next tick
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(tick, POLL_MS);
    tick();
    return () => {
      closed = true;
      clearInterval(timer);
    };
  },

  async liveProcesses() {
    return liveTuis();
  },

  async start(opts: StartOptions) {
    const startedAt = Date.now();
    const pending = keyOf(`new-${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    return new Promise<{ id: string }>((resolve, reject) => {
      let done = false;
      let timer: ReturnType<typeof setInterval> | undefined;
      const finish = (err: Error | null, id?: string) => {
        if (done) return;
        done = true;
        if (timer) clearInterval(timer);
        if (err) reject(err);
        else resolve({ id: id! });
      };
      spawnTurn(pending, opts.cwd, opts.text, opts, [], (id) => finish(null, id))
        .then(({ run, key, adopt }) => {
          // the session row appears before the model answers; match it by its first prompt to resolve early
          const want = opts.text.trim();
          timer = setInterval(() => {
            if (done) return;
            try {
              const hit = sessionsSince(startedAt - 2000).find((s) => s.firstText.trim() === want);
              if (hit) {
                adopt(hit.id);
                finish(null, hit.id);
                return;
              }
            } catch {}
            if (Date.now() - startedAt > START_TIMEOUT_MS) {
              stopTurn(key());
              finish(new Error("OpenCode didn't start a session in time."));
            }
          }, 400);
          run.child.on("exit", () => {
            // give the stdout tail a moment to deliver the session id
            setTimeout(() => {
              const k = key();
              const st = turnState(k);
              finish(new Error(turnErrors.get(k) || st?.error || "OpenCode exited before starting a session."));
            }, 300);
          });
          run.child.on("error", (err) => finish(err));
        })
        .catch((err) => finish(err instanceof Error ? err : new Error(String(err))));
    });
  },

  async send(id, text, opts) {
    const s = getSession(id);
    if (!s) throw new Error("OpenCode session not found.");
    const cwd = s.directory && fs.existsSync(s.directory) ? s.directory : os.homedir();
    await spawnTurn(keyOf(id), cwd, text, opts, ["--session", id]);
  },

  runState(id): CliRunState | null {
    const key = keyOf(id);
    const s = turnState(key);
    if (!s) return null;
    const err = turnErrors.get(key);
    return s.status === "error" && err ? { ...s, error: err } : s;
  },

  async stop(id) {
    stopTurn(keyOf(id));
  },
};

export default adapter;

/* ── interactive TUIs ────────────────────────────────────── */

const NOT_TUI = new Set([
  "run", "serve", "web", "acp", "mcp", "debug", "models", "auth", "providers", "session", "export", "import",
  "stats", "upgrade", "uninstall", "agent", "db", "github", "plugin", "plug", "completion", "attach",
]);

/** Running `opencode` TUIs, each mapped to its session: `-s <id>` if given, else the newest session in its folder since it started. */
async function liveTuis(): Promise<Map<string, { pid: number }>> {
  const out = new Map<string, { pid: number }>();
  if (process.platform !== "linux") return out;
  let pids: string[];
  try {
    pids = fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d));
  } catch {
    return out;
  }
  const procs: { pid: number; ppid: number; argv: string[] }[] = [];
  for (const d of pids) {
    try {
      const argv = fs.readFileSync(`/proc/${d}/cmdline`, "utf8").split("\0").filter(Boolean);
      if (!argv.length) continue;
      const i = argv.findIndex((a, n) => n < 2 && path.basename(a) === "opencode");
      if (i === -1) continue;
      const stat = fs.readFileSync(`/proc/${d}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      procs.push({ pid: Number(d), ppid, argv: argv.slice(i + 1) });
    } catch {}
  }
  const ours = new Set(procs.map((p) => p.pid));
  const btime = bootTime();
  const sessions = procs.length ? listSessions(200) : [];
  for (const p of procs) {
    if (ours.has(p.ppid)) continue; // a worker of another opencode process
    const positional = positionals(p.argv);
    if (positional[0] && NOT_TUI.has(positional[0])) continue;
    const si = p.argv.findIndex((a) => a === "-s" || a === "--session");
    const explicit = si !== -1 ? p.argv[si + 1] : p.argv.find((a) => a.startsWith("--session="))?.slice(10);
    if (explicit) {
      out.set(explicit, { pid: p.pid });
      continue;
    }
    let cwd: string;
    try {
      cwd = fs.readlinkSync(`/proc/${p.pid}/cwd`);
    } catch {
      continue;
    }
    if (positional[0]) cwd = path.resolve(cwd, positional[0]);
    const started = btime ? processStart(p.pid, btime) : 0;
    const hit = sessions.find((s) => s.directory === cwd && s.time_updated >= started && !out.has(s.id));
    if (hit) out.set(hit.id, { pid: p.pid });
  }
  return out;
}

function positionals(argv: string[]): string[] {
  const out: string[] = [];
  const valued = new Set(["-m", "--model", "-s", "--session", "--prompt", "--agent", "--port", "--hostname", "--log-level", "--mdns-domain", "--cors", "--replay-limit"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valued.has(a)) i++;
    else if (!a.startsWith("-")) out.push(a);
  }
  return out;
}

function bootTime(): number {
  try {
    const m = /^btime (\d+)$/m.exec(fs.readFileSync("/proc/stat", "utf8"));
    return m ? Number(m[1]) * 1000 : 0;
  } catch {
    return 0;
  }
}

function processStart(pid: number, btime: number): number {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
    return btime + (ticks * 1000) / 100;
  } catch {
    return 0;
  }
}
