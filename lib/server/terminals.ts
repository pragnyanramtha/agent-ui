import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentId, PermissionMode, ServerTerminal } from "@/lib/types";
import { modelFor, type ResolvedProfile } from "./profiles";

/* Long-lived terminals on the server, owned by the pty backend (server/pty.mjs). They keep
 * running with no browser attached, so an agent started from a phone keeps working when the
 * phone sleeps or the laptop is off. */

const PORT = Number(process.env.PTY_PORT ?? 3312);
const key = () => createHmac("sha256", process.env.UI_SECRET ?? "").update("agent-u pty internal").digest("base64url");

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      method,
      headers: { "x-agent-u-internal": key(), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("The terminal backend isn't running (agent-u-pty).");
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Terminal backend: HTTP ${res.status}`);
  return data;
}

export const listTerminals = () => call<{ terminals: ServerTerminal[]; tmux: boolean }>("GET", "/internal/terminals");
export const killTerminal = (id: string) => call<{ ok: boolean }>("POST", "/internal/kill", { id });

/** argv (after the binary) that opens an agent's own TUI, resuming `session` when given. */
export function interactiveArgs(
  agent: AgentId,
  o: { session?: string | null; model?: string | null; cwd: string; newSession?: string | null; permissionMode?: PermissionMode | null },
): string[] {
  const m = o.model ?? null;
  const s = o.session ?? null;
  switch (agent) {
    case "claude": {
      const mode = o.permissionMode && o.permissionMode !== "default" ? o.permissionMode : null;
      return [
        ...(s ? ["--resume", s] : o.newSession ? ["--session-id", o.newSession] : []),
        ...(m ? ["--model", m] : []),
        ...(mode ? ["--permission-mode", mode] : []),
        /* Bypass otherwise stops at a confirmation screen the first time */
        ...(mode === "bypassPermissions" ? ["--settings", '{"skipDangerousModePermissionPrompt":true}'] : []),
      ];
    }
    case "codex":
      return [...(s ? ["resume", s] : []), ...(m ? ["-m", m] : [])];
    case "opencode":
      return [o.cwd, ...(s ? ["-s", s] : []), ...(m ? ["-m", m] : [])];
    case "cursor":
      return [...(s ? ["--resume", s] : []), ...(m ? ["--model", m] : [])];
    case "devin":
      return [...(s ? ["--resume", s] : []), ...(m ? ["--model", m] : [])];
    case "kimi":
      return [...(s ? ["-S", s] : []), ...(m ? ["-m", m] : [])];
  }
}

export type Launch = {
  profile: ResolvedProfile;
  cwd: string;
  session?: string | null;
  sessionKey?: string | null;
  model?: string | null;
  cols?: number;
  rows?: number;
  /** a fresh session under this id (Claude's --session-id) */
  newSession?: string | null;
  permissionMode?: PermissionMode | null;
  /** first message, submitted as the TUI starts */
  prompt?: string | null;
  /** "tmux" fails rather than fall back to a plain pty the web can't type into */
  backing?: "tmux";
};

/* one argument may hold at most 128 KiB on Linux */
const MAX_PROMPT_BYTES = 120 * 1024;

/** Starts the profile's agent in a kept terminal; resolves with the terminal id. */
export async function launchAgent(l: Launch) {
  const p = l.profile;
  const bin = p.bin ? p.binPath : (p.binPath ?? (p.agent === "claude" ? "claude" : null));
  if (!bin) throw new Error(`${p.label} isn't installed on the server.`);
  const model = p.agent === "claude" ? modelFor(p, l.model) : (l.model ?? p.defaultModel ?? null);
  const args = [
    ...p.args,
    ...(p.launchArgs ?? []),
    ...interactiveArgs(p.agent, { session: l.session, model, cwd: l.cwd, newSession: l.newSession, permissionMode: l.permissionMode }),
  ];
  const where = l.cwd.split("/").filter(Boolean).pop() ?? l.cwd;
  let promptFile: string | null = null;
  if (l.prompt) {
    if (Buffer.byteLength(l.prompt) > MAX_PROMPT_BYTES) throw new Error("That message is too long to start a terminal session with. Attach it as a file instead.");
    promptFile = path.join(os.tmpdir(), `agent-u-prompt-${randomBytes(8).toString("hex")}`);
    await fs.writeFile(promptFile, l.prompt, { mode: 0o600 });
  }
  try {
    return await call<{ id: string; backing: "tmux" | "pty" }>("POST", "/internal/launch", {
      cmd: bin,
      args,
      env: p.env,
      cwd: l.cwd,
      label: `${p.label}${l.session ? " (resumed)" : ""} in ${where}`,
      profile: p.id,
      session: l.sessionKey ?? null,
      cols: l.cols,
      rows: l.rows,
      promptFile,
      backing: l.backing,
    });
  } catch (err) {
    if (promptFile) await fs.rm(promptFile, { force: true });
    throw err;
  }
}
