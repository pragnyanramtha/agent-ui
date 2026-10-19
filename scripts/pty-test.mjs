/* Smoke test for server/pty.mjs: start it on a spare port, open a shell, drop the
 * socket, reattach and check the replay; launch/list/kill through the internal API.
 * Usage: node scripts/pty-test.mjs */

import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const line of fs.readFileSync(path.join(root, ".env.local"), "utf8").split("\n")) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const SECRET = process.env.UI_SECRET;
const PORT = 3399;
const expires = String(Date.now() + 3600_000);
/* signed as lib/auth.ts does: expiry, session epoch (auth.json next to config.json) and password */
const authFile = path.join(process.env.AGENT_U_HOME || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "agent-u"), "auth.json");
const epoch = fs.existsSync(authFile) ? (() => { try { return JSON.parse(fs.readFileSync(authFile, "utf8")).epoch || "invalid"; } catch { return "invalid"; } })() : "";
const cookie = `cui_session=${expires}.${createHmac("sha256", SECRET).update(`${expires}\n${epoch}\n${process.env.UI_PASSWORD_HASH || process.env.UI_PASSWORD || ""}`).digest("base64url")}`;
const key = createHmac("sha256", SECRET).update("agent-u pty internal").digest("base64url");
const host = `127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};

const server = spawn("node", [path.join(root, "server/pty.mjs")], { env: { ...process.env, PTY_PORT: String(PORT), PATH: process.env.NO_TMUX ? "/usr/bin:/bin" : process.env.PATH }, stdio: ["ignore", "pipe", "inherit"] });
await new Promise((r) => server.stdout.once("data", r));

function open(query) {
  const ws = new WebSocket(`ws://${host}/pty?${query}`, { headers: { cookie, origin: `http://${host}` } });
  const state = { ws, out: "", bytes: 0, hello: null, closed: null };
  ws.on("message", (data, binary) => {
    if (binary) {
      state.out += data.toString("utf8");
      state.bytes += data.length;
    } else {
      const msg = JSON.parse(String(data));
      if (msg.type === "hello") state.hello = msg;
    }
  });
  ws.on("close", (code, reason) => (state.closed = { code, reason: String(reason) }));
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve(state));
    ws.on("error", reject);
  });
}
const api = (p, body) =>
  fetch(`http://${host}${p}`, { method: body ? "POST" : "GET", headers: { "x-agent-u-internal": key, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));

try {
  /* auth */
  const bad = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://${host}/pty?cwd=/tmp`, { headers: { origin: `http://${host}` } });
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode));
    ws.on("open", () => resolve(200));
  });
  check(bad === 401, "socket without a cookie is refused");
  check((await api("/internal/terminals").then(() => fetch(`http://${host}/internal/terminals`)).then((r) => r.status)) === 401, "internal API without the key is refused");

  /* shell survives a dropped socket */
  const a = await open(`cwd=${encodeURIComponent(os.tmpdir())}&cols=80&rows=24`);
  await sleep(600);
  check(Boolean(a.hello?.persistent && a.hello.id), "new shell is kept with an id");
  a.ws.send(JSON.stringify({ type: "input", data: "echo MARK-$((40+2))\r" }));
  await sleep(600);
  check(a.out.includes("MARK-42"), "shell runs input");
  const seen = a.bytes;
  a.ws.terminate();
  await sleep(300);
  /* output while nobody is attached */
  const list1 = await api("/internal/terminals");
  check(list1.body.terminals.some((t) => t.id === a.hello.id && t.clients === 0 && !t.exited), "shell still listed after the socket dropped");

  const b = await open(`term=${a.hello.id}&since=${seen}&cols=80&rows=24`);
  b.ws.send(new TextEncoder().encode("echo AFTER-$((1+1))\r"));
  await sleep(700);
  check(b.out.includes("AFTER-2") && !b.out.includes("MARK-42\r\n"), "reattach resumes after the last byte seen");
  const c = await open(`term=${a.hello.id}&since=0&cols=80&rows=24`);
  await sleep(400);
  check(c.out.includes("MARK-42") && c.out.includes("AFTER-2"), "a fresh viewer gets the whole buffer");
  b.ws.send(JSON.stringify({ type: "input", data: "exit\r" }));
  await sleep(700);
  check(b.closed?.code === 1000 && c.closed?.code === 1000, "shell exit closes every viewer");

  /* launch an "agent" */
  const launched = await api("/internal/launch", { cmd: "bash", args: ["-c", "echo AGENT-UP; read x; echo GOT-$x; sleep 0.2"], cwd: os.tmpdir(), label: "test agent", profile: "test", backing: process.env.NO_TMUX ? "pty" : undefined });
  check(launched.status === 200 && launched.body.id, `launch works (${launched.body.backing}) ${JSON.stringify(launched.body)}`);
  await sleep(900);
  const q = launched.body.backing === "tmux" ? `tmux=${launched.body.id}` : `term=${launched.body.id}&since=0`;
  const d = await open(`${q}&cols=100&rows=30`);
  await sleep(900);
  check(d.out.includes("AGENT-UP"), "agent output visible on attach");
  d.ws.send(JSON.stringify({ type: "input", data: "yes\r" }));
  await sleep(900);
  check(d.out.includes("GOT-yes"), "agent takes input");
  const list2 = await api("/internal/terminals");
  const rec = list2.body.terminals.find((t) => t.id === launched.body.id);
  check(Boolean(rec && rec.label === "test agent" && rec.profile === "test"), "agent listed with its label and profile");
  const killed = await api("/internal/kill", { id: launched.body.id });
  check(killed.status === 200, "kill works");
  const list3 = await api("/internal/terminals");
  check(!list3.body.terminals.some((t) => t.id === launched.body.id), "killed agent is gone");
  const gone = await open(`term=nosuchterm1&cols=80&rows=24`).catch(() => null);
  await sleep(300);
  check(gone?.closed?.code === 4404, "unknown terminal closes with 4404");
} finally {
  server.kill("SIGTERM");
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
