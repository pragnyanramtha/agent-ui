import { createHmac } from "node:crypto";
import type { AgentId, ServerTerminal } from "@/lib/types";
import type { ResolvedProfile } from "./profiles";
import { effortArgs } from "@/lib/agent-traits";

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
    throw new Error("Terminal service isn't running (agent-u-pty).");
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Terminal service error (${res.status}).`);
  return data;
}

export const listTerminals = () => call<{ terminals: ServerTerminal[]; tmux: boolean }>("GET", "/internal/terminals");
export const killTerminal = (id: string) => call<{ ok: boolean }>("POST", "/internal/kill", { id });

/** argv (after the binary) that opens an agent's own TUI, resuming `session` when given. */
export function interactiveArgs(agent: AgentId, o: { session?: string | null; model?: string | null; effort?: string | null; cwd: string }): string[] {
  const m = o.model ?? null;
  const s = o.session ?? null;
  const e = effortArgs(agent, o.effort);
  switch (agent) {
    case "claude":
      return [...(s ? ["--resume", s] : []), ...(m ? ["--model", m] : []), ...e];
    case "codex":
      return [...(s ? ["resume", s] : []), ...(m ? ["-m", m] : []), ...e];
    case "opencode":
      return [o.cwd, ...(s ? ["-s", s] : []), ...(m ? ["-m", m] : [])];
    case "cursor":
      return [...(s ? ["--resume", s] : []), ...(m ? ["--model", m] : [])];
    case "devin":
      return [...(s ? ["--resume", s] : []), ...(m ? ["--model", m] : [])];
    case "kimi":
      return [...(s ? ["-S", s] : []), ...(m ? ["-m", m] : [])];
    case "gemini":
      return [...(s ? ["--resume", s] : []), ...(m ? ["-m", m] : [])];
    case "antigravity":
      return [...(s ? ["--conversation", s] : []), ...(m ? ["--model", m] : [])];
  }
}

/** `effort`: undefined uses the profile's default, null none */
export type Launch = { profile: ResolvedProfile; cwd: string; session?: string | null; sessionKey?: string | null; model?: string | null; effort?: string | null; cols?: number; rows?: number };

/** Starts the profile's agent in a kept terminal; resolves with the terminal id. */
export async function launchAgent(l: Launch) {
  const p = l.profile;
  const bin = p.bin ? p.binPath : (p.binPath ?? (p.agent === "claude" ? "claude" : null));
  if (!bin) throw new Error(`${p.label} isn't installed.`);
  const args = [...p.args, ...(p.launchArgs ?? []), ...interactiveArgs(p.agent, { session: l.session, model: l.model ?? p.defaultModel ?? null, effort: l.effort === undefined ? p.defaultEffort : l.effort, cwd: l.cwd })];
  const where = l.cwd.split("/").filter(Boolean).pop() ?? l.cwd;
  return call<{ id: string; backing: "tmux" | "pty" }>("POST", "/internal/launch", {
    cmd: bin,
    args,
    env: p.env,
    cwd: l.cwd,
    label: `${p.label}${l.session ? " (resumed)" : ""} in ${where}`,
    profile: p.id,
    session: l.sessionKey ?? null,
    cols: l.cols,
    rows: l.rows,
  });
}

/** The user's shell and its argv for one command line: the line is a single argument, never pasted into another. */
export function commandArgv(command: string, shell = process.env.SHELL): [string, string[]] {
  return [shell && shell.startsWith("/") ? shell : "/bin/sh", ["-c", command]];
}

/** Runs a command line (a project's Run action) in a kept terminal in `cwd`; resolves with the terminal id.
 * The terminal service starts it from a login shell, so PATH and the profile match an ssh session. */
export async function launchCommand(o: { cwd: string; command: string; label: string; cols?: number; rows?: number }) {
  const [cmd, args] = commandArgv(o.command);
  return call<{ id: string; backing: "tmux" | "pty" }>("POST", "/internal/launch", { cmd, args, env: {}, cwd: o.cwd, label: o.label, profile: null, session: null, cols: o.cols, rows: o.rows });
}
