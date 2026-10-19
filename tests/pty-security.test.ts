import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

/* server/pty.mjs with a Host allowlist; like tests/pty.test.ts it runs on its own HOME and TMUX_TMPDIR,
 * so its tmux server is never the caller's. */

const SECRET = "test-secret-".padEnd(48, "s");
const PORT = 20_000 + Math.floor(Math.random() * 20_000);
const HOST = `127.0.0.1:${PORT}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentu-ptysec-"));
let server: ChildProcess;
let logs = "";

const PASSWORD_HASH = "scrypt:salt-in-env:hash-in-env";
/* signed as lib/auth.ts does: expiry, session epoch and the password the server checks */
const cookie = (expires = Date.now() + 3600_000, epoch = "") => `cui_session=${expires}.${createHmac("sha256", SECRET).update(`${expires}\n${epoch}\n${PASSWORD_HASH}`).digest("base64url")}`;

/** raw request, so Host and the path go out exactly as written */
function request(rawPath: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path: rawPath, headers: { host: HOST, ...headers } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function connect(query: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(`ws://${HOST}/pty?${query}`, { headers: { Origin: `http://${headers.Host ?? HOST}`, Cookie: cookie(), ...headers } });
  const msgs: Record<string, unknown>[] = [];
  let out = "";
  ws.on("message", (data, binary) => (binary ? (out += data.toString()) : msgs.push(JSON.parse(data.toString()))));
  ws.on("error", () => undefined);
  const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })));
  const opened = new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
  return { ws, msgs, out: () => out, closed, opened };
}
const until = async (check: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 30));
  }
};
const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

beforeAll(async () => {
  server = spawn(process.execPath, ["server/pty.mjs"], {
    env: {
      NODE_ENV: "test",
      PATH: process.env.PATH,
      HOME: home,
      SHELL: "/bin/sh",
      UI_SECRET: SECRET,
      PTY_PORT: String(PORT),
      TERM: "xterm-256color",
      TMUX_TMPDIR: home,
      ALLOWED_HOSTS: "agent.example,pinned.example:8443",
      UI_PASSWORD: "pw-in-env-123",
      UI_PASSWORD_HASH: PASSWORD_HASH,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout!.on("data", (d) => (logs += d));
  server.stderr!.on("data", (d) => (logs += d));
  let up = false;
  const end = Date.now() + 8000;
  while (!up && Date.now() < end) {
    up = await request("/").then(() => true, () => false);
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  if (!up) throw new Error(`pty server didn't start:\n${logs}`);
});
afterAll(() => {
  server?.kill("SIGTERM");
  /* without TMUX in the env, kill-server can only reach the test's own socket under TMUX_TMPDIR, never the caller's tmux */
  if (hasTmux) spawnSync("tmux", ["kill-server"], { env: { ...process.env, TMUX: undefined, TMUX_TMPDIR: home }, stdio: "ignore" });
  fs.rmSync(home, { recursive: true, force: true });
});

describe("web terminal backend: Host allowlist", () => {
  it("answers HTTP only for loopback and listed hosts", async () => {
    expect((await request("/", { host: "evil.example" })).status).toBe(421);
    expect((await request("/", { host: "pinned.example:9999" })).status).toBe(421);
    expect((await request("/", { host: "agent.example" })).status).toBe(404);
    expect((await request("/", { host: "localhost:1234" })).status).toBe(404);
  });

  it("refuses a WebSocket from another Host before the origin check", async () => {
    const c = connect("cwd=/", { Host: "evil.example", Origin: "http://evil.example" });
    await expect(c.opened).rejects.toThrow("HTTP 421");
  });

  it("opens a shell for an allowed Host", async () => {
    const c = connect(`cwd=${encodeURIComponent(home)}`, { Host: "agent.example", Origin: "https://agent.example" });
    await c.opened;
    await until(() => c.msgs.some((m) => m.type === "hello"));
    c.ws.send(JSON.stringify({ type: "input", data: "echo host-$((1+1))-ok\r" }));
    await until(() => c.out().includes("host-2-ok"));
    c.ws.send(JSON.stringify({ type: "input", data: "exit\r" }));
    await c.closed;
  });
});

const INTERNAL = createHmac("sha256", SECRET).update("agent-u pty internal").digest("base64url");
const internal = (p: string, body?: unknown) =>
  fetch(`http://${HOST}${p}`, { method: body ? "POST" : "GET", headers: { "x-agent-u-internal": INTERNAL, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const LEAK = /UI_SECRET|UI_PASSWORD|pw-in-env-123|hash-in-env|test-secret-/;

describe("web terminal backend: secrets", () => {
  it("a web shell's environment has no app secrets", async () => {
    const c = connect(`cwd=${encodeURIComponent(home)}`);
    await until(() => c.msgs.some((m) => m.type === "hello"));
    c.ws.send(JSON.stringify({ type: "input", data: "env; echo env-$((6*7))-done\r" }));
    await until(() => c.out().includes("env-42-done"));
    expect(c.out()).toContain("HOME=");
    expect(c.out()).not.toMatch(LEAK);
    c.ws.send(JSON.stringify({ type: "input", data: "exit\r" }));
    await c.closed;
  });

  it("refuses a validly signed cookie that expires further out than a session can last", async () => {
    const c = connect("cwd=/", { Cookie: cookie(Date.now() + 365 * 86_400_000) });
    expect((await c.closed).code).toBe(4401);
  });

  it.skipIf(!hasTmux)("agents launched in tmux don't get them, also from a tmux server that already had them", async () => {
    /* a tmux server an older agent-u-pty started, with the secrets in its global environment */
    spawnSync("tmux", ["new-session", "-d", "-s", "older", "sleep 60"], { env: { ...process.env, TMUX: undefined, TMUX_TMPDIR: home, UI_SECRET: SECRET, UI_PASSWORD: "pw-in-env-123" }, stdio: "ignore" });
    const out = path.join(home, "tmux-env.out");
    const res = await internal("/internal/launch", { cmd: "sh", args: ["-c", `env > ${out}; sleep 30`], env: { UI_SECRET: "from-request", OK_VAR: "kept" }, cwd: home, label: "env" });
    expect(res.status).toBe(200);
    const { id } = await res.json();
    await until(() => fs.existsSync(out) && fs.readFileSync(out, "utf8").includes("OK_VAR"));
    const env = fs.readFileSync(out, "utf8");
    expect(env).toContain("OK_VAR=kept");
    expect(env).not.toMatch(LEAK);
    expect(env).not.toContain("from-request");
    await internal("/internal/kill", { id });
  });
});

describe("web terminal backend: sign out everywhere", () => {
  const authDir = path.join(home, ".config", "agent-u");
  const opens = async (c: string) => {
    const conn = connect(`cwd=${encodeURIComponent(home)}`, { Cookie: c });
    const first = await Promise.race([conn.closed.then((x) => x.code), until(() => conn.msgs.some((m) => m.type === "hello")).then(() => 0)]);
    if (!first) conn.ws.close();
    return first === 0;
  };

  it("refuses cookies in the old format, which signed only the expiry", async () => {
    const expires = Date.now() + 3600_000;
    expect(await opens(`cui_session=${expires}.${createHmac("sha256", SECRET).update(String(expires)).digest("base64url")}`)).toBe(false);
    expect(await opens(cookie())).toBe(true);
  });

  it("takes the app's cookies, and refuses them once the app starts a new epoch", async () => {
    const saved = { AGENT_U_HOME: process.env.AGENT_U_HOME, UI_SECRET: process.env.UI_SECRET, UI_PASSWORD_HASH: process.env.UI_PASSWORD_HASH };
    Object.assign(process.env, { AGENT_U_HOME: authDir, UI_SECRET: SECRET, UI_PASSWORD_HASH: PASSWORD_HASH });
    try {
      const { newSessionEpoch, signSession, verifySession } = await import("@/lib/auth");
      const before = `cui_session=${await signSession()}`;
      expect(await opens(before)).toBe(true);

      const epoch = newSessionEpoch();
      expect(fs.statSync(path.join(authDir, "auth.json")).mode & 0o777).toBe(0o600);
      expect(await verifySession(before.slice("cui_session=".length))).toBe(false);
      expect(await opens(before)).toBe(false);
      expect(await opens(cookie(Date.now() + 3600_000, epoch))).toBe(true);
      expect(await opens(`cui_session=${await signSession()}`)).toBe(true);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(path.join(authDir, "auth.json"), { force: true });
    }
  });
});

describe("web terminal backend: internal API", () => {
  it("can't be reached through a /pty path that normalizes into /internal", async () => {
    for (const p of ["/pty/%2e%2e/internal/terminals", "/pty/../internal/terminals", "/pty/%2E%2E/internal/terminals", "/x/%2e%2e/internal/terminals"]) {
      const r = await request(p, { "x-agent-u-internal": INTERNAL });
      expect(r.status, p).toBe(404);
      expect(r.body).not.toContain("terminals");
    }
  });

  it("refuses requests a proxy or the tunnel forwarded, even with the key", async () => {
    for (const h of [{ "cf-ray": "8abc-LHR" }, { "cf-connecting-ip": "203.0.113.5" }, { "x-forwarded-for": "203.0.113.5" }]) {
      expect((await request("/internal/terminals", { "x-agent-u-internal": INTERNAL, ...h })).status).toBe(403);
    }
    const ok = await request("/internal/terminals", { "x-agent-u-internal": INTERNAL });
    expect(ok.status).toBe(200);
    expect(Array.isArray(JSON.parse(ok.body).terminals)).toBe(true);
  });
});

describe.skipIf(!hasTmux)("web terminal backend: tmux metadata", () => {
  const list = async () => (await (await internal("/internal/terminals")).json()).terminals as { id: string; label: string; cwd: string; kind: string; session: string | null }[];

  it("a label or folder with tabs and newlines can't forge fields or entries", async () => {
    const forged = "agentu-deadbeef\t0\t0\t0\t1\t1\tForged\tagent\tx\t\t\t0";
    const dir = path.join(home, `odd\tdir\n${forged}`);
    fs.mkdirSync(dir);
    const label = `evil\tshell\n${forged} 100% #{session_name};`;
    const res = await internal("/internal/launch", { cmd: "sh", args: ["-c", "sleep 30"], cwd: dir, label, session: "s\t1", profile: "p\nq" });
    expect(res.status).toBe(200);
    const { id } = await res.json();
    const all = await list();
    expect(all.some((t) => t.id === "agentu-deadbeef")).toBe(false);
    expect(all.find((t) => t.id === id)).toMatchObject({ label, cwd: dir, kind: "agent", session: "s\t1", profile: "p\nq" });
    await internal("/internal/kill", { id });
  });

  it("still lists sessions started before values were encoded", async () => {
    const env = { ...process.env, TMUX: undefined, TMUX_TMPDIR: home };
    const name = "agentu-0ld0ld01";
    spawnSync("tmux", ["new-session", "-d", "-s", name, "sleep 30", ";", "set-option", "@agentu_label", "Old label 100%", ";", "set-option", "@agentu_cwd", "/tmp/old%20dir", ";", "set-option", "@agentu_kind", "agent"], { env, stdio: "ignore" });
    expect((await list()).find((t) => t.id === name)).toMatchObject({ label: "Old label 100%", cwd: "/tmp/old%20dir" });
    await internal("/internal/kill", { id: name });
  });
});
