#!/usr/bin/env node
/* Offline end-to-end checks: no network, no API keys, nothing outside a throwaway folder.
 *   pnpm e2e:offline
 *   GEMINI_BIN=/path/to/gemini E2E_REBUILD=1 pnpm e2e:offline
 * Builds .next unless one exists (E2E_REBUILD=1 forces it), starts `next start` on a free port with its own HOME,
 * AGENT_U_HOME, AGENT_U_CONFIG and GEMINI_CLI_HOME, and drives real Gemini CLI turns that replay canned model
 * responses (--fake-responses-non-strict). Each CLI process replays its file from the start, so the fast and slow
 * turns are two profiles sharing one session store. Same helpers as scripts/e2e.mjs, which checks a live server. */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { scryptSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const NEXT = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");

function findGemini() {
  if (process.env.GEMINI_BIN) return fs.existsSync(process.env.GEMINI_BIN) ? path.resolve(process.env.GEMINI_BIN) : null;
  const dirs = [...(process.env.PATH ?? "").split(path.delimiter), path.join(os.homedir(), ".local", "bin")];
  for (const d of dirs) {
    const p = d && path.join(d, "gemini");
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}
const GEMINI = findGemini();
if (!GEMINI) {
  console.error("Gemini CLI not found. Install it (npm i -g @google/gemini-cli@0.64.0) or set GEMINI_BIN.");
  process.exit(1);
}

if (process.env.E2E_REBUILD === "1" || !fs.existsSync(path.join(ROOT, ".next", "BUILD_ID"))) {
  console.log("Building...");
  const b = spawnSync(process.execPath, [NEXT, "build"], { cwd: ROOT, stdio: "inherit" });
  if (b.status !== 0) process.exit(b.status ?? 1);
}

/* ── throwaway environment ────────────────────────────── */

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "agentu-offline-"));
const dir = (...p) => {
  const d = path.join(tmp, ...p);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const HOME = dir("home");
const AGENT_U_HOME = dir("agent-u");
const AGENT_U_CONFIG = path.join(AGENT_U_HOME, "config.json");
const GEMINI_HOME = dir("gemini");
const repo = dir("repo");
const logFile = path.join(tmp, "server.log");

const usage = { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 };
const chunk = (parts, last) => ({ candidates: [{ content: { role: "model", parts }, ...(last ? { finishReason: "STOP" } : {}) }], usageMetadata: usage });
const stream = (...chunks) => ({ method: "generateContentStream", response: chunks.map((parts, i) => chunk(parts, i === chunks.length - 1)) });
const shell = (command, description) => ({ functionCall: { name: "run_shell_command", args: { command, description } } });
/* routing, next-speaker checks and token counts take these, whatever order they come in */
const padding = [
  ...Array(10).fill({ method: "generateContent", response: chunk([{ text: '{"reasoning":"x","next_speaker":"user","model_choice":"flash"}' }], true) }),
  ...Array(10).fill({ method: "countTokens", response: { totalTokens: 10 } }),
];
const jsonl = (...lines) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
const FAST = path.join(tmp, "fast.jsonl");
const SLOW = path.join(tmp, "slow.jsonl");
fs.writeFileSync(
  FAST,
  jsonl(
    stream([{ text: "Let me write the greeting. " }], [shell("echo hello-from-gemini > made.txt", "Write the greeting")]),
    stream([{ text: "The command wrote **hello-from-gemini**." }], [{ text: " Done." }]),
    ...padding,
  ),
);
fs.writeFileSync(SLOW, jsonl(stream([{ text: "Taking a moment. " }], [shell("sleep 6", "Wait")]), stream([{ text: "SLEPT" }]), ...padding));

const geminiEnv = { GEMINI_API_KEY: "fake", GEMINI_CLI_HOME: GEMINI_HOME };
const profile = (id, label, file) => ({ id, label, agent: "gemini", bin: GEMINI, args: ["--fake-responses-non-strict", file], env: geminiEnv });
fs.writeFileSync(AGENT_U_CONFIG, JSON.stringify({ profiles: [profile("gemini-fake", "Gemini (offline)", FAST), profile("gemini-slow", "Gemini (offline, slow)", SLOW)] }, null, 2), { mode: 0o600 });

const GIT_ID = { GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@e2e", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@e2e" };
const gitIn = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, ...GIT_ID } });
gitIn("init", "-q", "-b", "main");
fs.writeFileSync(path.join(repo, "README.md"), "offline e2e\n");
gitIn("add", "-A");
gitIn("commit", "-qm", "init");

/* ── server ───────────────────────────────────────────── */

const PASSWORD = `e2e-${randomBytes(9).toString("base64url")}`;
const salt = randomBytes(16);
/* the hash wins over UI_PASSWORD, so a stray .env.local can't change the password under test */
const PASSWORD_HASH = `scrypt:${salt.toString("base64url")}:${scryptSync(PASSWORD, salt, 64, { N: 16384, r: 8, p: 1 }).toString("base64url")}`;

const port = await new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const APP = `http://127.0.0.1:${port}`;

const serverEnv = { ...process.env };
for (const k of Object.keys(serverEnv)) if (k.startsWith("XDG_") || k === "CLAUDE_CONFIG_DIR" || k === "CLAUDE_HOME") delete serverEnv[k];
Object.assign(serverEnv, {
  HOME,
  AGENT_U_HOME,
  AGENT_U_CONFIG,
  GEMINI_CLI_HOME: GEMINI_HOME,
  GEMINI_BIN: GEMINI,
  UI_PASSWORD: PASSWORD,
  UI_PASSWORD_HASH: PASSWORD_HASH,
  UI_SECRET: randomBytes(32).toString("base64url"),
  NODE_ENV: "production",
  NEXT_TELEMETRY_DISABLED: "1",
});
const log = fs.openSync(logFile, "a");
const server = spawn(process.execPath, [NEXT, "start", "-H", "127.0.0.1", "-p", String(port)], { cwd: ROOT, env: serverEnv, stdio: ["ignore", log, log], detached: true });
let serverExit = null;
server.on("exit", (code, signal) => (serverExit = signal ?? code));

let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (serverExit === null) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {}
    for (let i = 0; i < 50 && serverExit === null; i++) await sleep(100);
    try {
      process.kill(-server.pid, "SIGKILL");
    } catch {}
  }
  fs.closeSync(log);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => void cleanup().then(() => process.exit(130)));

/* ── helpers (as in scripts/e2e.mjs) ──────────────────── */

const results = [];
async function check(name, fn) {
  const t0 = Date.now();
  let error = null;
  try {
    await fn();
  } catch (err) {
    error = err?.message ?? String(err);
  }
  results.push({ name, error, secs: (Date.now() - t0) / 1000 });
  console.log(`${error ? "FAIL" : "ok  "}  ${name}${error ? `: ${error}` : ""}`);
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function until(what, fn, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

let COOKIE = "";
const auth = () => ({ Cookie: COOKIE, Origin: APP, "Content-Type": "application/json" });
const call = async (method, p, body, h = auth()) => {
  const r = await fetch(APP + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, body: json, text, headers: r.headers };
};
const get = (p, h) => call("GET", p, undefined, h);
const post = (p, body, h) => call("POST", p, body, h);
const patch = (p, body, h) => call("PATCH", p, body, h);
const enc = encodeURIComponent;
const cid = (tag) => `off${Date.now().toString(36)}${tag}`;
const show = (v) => JSON.stringify(v)?.slice(0, 300);

/** the live event stream, as the browser reads it, from the session's first entry */
function events(id) {
  const ac = new AbortController();
  const seen = [];
  (async () => {
    const r = await fetch(`${APP}/api/sessions/${enc(id)}/events`, { method: "POST", headers: auth(), body: JSON.stringify({ from: 0 }), signal: ac.signal });
    const dec = new TextDecoder();
    let buf = "";
    for await (const c of r.body) {
      buf += dec.decode(c, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = frame.split("\n").find((l) => l.startsWith("data: "));
        if (data) seen.push(JSON.parse(data.slice(6)));
      }
    }
  })().catch(() => undefined);
  return { seen, close: () => ac.abort() };
}
const session = (id) => get(`/api/sessions/${enc(id)}`).then((r) => r.body);
const userTexts = (s) => s.entries.filter((e) => e.kind === "user").map((e) => e.text);
const assistantText = (s) => s.entries.filter((e) => e.kind === "text").map((e) => e.text).join("\n");
const running = async (id) => (await session(id))?.run?.status === "running";
const idle = (id, ms) => until(`${id} to go idle`, async () => {
  const s = await session(id);
  return s && s.run?.status !== "running" ? s : null;
}, ms);
const streamEntries = (ev) => ev.seen.filter((e) => e.type === "entries").flatMap((e) => e.entries);

/* ── checks ───────────────────────────────────────────── */

let id = "";
let ev = null;
try {
  await until("the server to answer", async () => {
    if (serverExit !== null) throw new Error(`server exited (${serverExit})`);
    return (await fetch(`${APP}/login`).catch(() => null))?.status === 200;
  }, 60_000);

  await check("login refuses a wrong password", async () => {
    const r = await post("/api/auth/login", { password: "not-the-password" }, { Origin: APP, "Content-Type": "application/json" });
    assert(r.status === 401, `got ${r.status}`);
    assert(!r.headers.getSetCookie().some((c) => c.startsWith("cui_session=")), "set a cookie anyway");
  });
  await check("login with the password sets the session cookie", async () => {
    const r = await post("/api/auth/login", { password: PASSWORD }, { Origin: APP, "Content-Type": "application/json" });
    assert(r.status === 200, `got ${r.status} ${show(r.body)}`);
    const c = r.headers.getSetCookie().find((x) => x.startsWith("cui_session="));
    assert(c && /HttpOnly/i.test(c) && /SameSite=strict/i.test(c), `cookie ${c}`);
    COOKIE = c.split(";")[0];
  });
  await check("API answers 401 without a cookie", async () => {
    const r = await get("/api/sessions", { Origin: APP });
    assert(r.status === 401, `got ${r.status}`);
    const forged = await get("/api/sessions", { Cookie: `cui_session=${Date.now() + 3600_000}.forged`, Origin: APP });
    assert(forged.status === 401, `forged cookie: ${forged.status}`);
  });
  await check("API answers 403 to a cross-origin POST", async () => {
    const r = await post("/api/sessions", { agent: "gemini", cwd: repo, text: "hi" }, { ...auth(), Origin: "https://evil.example" });
    assert(r.status === 403, `got ${r.status}`);
    const none = await post("/api/sessions", { agent: "gemini", cwd: repo, text: "hi" }, { Cookie: COOKIE, "Content-Type": "application/json" });
    assert(none.status === 403, `no Origin: ${none.status}`);
  });

  await check("start a Gemini session", async () => {
    const r = await post("/api/sessions", { agent: "gemini", profile: "gemini-fake", cwd: repo, permissionMode: "bypassPermissions", text: "Write the greeting to made.txt.", clientId: cid("start") });
    assert(r.status === 200 && /^gemini:[0-9a-f-]{36}$/.test(r.body?.id ?? ""), `got ${r.status} ${show(r.body)}`);
    id = r.body.id;
    ev = events(id);
    console.log(`      ${id}`);
  });

  if (id) {
    await check("the stream carries the assistant text and the tool call", async () => {
      await until("text and tool entries on the stream", () => {
        const es = streamEntries(ev);
        return es.some((e) => e.kind === "text" && e.text.includes("hello-from-gemini")) && es.some((e) => e.kind === "tool" && e.name === "Bash");
      }, 30_000);
      assert(ev.seen[0]?.type === "history", `first event: ${ev.seen[0]?.type}`);
      /* the history event carries the run as it stood and "run" events every change after it; the turn may end
       * before the stream opens or after its entries arrive, so the check is that the latest of those reaches its end */
      const last = () => ev.seen.filter((e) => e.type === "run" || e.type === "history").at(-1);
      /* run null is a turn that ended cleanly */
      await until("the stream to show the turn ended", () => last() && !["running", "starting"].includes(last().run?.status), 30_000);
    });

    let first = null;
    await check("history has the prompt, text, tool call and its result", async () => {
      first = await idle(id, 30_000);
      const kinds = new Set(first.entries.map((e) => e.kind));
      for (const k of ["user", "text", "tool", "result"]) assert(kinds.has(k), `no ${k} entry: ${[...kinds]}`);
      const tool = first.entries.find((e) => e.kind === "tool");
      assert(tool.name === "Bash" && tool.input.command.includes("hello-from-gemini"), `tool ${show(tool)}`);
      assert(first.entries.some((e) => e.kind === "result" && e.toolUseId === tool.toolUseId), "result isn't the tool's");
      assert(userTexts(first)[0]?.includes("Write the greeting"), `user ${show(userTexts(first))}`);
      assert(first.run?.status !== "error", `run error: ${first.run?.error}`);
      assert(fs.readFileSync(path.join(repo, "made.txt"), "utf8").trim() === "hello-from-gemini", "made.txt not written");
    });

    await check("a follow-up resumes the same session", async () => {
      const r = await post(`/api/sessions/${enc(id)}/message`, { text: "Do it once more.", profile: "gemini-fake", permissionMode: "bypassPermissions", clientId: cid("again") });
      assert(r.status === 200 && r.body.id === id && r.body.via === "web", `got ${r.status} ${show(r.body)}`);
      const s = await until("the second turn in history", async () => {
        const x = await session(id);
        return x?.run?.status !== "running" && userTexts(x).length === 2 && x.entries.filter((e) => e.kind === "tool").length === 2 && x;
      }, 30_000);
      assert(s.entries.length > (first?.entries.length ?? 0), "no new entries");
      const rows = (await get("/api/sessions")).body.sessions.filter((x) => x.id.startsWith("gemini:"));
      assert(rows.length === 1 && rows[0].id === id, `gemini sessions: ${show(rows.map((x) => x.id))}`);
    });

    await check("a message sent during a slow turn is queued and delivered after it", async () => {
      const qid = cid("queued");
      const slow = await post(`/api/sessions/${enc(id)}/message`, { text: "Take your time.", profile: "gemini-slow", permissionMode: "bypassPermissions", clientId: cid("slow") });
      assert(slow.status === 200 && slow.body.via === "web", `slow: ${slow.status} ${show(slow.body)}`);
      await until("the slow turn to run", () => running(id), 15_000);
      const q = await post(`/api/sessions/${enc(id)}/message`, { text: "And after that, the greeting again.", profile: "gemini-fake", permissionMode: "bypassPermissions", clientId: qid });
      assert(q.status === 200 && q.body.via === "queued", `queued: ${q.status} ${show(q.body)}`);
      await until("a queue event with it", () => ev.seen.some((e) => e.type === "queue" && e.items.some((i) => i.id === qid)), 10_000);
      const s = await until("the queued message to be answered", async () => {
        const x = await session(id);
        const lastQ = ev.seen.filter((e) => e.type === "queue").at(-1);
        return x?.run?.status !== "running" && lastQ?.items.length === 0 && userTexts(x).length === 4 && x.entries.filter((e) => e.kind === "tool").length === 4 && x;
      }, 45_000);
      const users = userTexts(s);
      assert(users[2].includes("Take your time") && users[3].includes("the greeting again"), `order ${show(users)}`);
      assert(assistantText(s).includes("SLEPT"), "slow turn didn't finish");
    });

    await check("Stop ends a slow turn early", async () => {
      const before = (await session(id)).entries.length;
      const r = await post(`/api/sessions/${enc(id)}/message`, { text: "Sleep again.", profile: "gemini-slow", permissionMode: "bypassPermissions", clientId: cid("stop") });
      assert(r.status === 200 && r.body.via === "web", `send: ${r.status} ${show(r.body)}`);
      await until("the slow turn to run", () => running(id), 15_000);
      await sleep(1500);
      const t0 = Date.now();
      const c = await post(`/api/sessions/${enc(id)}/control`, { action: "stop" });
      assert(c.status === 200, `control: ${c.status}`);
      await until("the turn to stop", async () => !(await running(id)), 10_000);
      const took = Date.now() - t0;
      assert(took < 4500, `took ${took}ms, as long as the sleep`);
      await sleep(1500);
      const s = await session(id);
      const late = s.entries.slice(before).filter((e) => e.kind === "text" && e.text.includes("SLEPT"));
      assert(late.length === 0, "the stopped turn still answered");
    });

    await check("the session list has it, with its folder", async () => {
      const r = await get("/api/sessions");
      assert(r.status === 200, `got ${r.status}`);
      const row = r.body.sessions.find((x) => x.id === id);
      assert(row, "not listed");
      assert(row.cwd === repo, `cwd ${row.cwd}`);
    });

    await check("pin, rename and archive round-trip", async () => {
      const row = async () => (await get("/api/sessions")).body.sessions.find((x) => x.id === id);
      const a = await patch(`/api/sessions/${enc(id)}`, { pinned: true, title: "  Offline   check " });
      assert(a.status === 200 && a.body.pinned === true && a.body.title === "Offline check", `pin: ${a.status} ${show(a.body)}`);
      let r = await row();
      assert(r.pinned === true && r.title === "Offline check", `row ${show(r)}`);
      assert((await session(id)).title === "Offline check", "history title");
      const b = await patch(`/api/sessions/${enc(id)}`, { archived: true });
      assert(b.status === 200 && b.body.archived === true && b.body.pinned === false, `archive: ${show(b.body)}`);
      r = await row();
      assert(r.archived === true && !r.pinned, `row ${show(r)}`);
      const c = await patch(`/api/sessions/${enc(id)}`, { archived: false, title: null });
      assert(c.status === 200 && c.body.archived === false && c.body.title === null, `restore: ${show(c.body)}`);
      r = await row();
      assert(!r.archived && !r.pinned && r.title !== "Offline check", `row ${show(r)}`);
      const bad = await patch(`/api/sessions/${enc(id)}`, { color: "red" });
      assert(bad.status === 400, `unknown field: ${bad.status}`);
    });

    await check("git: checkpoints and the diff of the session folder", async () => {
      const g = await get(`/api/git?session=${enc(id)}`);
      assert(g.status === 200 && g.body.repo?.branch === "main", `git: ${g.status} ${show(g.body)}`);
      const cps = g.body.checkpoints;
      assert(cps.length >= 2, `checkpoints: ${cps.length}`);
      const d = await get(`/api/git/diff?session=${enc(id)}`);
      assert(d.status === 200 && d.body.files?.some((f) => f.path === "made.txt"), `diff: ${d.status} ${show(d.body)}`);
      const oldest = cps.at(-1);
      const dc = await get(`/api/git/diff?session=${enc(id)}&scope=checkpoint&checkpoint=${enc(oldest.id)}`);
      assert(dc.status === 200 && dc.body.files?.some((f) => f.path === "made.txt"), `since first checkpoint: ${dc.status} ${show(dc.body)}`);
      const since = await post("/api/git", { session: id, action: "since", id: oldest.id });
      assert(since.status === 200 && since.body.files?.some((f) => f.path === "made.txt"), `since: ${show(since.body)}`);
      assert(gitIn("log", "--oneline").trim().split("\n").length === 1, "checkpoints touched history");
      assert(gitIn("status", "--porcelain").trim() === "?? made.txt", "checkpoints touched the index");
    });
  }

  await check("files: list a folder and read a file", async () => {
    const l = await get(`/api/files?path=${enc(repo)}`);
    assert(l.status === 200 && l.body.kind === "dir", `list: ${l.status} ${show(l.body)}`);
    const names = l.body.entries.map((e) => e.name);
    assert(names.includes("README.md") && (!id || names.includes("made.txt")), `entries ${show(names)}`);
    const f = await get(`/api/files?path=${enc(path.join(repo, "README.md"))}`);
    assert(f.status === 200 && f.body.kind === "file" && f.body.text === true, `stat: ${show(f.body)}`);
    const raw = await get(`/api/files/raw?path=${enc(path.join(repo, "README.md"))}`);
    assert(raw.status === 200 && raw.text === "offline e2e\n", `raw: ${raw.status} ${raw.text.slice(0, 80)}`);
    assert(/sandbox/.test(raw.headers.get("content-security-policy") ?? ""), "raw file isn't sandboxed");
    const missing = await get(`/api/files?path=${enc(path.join(repo, "nope.txt"))}`);
    assert(missing.status === 404, `missing: ${missing.status}`);
  });
} catch (err) {
  results.push({ name: "setup", error: err?.message ?? String(err), secs: 0 });
} finally {
  ev?.close();
}

/* ── report ───────────────────────────────────────────── */

const failed = results.filter((r) => r.error);
const width = Math.max(...results.map((r) => r.name.length));
console.log(`\n${"".padEnd(width + 16, "─")}`);
for (const r of results) console.log(`${r.error ? "FAIL" : "PASS"}  ${r.name.padEnd(width)}  ${r.secs.toFixed(1).padStart(5)}s`);
console.log(`${"".padEnd(width + 16, "─")}\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) {
  for (const r of failed) console.log(`\nFAIL ${r.name}\n  ${r.error}`);
  const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").slice(-40).join("\n") : "";
  if (tail) console.log(`\nLast server output:\n${tail}`);
}
await cleanup();
process.exit(failed.length ? 1 : 0);
