#!/usr/bin/env node
/* Live end-to-end checks against a running agent-u (run on the server, from the app folder):
 *   node scripts/e2e.mjs            # app on 127.0.0.1:3311, terminal backend on 127.0.0.1:3312
 *   E2E_AGENT=cursor E2E_MODEL=auto node scripts/e2e.mjs
 * Uses real agent turns (they cost tokens). Signs its own session cookie from UI_SECRET in .env.local. */

import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const env = Object.fromEntries(
  fs
    .readFileSync(".env.local", "utf8")
    .split("\n")
    .map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(l))
    .filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]),
);
const APP = process.env.E2E_APP ?? "http://127.0.0.1:3311";
const PTY = process.env.E2E_PTY ?? `127.0.0.1:${env.PTY_PORT || 3312}`;
const AGENT = process.env.E2E_AGENT ?? "cursor";
const expires = Date.now() + 3600_000;
/* signed as lib/auth.ts does: expiry, session epoch (auth.json next to config.json) and password */
const authFile = path.join(env.AGENT_U_HOME || process.env.AGENT_U_HOME || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "agent-u"), "auth.json");
const epoch = fs.existsSync(authFile) ? (() => { try { return JSON.parse(fs.readFileSync(authFile, "utf8")).epoch || "invalid"; } catch { return "invalid"; } })() : "";
const COOKIE = `cui_session=${expires}.${createHmac("sha256", env.UI_SECRET).update(`${expires}\n${epoch}\n${env.UI_PASSWORD_HASH || env.UI_PASSWORD || ""}`).digest("base64url")}`;
const headers = { Cookie: COOKIE, Origin: APP, "Content-Type": "application/json" };

let failed = 0;
const results = [];
async function check(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push(`ok    ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (err) {
    failed++;
    results.push(`FAIL  ${name}: ${err?.message ?? err}`);
  }
  console.log(results.at(-1));
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 120_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}
const get = async (p, h = headers) => {
  const r = await fetch(APP + p, { headers: h, redirect: "manual" });
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
};
const post = async (p, body, h = headers) => {
  const r = await fetch(APP + p, { method: "POST", headers: h, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
};
const enc = encodeURIComponent;
const cid = (tag) => `e2e${Date.now().toString(36)}${tag}`;

/** the live event stream, as the browser reads it */
function events(id) {
  const ac = new AbortController();
  const seen = [];
  (async () => {
    const r = await fetch(`${APP}/api/sessions/${enc(id)}/events`, { method: "POST", headers, body: "{}", signal: ac.signal });
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
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
const idle = (id) => until(`${id} to go idle`, async () => (await session(id))?.run?.status !== "running" && (await session(id)));

/* ── auth ─────────────────────────────────────────────── */

await check("API refuses requests without a session cookie", async () => {
  const r = await get("/api/sessions", { Origin: APP });
  assert(r.status === 401, `got ${r.status}`);
});
await check("API refuses state changes from another origin", async () => {
  const r = await post("/api/sessions/x/message", { text: "hi" }, { ...headers, Origin: "https://evil.example" });
  assert(r.status === 403, `got ${r.status}`);
});
await check("API refuses a forged cookie", async () => {
  const r = await get("/api/sessions", { Cookie: `cui_session=${expires}.forged`, Origin: APP });
  assert(r.status === 401, `got ${r.status}`);
});

/* ── models ───────────────────────────────────────────── */

let model = process.env.E2E_MODEL;
await check(`models list for ${AGENT}`, async () => {
  const r = await get(`/api/agents/models?agent=${AGENT}`);
  assert(r.status === 200, `got ${r.status}`);
  const keys = (r.body.models ?? []).map((m) => m.key);
  assert(keys.length > 0, "no models");
  model ??= keys.find((k) => /^auto$/.test(k)) ?? keys.find((k) => /fast|mini|flash/.test(k)) ?? keys[0];
  console.log(`      ${keys.length} models, using ${model}`);
});
await check("sessions list loads", async () => {
  const r = await get("/api/sessions");
  assert(r.status === 200 && Array.isArray(r.body.sessions ?? r.body), `got ${r.status}`);
});

await check("push: a server key, the worker without a cookie, bad subscriptions refused", async () => {
  const k = await get("/api/push");
  assert(k.status === 200 && /^[A-Za-z0-9_-]{80,}$/.test(k.body?.publicKey ?? ""), `key: ${k.status}`);
  const sw = await fetch(`${APP}/sw.js`, { redirect: "manual" });
  assert(sw.status === 200 && (await sw.text()).includes("showNotification"), `sw.js: ${sw.status}`);
  const bad = await post("/api/push", { subscription: { endpoint: "http://insecure.example/x", keys: { p256dh: "a", auth: "b" } } });
  assert(bad.status === 400, `bad subscription: ${bad.status}`);
  const anon = await fetch(`${APP}/api/push`, { redirect: "manual" });
  assert(anon.status === 401, `no cookie: ${anon.status}`);
});

/* ── queue, dedupe, unqueue, transcript, context ──────── */

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentu-e2e-"));
let id = "";
await check(`start a ${AGENT} session`, async () => {
  const r = await post("/api/sessions", { agent: AGENT, cwd, model, permissionMode: "bypassPermissions", text: "Reply with exactly the word ALPHA and nothing else.", clientId: cid("start") });
  assert(r.status === 200 && r.body.id, `got ${r.status} ${JSON.stringify(r.body)}`);
  id = r.body.id;
  console.log(`      ${id}`);
});

if (id) {
  const ev = events(id);
  const ids = { bravo: cid("b"), charlie: cid("c"), delta: cid("d") };
  const send = (text, clientId) => post(`/api/sessions/${enc(id)}/message`, { text, clientId, model, permissionMode: "bypassPermissions" });

  await check("messages sent mid-turn are queued, a retried send is answered once", async () => {
    await until("the first turn to run", async () => (await session(id))?.run?.status === "running", 30_000).catch(() => undefined);
    const b = await send("Reply with exactly the word BRAVO and nothing else.", ids.bravo);
    const again = await send("Reply with exactly the word BRAVO and nothing else.", ids.bravo);
    const c = await send("Reply with exactly the word CHARLIE and nothing else.", ids.charlie);
    const d = await send("Reply with exactly the word DELTA and nothing else.", ids.delta);
    assert(b.status === 200 && c.status === 200 && d.status === 200, `statuses ${b.status} ${c.status} ${d.status}`);
    assert(again.headers.get("x-agent-u-replay") === "1", "retry wasn't a replay");
    assert(c.body.via === "queued" && d.body.via === "queued", `via ${b.body.via} ${c.body.via} ${d.body.via}`);
  });

  await check("the stream reports the queue, and Remove takes one back", async () => {
    await until("a queue event with CHARLIE", async () => ev.seen.some((e) => e.type === "queue" && e.items.some((i) => i.id === ids.charlie)), 10_000);
    const r = await post(`/api/sessions/${enc(id)}/control`, { action: "unqueue", value: ids.charlie });
    assert(r.status === 200, `got ${r.status}`);
    await until("CHARLIE gone from the queue", async () => {
      const last = ev.seen.filter((e) => e.type === "queue").at(-1);
      return last && !last.items.some((i) => i.id === ids.charlie);
    }, 10_000);
  });

  let done;
  await check("the queue drains in order, once each, without the removed one", async () => {
    done = await until("all turns to finish", async () => {
      const s = await session(id);
      const lastQ = ev.seen.filter((e) => e.type === "queue").at(-1);
      return s?.run?.status !== "running" && (!lastQ || lastQ.items.length === 0) && userTexts(s).length >= 3 && /DELTA/.test(assistantText(s)) && s;
    }, 240_000);
    const users = userTexts(done).map((t) => /ALPHA|BRAVO|CHARLIE|DELTA/.exec(t)?.[0]);
    assert(JSON.stringify(users) === JSON.stringify(["ALPHA", "BRAVO", "DELTA"]), `user turns ${JSON.stringify(users)}`);
    const said = assistantText(done);
    for (const w of ["ALPHA", "BRAVO", "DELTA"]) assert(said.includes(w), `no ${w} reply`);
    assert(!said.includes("CHARLIE"), "removed message ran");
  });

  await check("the stream carried live text and run status", async () => {
    assert(ev.seen[0]?.type === "history", "first event isn't history");
    assert(ev.seen.some((e) => e.type === "run" && e.run?.status === "running"), "no running status");
    assert(ev.seen.some((e) => e.type === "entries"), "no entries");
  });

  await check("context usage carries the model's window", async () => {
    const u = done?.entries.filter((e) => e.kind === "usage") ?? [];
    assert(u.length > 0, "no usage entries");
    const last = u.at(-1);
    console.log(`      ${last.model}: ${last.input + last.cacheRead + last.cacheWrite} of ${last.window ?? "(no window)"}`);
    if (AGENT === "cursor" || AGENT === "codex") assert(last.window > 0, "no window");
  });

  await check("Send now jumps the queue and stops the running turn", async () => {
    const longId = cid("long");
    const long = await send("Run the shell command `sleep 45` and then reply with exactly the word SLEPT.", longId);
    assert(long.status === 200, `got ${long.status}`);
    await until("the long turn to run", async () => (await session(id))?.run?.status === "running", 30_000);
    const echo = cid("echo");
    const foxtrot = cid("fox");
    await send("Reply with exactly the word ECHO and nothing else.", echo);
    await send("Reply with exactly the word FOXTROT and nothing else.", foxtrot);
    const t0 = Date.now();
    const r = await post(`/api/sessions/${enc(id)}/control`, { action: "sendQueued", value: foxtrot });
    assert(r.status === 200, `got ${r.status}`);
    const s = await until("ECHO after FOXTROT", async () => {
      const x = await session(id);
      return x?.run?.status !== "running" && /ECHO/.test(assistantText(x)) && x;
    }, 240_000);
    const order = userTexts(s).map((t) => /SLEPT|ECHO|FOXTROT/.exec(t)?.[0]).filter(Boolean);
    /* a turn stopped before the agent saved its prompt leaves no trace; the client must hear it never ran */
    if (order[0] !== "SLEPT") {
      const lost = await until("an unsent event for the stopped prompt", () => ev.seen.some((e) => e.type === "unsent" && e.items.some((i) => i.id === longId)), 10_000).catch(() => false);
      assert(lost, `stopped prompt vanished silently; order ${JSON.stringify(order)}`);
      console.log("      stopped prompt wasn't saved by the agent; reported as unsent");
      const again = events(id);
      const replayed = await until("unsent replayed on reconnect", () => again.seen.some((e) => e.type === "unsent" && e.items.some((i) => i.id === longId)), 10_000).catch(() => false);
      again.close();
      assert(replayed, "a reconnecting client isn't told about the unsent prompt");
    }
    assert(JSON.stringify(order.filter((w) => w !== "SLEPT")) === JSON.stringify(["FOXTROT", "ECHO"]), `order ${JSON.stringify(order)}`);
    assert(Date.now() - t0 < 200_000, "took too long");
  });

  await check("a prompt longer than one command-line argument allows still goes through", async () => {
    const filler = "lorem ipsum dolor sit amet ".repeat(2700);
    const r = await send(`Ignore the filler text after this line and reply with exactly the word LONGOK.\n\n${filler}`, cid("long70k"));
    assert(r.status === 200, `got ${r.status} ${JSON.stringify(r.body)}`);
    await until("LONGOK", async () => {
      const x = await session(id);
      return x?.run?.status !== "running" && /LONGOK/.test(assistantText(x));
    }, 180_000);
  });

  await check("an attached file reaches the agent by path", async () => {
    const a = await post("/api/attachments", {});
    assert(a.status === 200 && a.body?.dir, `attachments: ${a.status}`);
    const word = `ATT${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const bytes = new TextEncoder().encode(`The secret word is ${word}.\n`);
    const q = new URLSearchParams({ dir: a.body.dir, name: "note.txt", offset: "0", total: String(bytes.length), key: "e2e" });
    const up = await fetch(`${APP}/api/files/upload?${q}`, { method: "POST", headers: { ...headers, "Content-Type": "application/octet-stream" }, body: bytes });
    assert(up.ok, `upload: ${up.status}`);
    const r = await send(`Read the attached file and reply with only the secret word in it.\n\nAttached files:\n- ${a.body.dir}/note.txt`, cid("attach"));
    assert(r.status === 200, `got ${r.status} ${JSON.stringify(r.body)}`);
    await until(word, async () => {
      const x = await session(id);
      return x?.run?.status !== "running" && assistantText(x).includes(word);
    }, 180_000);
  });

  await check("history pages back without losing or repeating entries", async () => {
    const s = await session(id);
    const all = s.entries.map((e) => e.id);
    assert(new Set(all).size === all.length, "duplicate entry ids");
    if (s.cursor !== null && s.cursor !== undefined) {
      const older = await get(`/api/sessions/${enc(id)}?before=${enc(String(s.cursor))}`);
      assert(older.status === 200, `got ${older.status}`);
      const overlap = (older.body.entries ?? []).filter((e) => all.includes(e.id));
      assert(overlap.length === 0, `${overlap.length} repeated`);
    }
  });

  await check("an empty message is refused, an unknown session is 404", async () => {
    assert((await send("   ", cid("empty"))).status === 400, "empty accepted");
    assert((await get(`/api/sessions/${enc(`${AGENT}:00000000-0000-0000-0000-000000000000`)}`)).status === 404, "unknown session found");
  });
  ev.close();
}

/* ── git: checkpoints, rewind, worktree ───────────────── */

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "agentu-e2e-git-"));
const gitIn = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@e2e", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@e2e" } });
gitIn("init", "-q", "-b", "main");
fs.writeFileSync(path.join(repo, "README.md"), "e2e\n");
gitIn("add", "-A");
gitIn("commit", "-qm", "init");
let gid = "";
await check("git: a checkpoint before each turn, changes since, and rewind", async () => {
  const r = await post("/api/sessions", { agent: AGENT, cwd: repo, model, permissionMode: "bypassPermissions", text: "Reply with exactly the word READY.", clientId: cid("gstart") });
  assert(r.status === 200 && r.body.id, `start: ${r.status} ${JSON.stringify(r.body)}`);
  gid = r.body.id;
  const g0 = await get(`/api/git?session=${enc(gid)}`);
  assert(g0.status === 200 && g0.body.repo?.branch === "main", `git: ${g0.status} ${JSON.stringify(g0.body)}`);
  assert(g0.body.checkpoints.length === 1, `first message checkpoint: ${g0.body.checkpoints.length}`);
  await until("READY", async () => {
    const x = await session(gid);
    return x?.run?.status !== "running" && /READY/.test(assistantText(x));
  }, 180_000);
  const m = await post(`/api/sessions/${enc(gid)}/message`, { text: "Create a file named made.txt containing the word MADE. Then reply DONE.", clientId: cid("gmake"), model, permissionMode: "bypassPermissions" });
  assert(m.status === 200, `message: ${m.status}`);
  await until("made.txt", async () => {
    const x = await session(gid);
    return x?.run?.status !== "running" && fs.existsSync(path.join(repo, "made.txt"));
  }, 180_000);
  const g1 = await get(`/api/git?session=${enc(gid)}`);
  const cps = g1.body.checkpoints;
  assert(cps.length >= 1, "no checkpoints");
  const before = cps[0];
  const since = await post("/api/git", { session: gid, action: "since", id: before.id });
  assert(since.body.files?.some((f) => f.path === "made.txt"), `since: ${JSON.stringify(since.body)}`);
  const rw = await post("/api/git", { session: gid, action: "rewind", id: before.id });
  assert(rw.status === 200 && rw.body.removed >= 1, `rewind: ${rw.status} ${JSON.stringify(rw.body)}`);
  assert(!fs.existsSync(path.join(repo, "made.txt")), "made.txt still there");
  assert(gitIn("log", "--oneline").trim().split("\n").length === 1, "rewind touched history");
  const undo = await post("/api/git", { session: gid, action: "rewind", id: rw.body.undo });
  assert(undo.status === 200 && fs.existsSync(path.join(repo, "made.txt")), "undo didn't bring made.txt back");
});

await check("git: commit from the panel", async () => {
  const c = await post("/api/git", { session: gid, action: "commit", message: "e2e commit" });
  assert(c.status === 200 && c.body.commit, `commit: ${c.status} ${JSON.stringify(c.body)}`);
  assert(gitIn("log", "-1", "--format=%s").trim() === "e2e commit", "not committed");
  const p = await post("/api/git", { session: gid, action: "push" });
  assert(p.status === 400 && /no remote/i.test(p.body.error), `push without remote: ${p.status}`);
});

await check("git: a session can start in its own worktree", async () => {
  const r = await post("/api/sessions", { agent: AGENT, cwd: repo, model, worktree: true, permissionMode: "bypassPermissions", text: "Reply with exactly the word TREE.", clientId: cid("wt") });
  assert(r.status === 200 && r.body.worktree?.branch?.startsWith("agent-u/"), `worktree: ${r.status} ${JSON.stringify(r.body)}`);
  assert(gitIn("worktree", "list").includes(r.body.worktree.dir), "not in worktree list");
  const g = await get(`/api/git?session=${enc(r.body.id)}`);
  assert(g.body.repo?.branch === r.body.worktree.branch, `session branch: ${g.body.repo?.branch}`);
  await until("TREE", async () => {
    const x = await session(r.body.id);
    return x?.run?.status !== "running" && /TREE/.test(assistantText(x));
  }, 180_000);
  gitIn("worktree", "remove", "--force", r.body.worktree.dir);
});

/* ── inbox: an approval shows in the list and is answered from it ── */

if (process.env.E2E_CLAUDE !== "0") {
  await check("inbox: a Claude approval shows in the session list and Allow from there runs it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentu-e2e-inbox-"));
    const r = await post("/api/sessions", { cwd: dir, model: process.env.E2E_CLAUDE_MODEL || "claude-haiku-5-5", permissionMode: "default", text: "Use the Bash tool to run exactly: echo INBOXOK > inbox.txt. Then reply DONE.", clientId: cid("inbox") });
    assert(r.status === 200 && r.body.id, `start: ${r.status} ${JSON.stringify(r.body)}`);
    const row = await until("the approval in the list", async () => {
      const l = await get("/api/sessions");
      const s = (l.body.sessions ?? []).find((x) => x.id === r.body.id);
      return s?.web?.pending?.length ? s : null;
    }, 120_000);
    const ask = row.web.pending[0];
    assert(ask.kind === "permission" && /bash/i.test(ask.toolName), `ask: ${JSON.stringify(ask)}`);
    const a = await post(`/api/sessions/${enc(r.body.id)}/respond`, { requestId: ask.requestId, allow: true });
    assert(a.status === 200, `respond: ${a.status}`);
    await until("inbox.txt", async () => fs.existsSync(path.join(dir, "inbox.txt")), 120_000);
    await post(`/api/sessions/${enc(r.body.id)}/control`, { action: "stop" }).catch(() => undefined);
  });
}

/* ── web terminal backend ─────────────────────────────── */

function ws(query) {
  const sock = new WebSocket(`ws://${PTY}/pty?${query}`, { headers: { Origin: `http://${PTY}`, Cookie: COOKIE } });
  const c = { out: "", msgs: [], sock };
  sock.on("message", (d, bin) => (bin ? (c.out += d.toString()) : c.msgs.push(JSON.parse(d.toString()))));
  sock.on("error", () => undefined);
  c.closed = new Promise((r) => sock.on("close", (code) => r(code)));
  c.type = (data) => sock.send(JSON.stringify({ type: "input", data }));
  return c;
}

await check("web terminal: a shell runs commands", async () => {
  const c = ws(`cwd=${enc(cwd)}`);
  await until("hello", () => c.msgs.some((m) => m.type === "hello"), 10_000);
  c.type("echo e2e-$((6*7))\r");
  await until("echo output", () => c.out.includes("e2e-42"), 10_000);
  c.type("exit\r");
  await c.closed;
});

await check("web terminal: attaches to a tmux session and types into it", async () => {
  const name = `agentu-e2e-${process.pid}`;
  execFileSync("tmux", ["new-session", "-d", "-s", name, "-x", "100", "-y", "30", "cat"]);
  try {
    const c = ws(`tmux=${enc(name)}`);
    await until("hello", () => c.msgs.some((m) => m.type === "hello"), 10_000);
    c.type("typed-through-tmux\r");
    await until("pane to show it", () => execFileSync("tmux", ["capture-pane", "-p", "-t", name]).toString().includes("typed-through-tmux"), 10_000);
    c.sock.close();
  } finally {
    execFileSync("tmux", ["kill-session", "-t", name]);
  }
});

await check("web terminal: refuses a bad cookie with 4401", async () => {
  const sock = new WebSocket(`ws://${PTY}/pty?cwd=/`, { headers: { Origin: `http://${PTY}`, Cookie: "cui_session=1.bad" } });
  sock.on("error", () => undefined);
  const code = await new Promise((r) => sock.on("close", r));
  assert(code === 4401, `got ${code}`);
});

fs.rmSync(cwd, { recursive: true, force: true });
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
