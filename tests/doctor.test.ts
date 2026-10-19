import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ResolvedProfile } from "@/lib/server/profiles";

/* Fake CLIs in a temp dir on PATH: ones that print a version, one that hangs, one that fails, and a name that
 * isn't anywhere. The real Gemini CLI is checked too when it's installed. */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentu-doctor-"));
const bin = path.join(tmp, "bin");
const other = path.join(tmp, "other-bin");
const SECRET = "sk-very-secret-value-123";
const GEMINI = path.join(os.homedir(), ".local", "bin", "gemini");
const saved = { PATH: process.env.PATH, AGENT_U_HOME: process.env.AGENT_U_HOME, AGENT_U_CONFIG: process.env.AGENT_U_CONFIG };

const script = (dir: string, name: string, body: string) => {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return f;
};

let doctor: typeof import("@/lib/server/doctor");
let profiles: typeof import("@/lib/server/profiles");
const byId = (id: string) => {
  const p = profiles.getProfile(id);
  if (!p) throw new Error(`no profile ${id}`);
  return p;
};

beforeAll(async () => {
  script(bin, "codex", `if [ "$1" = login ]; then [ "$FAKE_LOGIN" = 1 ] && { echo "Logged in using ChatGPT"; exit 0; }; echo "Not logged in" >&2; exit 1; fi\necho "codex-cli 9.9.9"`);
  script(other, "codex", `echo "codex-cli 1.0.0-other"`);
  script(bin, "slowpoke", "sleep 30");
  script(bin, "broken", `echo "fatal: bad config ${SECRET}" >&2\nexit 3`);
  script(bin, "fake-claude", `echo "2.1.0 (Claude Code)"`);
  script(bin, "cursor-agent", `if [ "$1" = status ]; then echo "Logged in as someone"; exit 0; fi\necho "2026.10.01-abc"`);
  const claudeDir = path.join(tmp, "claude-home");
  fs.mkdirSync(claudeDir);
  fs.writeFileSync(path.join(claudeDir, ".credentials.json"), "{}");
  const config = {
    profiles: [
      { id: "codex", label: "Codex", agent: "codex", env: { FAKE_LOGIN: "1", CODEX_HOME: path.join(tmp, "codex-home") } },
      { id: "codex-out", label: "Codex (signed out)", agent: "codex", env: { CODEX_HOME: path.join(tmp, "codex-out") } },
      { id: "codex-path", label: "Codex (own PATH)", agent: "codex", env: { PATH: `${other}:/usr/bin:/bin`, FAKE_LOGIN: "1" } },
      { id: "hangs", label: "Hangs", agent: "opencode", bin: "slowpoke" },
      { id: "broken", label: "Broken", agent: "kimi", bin: "broken", env: { KIMI_API_KEY: SECRET } },
      { id: "gone", label: "Gone", agent: "codex", bin: "agentu-no-such-cli" },
      { id: "claude-key", label: "Claude key", agent: "claude", bin: path.join(bin, "fake-claude"), env: { ANTHROPIC_API_KEY: SECRET } },
      { id: "claude-creds", label: "Claude creds", agent: "claude", bin: path.join(bin, "fake-claude"), env: { CLAUDE_CONFIG_DIR: claudeDir } },
      { id: "claude-out", label: "Claude out", agent: "claude", bin: path.join(bin, "fake-claude"), env: { CLAUDE_CONFIG_DIR: path.join(tmp, "nothing"), ANTHROPIC_API_KEY: "" } },
      { id: "cursor-in", label: "Cursor", agent: "cursor", bin: "cursor-agent", env: { CURSOR_API_KEY: "" } },
      { id: "gem-key", label: "Gemini key", agent: "gemini", bin: GEMINI, env: { GEMINI_API_KEY: "fake-gemini-key", GEMINI_CLI_HOME: path.join(tmp, "gem-a") } },
      { id: "gem-out", label: "Gemini out", agent: "gemini", bin: GEMINI, env: { GEMINI_API_KEY: "", GOOGLE_API_KEY: "", GOOGLE_GENAI_USE_VERTEXAI: "", GEMINI_CLI_HOME: path.join(tmp, "gem-b") } },
    ],
  };
  fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify(config));
  process.env.AGENT_U_HOME = tmp;
  process.env.AGENT_U_CONFIG = path.join(tmp, "config.json");
  process.env.PATH = `${bin}:${saved.PATH}`;
  profiles = await import("@/lib/server/profiles");
  doctor = await import("@/lib/server/doctor");
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("run", () => {
  it("kills a command that hangs and reports the timeout", async () => {
    const t0 = Date.now();
    const r = await doctor.run(path.join(bin, "slowpoke"), [], { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it("reports a missing binary instead of throwing", async () => {
    const r = await doctor.run(path.join(tmp, "nope"), ["--version"], { timeoutMs: 500 });
    expect(r.missing).toBe(true);
  });

  it("closes stdin so a CLI waiting for input ends at once", async () => {
    const cat = script(bin, "reads-stdin", 'read line; echo "got:$line"');
    const r = await doctor.run(cat, [], { timeoutMs: 2000 });
    expect(r.timedOut).toBe(false);
    expect(r.out.trim()).toBe("got:");
  });

  it("firstLine keeps the first useful line and blanks secrets", () => {
    expect(doctor.firstLine(`\n  \x1b[32mv1.2\x1b[0m token ${SECRET}\nmore`, [SECRET])).toBe("v1.2 token ••••••");
    expect(doctor.firstLine("x".repeat(300))).toHaveLength(120);
  });
});

describe("agent profiles", () => {
  it("lists every effective profile, built-ins included", async () => {
    const ids = profiles.allProfiles().map((p) => p.id);
    for (const a of ["claude", "codex", "opencode", "cursor", "devin", "kimi", "gemini", "antigravity", "hangs", "gone"]) expect(ids).toContain(a);
  });

  it("finds the binary on PATH, reads its version and the codex sign-in", async () => {
    const c = await doctor.checkProfile(byId("codex"));
    expect(c).toMatchObject({ id: "profile:codex", status: "ok" });
    expect(c.detail).toContain(path.join(bin, "codex"));
    expect(c.detail).toContain("codex-cli 9.9.9");
    expect(c.detail).toContain("Signed in");
  });

  it("warns with a login command when codex login status fails, keeping the profile's CODEX_HOME", async () => {
    const c = await doctor.checkProfile(byId("codex-out"));
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("Not signed in");
    expect(c.fix).toBe(`CODEX_HOME=${path.join(tmp, "codex-out")} codex login`);
  });

  it("respects a PATH set in the profile's env", async () => {
    const c = await doctor.checkProfile(byId("codex-path"));
    expect(c.detail).toContain(path.join(other, "codex"));
    expect(c.detail).toContain("1.0.0-other");
  });

  it("gives up on a CLI that hangs within the timeout", async () => {
    const t0 = Date.now();
    const c = await doctor.checkProfile(byId("hangs"), 400);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(c.status).toBe("warn");
    expect(c.detail).toMatch(/No answer to --version/);
  });

  it("fails a CLI whose --version exits non-zero, without printing the profile's secrets", async () => {
    const c = await doctor.checkProfile(byId("broken"));
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("exit 3");
    expect(c.detail).toContain("fatal: bad config");
    expect(JSON.stringify(c)).not.toContain(SECRET);
  });

  it("fails a configured binary that isn't anywhere, with an install command", async () => {
    const c = await doctor.checkProfile(byId("gone"));
    expect(c).toMatchObject({ status: "fail", detail: "agentu-no-such-cli not found", fix: "npm install -g @openai/codex" });
  });

  it("keeps an unused built-in neutral", async () => {
    const c = await doctor.checkProfile(byId("devin"));
    expect(c).toMatchObject({ status: "unknown", detail: "Not installed" });
  });

  it("claude: an API key in the profile counts as signed in, and its value never shows", async () => {
    const c = await doctor.checkProfile(byId("claude-key"));
    expect(c.status).toBe("ok");
    expect(c.detail).toContain("2.1.0 (Claude Code)");
    expect(c.detail).toContain("ANTHROPIC_API_KEY set");
    expect(JSON.stringify(c)).not.toContain(SECRET);
  });

  it("claude: a credentials file in CLAUDE_CONFIG_DIR counts as signed in", async () => {
    expect((await doctor.checkProfile(byId("claude-creds"))).detail).toContain("Signed in");
    const out = await doctor.checkProfile(byId("claude-out"));
    expect(out.status).toBe("warn");
    expect(out.fix).toBe(`CLAUDE_CONFIG_DIR=${path.join(tmp, "nothing")} ${path.join(bin, "fake-claude")}`);
  });

  it("cursor: asks cursor-agent status when there's no API key", async () => {
    const c = await doctor.checkProfile(byId("cursor-in"));
    expect(c.status).toBe("ok");
    expect(c.detail).toContain("2026.10.01-abc");
    expect(c.detail).toContain("Signed in");
  });

  it.runIf(fs.existsSync(GEMINI))("gemini (real CLI): version and an API key", async () => {
    const c = await doctor.checkProfile(byId("gem-key"), 15_000);
    expect(c.status).toBe("ok");
    expect(c.detail).toMatch(/\d+\.\d+\.\d+/);
    expect(c.detail).toContain("GEMINI_API_KEY set");
    expect(c.detail).not.toContain("fake-gemini-key");
  });

  it.runIf(fs.existsSync(GEMINI))("gemini (real CLI): no key and no oauth file means signed out, then an oauth file signs in", async () => {
    const out = await doctor.checkProfile(byId("gem-out"), 15_000);
    expect(out.status).toBe("warn");
    expect(out.fix).toBe(`GEMINI_CLI_HOME=${path.join(tmp, "gem-b")} ${GEMINI}`);
    fs.mkdirSync(path.join(tmp, "gem-b", ".gemini"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "gem-b", ".gemini", "oauth_creds.json"), "{}");
    const c = await doctor.checkProfile(byId("gem-out"), 15_000);
    expect(c.status).toBe("ok");
    expect(c.detail).toContain("Signed in");
  });
});

describe("server checks", () => {
  let server: http.Server;
  let port = 0;
  let status = 200;
  let header = "";
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      header = String(req.headers["x-agent-u-internal"] ?? "");
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ terminals: [{}, {}], tmux: true }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("terminal service: ok when it answers with the app's key", async () => {
    status = 200;
    const c = await doctor.checkTerminalService(port);
    expect(c).toMatchObject({ status: "ok", detail: `Port ${port} · 2 running` });
    expect(header).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  });

  it("terminal service: a rejected key and a closed port fail with a restart command", async () => {
    status = 401;
    expect(await doctor.checkTerminalService(port)).toMatchObject({ status: "fail", fix: "systemctl --user restart agent-u agent-u-pty" });
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const dead = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    expect(await doctor.checkTerminalService(dead)).toMatchObject({ status: "fail", detail: `Nothing on port ${dead}`, fix: "systemctl --user restart agent-u-pty" });
  });

  it("terminal service: a server that never answers times out", async () => {
    const silent = http.createServer(() => undefined);
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
    const p = (silent.address() as AddressInfo).port;
    const t0 = Date.now();
    const c = await doctor.checkTerminalService(p, 300);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(c).toMatchObject({ status: "fail", detail: `No answer on port ${p}` });
    silent.closeAllConnections();
    await new Promise<void>((r) => silent.close(() => r()));
  });

  it("push: counts subscriptions, never shows keys, and doesn't create a file", () => {
    const file = path.join(tmp, "push.json");
    expect(doctor.checkPush(file).status).toBe("unknown");
    expect(fs.existsSync(file)).toBe(false);
    fs.writeFileSync(file, JSON.stringify({ publicKey: "PUBLIC-KEY-XYZ", privateKey: "PRIVATE-KEY-XYZ", subs: [] }));
    expect(doctor.checkPush(file).status).toBe("warn");
    fs.writeFileSync(file, JSON.stringify({ publicKey: "PUBLIC-KEY-XYZ", privateKey: "PRIVATE-KEY-XYZ", subs: [{ endpoint: "https://a" }, { endpoint: "https://b" }] }));
    const c = doctor.checkPush(file);
    expect(c).toMatchObject({ status: "ok", detail: "2 devices subscribed" });
    expect(JSON.stringify(c)).not.toMatch(/KEY-XYZ/);
  });

  it("disk: one row per filesystem, for folders that don't exist yet too", async () => {
    const rows = await doctor.checkDisk([
      { id: "home", label: "Disk space", dir: tmp },
      { id: "worktrees", label: "Disk space (worktrees)", dir: path.join(tmp, "not", "yet") },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).toMatch(/free of/);
    expect(["ok", "warn", "fail"]).toContain(rows[0].status);
  });

  it("runDoctor runs everything in parallel within the timeout", async () => {
    status = 200;
    const t0 = Date.now();
    const r = await doctor.runDoctor({ timeoutMs: 500, ptyPort: port, home: tmp, worktreeRoot: path.join(tmp, "wt"), pushPath: path.join(tmp, "push.json") });
    expect(Date.now() - t0).toBeLessThan(2500);
    const ids = r.checks.map((c) => c.id);
    for (const id of ["profile:claude", "profile:codex", "profile:hangs", "profile:gone", "pty", "tool:tmux", "tool:zellij", "tool:python3", "tool:git", "tool:gh", "push", "disk:home"]) expect(ids).toContain(id);
    for (const c of r.checks) {
      expect(["ok", "warn", "fail", "unknown"]).toContain(c.status);
      expect(typeof c.label).toBe("string");
      expect(typeof c.detail).toBe("string");
    }
    expect(r.checks.find((c) => c.id === "profile:hangs")?.status).toBe("warn");
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
});
