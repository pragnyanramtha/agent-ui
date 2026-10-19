import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

/* The web terminal backend as it runs on the server: a real server/pty.mjs process, real ptys. */

const SECRET = "test-secret-".padEnd(48, "x");
const PORT = 20_000 + Math.floor(Math.random() * 20_000);
const HOST = `127.0.0.1:${PORT}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentu-pty-"));
let server: ChildProcess;
let logs = "";

const cookie = (secret = SECRET, expires = Date.now() + 3600_000) => `cui_session=${expires}.${createHmac("sha256", secret).update(String(expires)).digest("base64url")}`;

type Conn = { ws: WebSocket; out: () => string; msgs: Record<string, unknown>[]; closed: Promise<{ code: number; reason: string }>; opened: Promise<void> };
function connect(query: string, headers: Record<string, string> = {}): Conn {
  const ws = new WebSocket(`ws://${HOST}/pty?${query}`, { headers: { Origin: `http://${HOST}`, Cookie: cookie(), ...headers } });
  let out = "";
  const msgs: Record<string, unknown>[] = [];
  ws.on("message", (data, binary) => (binary ? (out += data.toString()) : msgs.push(JSON.parse(data.toString()))));
  ws.on("error", () => undefined);
  const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })));
  const opened = new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
  return { ws, out: () => out, msgs, closed, opened };
}
const until = async (check: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 30));
  }
};
const type = (c: Conn, data: string) => c.ws.send(JSON.stringify({ type: "input", data }));
const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

beforeAll(async () => {
  server = spawn(process.execPath, ["server/pty.mjs"], {
    env: { NODE_ENV: "test", PATH: process.env.PATH, HOME: home, SHELL: "/bin/sh", UI_SECRET: SECRET, PTY_PORT: String(PORT), TERM: "xterm-256color", TMUX_TMPDIR: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout!.on("data", (d) => (logs += d));
  server.stderr!.on("data", (d) => (logs += d));
  let up = false;
  const end = Date.now() + 8000;
  while (!up && Date.now() < end) {
    up = await fetch(`http://${HOST}/`).then(() => true, () => false);
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  if (!up) throw new Error(`pty server didn't start:\n${logs}`);
});
afterAll(() => {
  server?.kill("SIGTERM");
  if (hasTmux) spawnSync("tmux", ["kill-server"], { env: { ...process.env, TMUX_TMPDIR: home }, stdio: "ignore" });
  fs.rmSync(home, { recursive: true, force: true });
});

describe("web terminal backend", () => {
  it("opens a shell that runs commands and keeps a replay offset", async () => {
    const c = connect(`cwd=${encodeURIComponent(home)}&cols=80&rows=24`);
    await c.opened;
    await until(() => c.msgs.some((m) => m.type === "hello"));
    const hello = c.msgs.find((m) => m.type === "hello")!;
    expect(hello).toMatchObject({ kind: "shell", persistent: true, offset: 0 });
    type(c, "echo term-$((40+2))-ok; pwd\r");
    await until(() => c.out().includes("term-42-ok"));
    expect(c.out()).toContain(fs.realpathSync(home).split("/").pop());
    c.ws.close();
  });

  it("a dropped socket can reattach and get only what it missed", async () => {
    const c = connect(`cwd=${encodeURIComponent(home)}`);
    await until(() => c.msgs.some((m) => m.type === "hello"));
    const id = c.msgs.find((m) => m.type === "hello")!.id as string;
    type(c, "echo first-part\r");
    await until(() => c.out().includes("first-part\r\n"));
    const seen = Buffer.byteLength(c.out());
    c.ws.terminate();
    await c.closed;

    const r = connect(`term=${id}&since=${seen}`);
    await until(() => r.msgs.some((m) => m.type === "hello"));
    expect(r.msgs.find((m) => m.type === "hello")).toMatchObject({ id, offset: seen });
    type(r, "echo second-part\r");
    await until(() => r.out().includes("second-part\r\n"));
    expect(r.out()).not.toContain("first-part");

    const full = connect(`term=${id}&since=0`);
    await until(() => full.out().includes("second-part\r\n"));
    expect(full.out()).toContain("first-part");
    type(full, "exit\r");
    await until(() => full.msgs.some((m) => m.type === "exit"));
    r.ws.close();
  });

  it("a since past the end starts over instead of showing nothing", async () => {
    const c = connect(`cwd=${encodeURIComponent(home)}`);
    await until(() => c.msgs.some((m) => m.type === "hello"));
    const id = c.msgs.find((m) => m.type === "hello")!.id as string;
    type(c, "echo marker-x\r");
    await until(() => c.out().includes("marker-x\r\n"));
    const r = connect(`term=${id}&since=99999999`);
    await until(() => r.out().includes("marker-x"));
    expect(r.msgs.find((m) => m.type === "hello")).toMatchObject({ offset: 0 });
    type(c, "exit\r");
    await c.closed;
  });

  it("refuses a missing, forged, expired or malformed cookie with 4401", async () => {
    for (const bad of ["", cookie("y".repeat(48)), cookie(SECRET, Date.now() - 1000), "cui_session=%E0%A4%A", "cui_session=1.2.3"]) {
      const c = connect("cwd=/", { Cookie: bad });
      expect((await c.closed).code).toBe(4401);
    }
  });

  it("refuses a cross-site origin before upgrading", async () => {
    const c = connect("cwd=/", { Origin: "https://evil.example" });
    await expect(c.opened).rejects.toThrow("HTTP 403");
  });

  it("closes unknown terminals and tmux sessions with 4404, not a crash", async () => {
    expect((await connect("term=doesnotexist1").closed).code).toBe(4404);
    expect((await connect("term=../../etc").closed).code).toBe(4404);
    expect((await connect("tmux=agentu-nothere").closed).code).toBe(4404);
    expect((await connect("session=not-a-uuid").closed).code).toBe(4404);
  });

  it("ignores garbage control frames and keeps serving", async () => {
    const c = connect(`cwd=${encodeURIComponent(home)}`);
    await until(() => c.msgs.some((m) => m.type === "hello"));
    c.ws.send("{not json");
    c.ws.send(JSON.stringify({ type: "resize", cols: "x", rows: -5 }));
    c.ws.send(JSON.stringify({ type: "input", data: 42 }));
    type(c, "echo still-alive\r");
    await until(() => c.out().includes("still-alive\r\n"));
    expect(server.exitCode).toBeNull();
    type(c, "exit\r");
    await c.closed;
  });

  it("internal API needs the app's key", async () => {
    const r = await fetch(`http://${HOST}/internal/terminals`);
    expect(r.status).toBe(401);
    const key = createHmac("sha256", SECRET).update("agent-u pty internal").digest("base64url");
    const ok = await fetch(`http://${HOST}/internal/terminals`, { headers: { "x-agent-u-internal": key } });
    expect(ok.status).toBe(200);
    expect(Array.isArray((await ok.json()).terminals)).toBe(true);
  });

  it.skipIf(!hasTmux)("tmux launches get profile secrets without putting them on a command line", async () => {
    const key = createHmac("sha256", SECRET).update("agent-u pty internal").digest("base64url");
    const out = path.join(home, "launch.out");
    const secret = "s3cr;et 'quoted' $HOME";
    const res = await fetch(`http://${HOST}/internal/launch`, {
      method: "POST",
      headers: { "x-agent-u-internal": key, "Content-Type": "application/json" },
      body: JSON.stringify({ cmd: "sh", args: ["-c", `printf '%s' "$AGENTU_TEST_SECRET" > ${out}; sleep 30`], env: { AGENTU_TEST_SECRET: secret }, cwd: home, label: "ends with;" }),
    });
    expect(res.status).toBe(200);
    const { id } = await res.json();
    await until(() => fs.existsSync(out) && fs.readFileSync(out, "utf8").length > 0);
    expect(fs.readFileSync(out, "utf8")).toBe(secret);
    expect(fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("agentu-env-")).some((d) => fs.existsSync(path.join(os.tmpdir(), d, "env")) && fs.readFileSync(path.join(os.tmpdir(), d, "env"), "utf8").includes("s3cr"))).toBe(false);
    const list = await (await fetch(`http://${HOST}/internal/terminals`, { headers: { "x-agent-u-internal": key } })).json();
    expect(list.terminals.find((t: { id: string }) => t.id === id)).toMatchObject({ label: "ends with;", backing: "tmux" });
    await fetch(`http://${HOST}/internal/kill`, { method: "POST", headers: { "x-agent-u-internal": key, "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
  });

  it.skipIf(!hasTmux)("tmux launches take a folder named like a tmux format literally", async () => {
    const key = createHmac("sha256", SECRET).update("agent-u pty internal").digest("base64url");
    const dir = path.join(home, "x#(echo hi)#{session_name}y");
    fs.mkdirSync(dir);
    const out = path.join(home, "pwd.out");
    const res = await fetch(`http://${HOST}/internal/launch`, {
      method: "POST",
      headers: { "x-agent-u-internal": key, "Content-Type": "application/json" },
      body: JSON.stringify({ cmd: "sh", args: ["-c", `pwd -P > ${out}; sleep 30`], cwd: dir, label: "formats" }),
    });
    expect(res.status).toBe(200);
    const { id } = await res.json();
    await until(() => fs.existsSync(out) && fs.readFileSync(out, "utf8").length > 0);
    expect(fs.readFileSync(out, "utf8").trim()).toBe(fs.realpathSync(dir));
    await fetch(`http://${HOST}/internal/kill`, { method: "POST", headers: { "x-agent-u-internal": key, "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
  });
});
