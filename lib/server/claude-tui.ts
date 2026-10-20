import { randomUUID } from "node:crypto";
import type { PermissionMode } from "@/lib/types";
import { CLAUDE_WEB_DRIVER } from "./config";
import { paneScreen, pressKey, type InputTarget } from "./input";
import type { ResolvedProfile } from "./profiles";
import { findSessionFile, liveTerminals } from "./sessions";
import { launchAgent, listTerminals } from "./terminals";

/* Web-started Claude sessions run Claude's own TUI in a kept tmux session, like a session someone
 * opened in zellij: it survives app restarts, opens interactively from the web, attaches from a
 * shell (`tmux attach -t agentu-…`), takes every terminal command (/goal included), and further
 * messages are typed into its pane (lib/server/input.ts). */

let tmuxSeen: { at: number; ok: boolean } | null = null;

/** Whether web turns for Claude go to a TUI in tmux (else the Agent SDK). */
export async function claudeInTmux() {
  if (CLAUDE_WEB_DRIVER !== "tmux") return false;
  if (tmuxSeen && Date.now() - tmuxSeen.at < 60_000) return tmuxSeen.ok;
  const ok = await listTerminals()
    .then((t) => t.tmux)
    .catch(() => false);
  tmuxSeen = { at: Date.now(), ok };
  return ok;
}

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Answers the folder trust dialog a TUI shows in a folder it hasn't seen (the web user picked the
 * folder, which is the trust). The dialog may focus "No, exit" and hide option numbers, so the
 * selection is moved onto "Yes, I trust" before Enter. Returns whether the dialog was on screen.
 */
async function answerTrust(target: InputTarget) {
  const screen = (await paneScreen(target).catch(() => "")).replace(ANSI, "");
  if (!/Yes, I trust this folder/.test(screen)) return false;
  const focused = screen.split("\n").find((l) => l.trimStart().startsWith("❯"));
  await pressKey(target, focused && /Yes, I trust/.test(focused) ? "Enter" : "Down").catch(() => undefined);
  return true;
}

export class TuiStartError extends Error {
  readonly terminal: string;
  constructor(message: string, terminal: string) {
    super(message);
    this.terminal = terminal;
  }
}

/**
 * Starts (or resumes) a Claude session in a TUI with `text` as its first message, and waits until
 * Claude has the session open: the transcript exists (new) or its live status file names it (resume).
 */
export async function startClaudeTui(o: { profile: ResolvedProfile; cwd: string; text: string; model?: string | null; permissionMode: PermissionMode; resume?: string | null }) {
  const id = o.resume ?? randomUUID();
  const t = await launchAgent({
    profile: o.profile,
    cwd: o.cwd,
    session: o.resume ?? null,
    newSession: o.resume ? null : id,
    sessionKey: id,
    model: o.model,
    permissionMode: o.permissionMode,
    prompt: o.text,
    backing: "tmux",
  });
  const target: InputTarget = { kind: "tmux", pane: t.id };
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await sleep(500);
    if (await answerTrust(target)) continue;
    const ready = o.resume ? (await liveTerminals(0)).has(id) : Boolean(await findSessionFile(id));
    if (ready) return { id, terminal: t.id };
    const kept = (await listTerminals().catch(() => null))?.terminals.find((x) => x.id === t.id);
    if (kept?.exited) {
      const tail = (await paneScreen(target).catch(() => "")).replace(ANSI, "").split("\n").filter((l) => l.trim()).slice(-4).join(" / ");
      throw new TuiStartError(`Claude exited before it started${tail ? `: ${tail.slice(0, 240)}` : "."}`, t.id);
    }
  }
  throw new TuiStartError("Claude didn't start within 90 seconds. It may be waiting on a question in its terminal.", t.id);
}
