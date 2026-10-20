import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { startRun } from "@/lib/server/runner";
import { claudeInTmux, startClaudeTui, TuiStartError } from "@/lib/server/claude-tui";
import { sessionRows } from "@/lib/server/rows";
import { parseMode, readJson, str } from "@/lib/server/http";
import type { AgentId } from "@/lib/types";
import { agentStart } from "@/lib/server/agents/routes";
import { once } from "@/lib/server/dedupe";
import { guardTurn } from "@/lib/server/fallback";
import { pickProfile, setSessionProfile } from "@/lib/server/profiles";
import { beforeTurn } from "@/lib/server/checkpoints";
import { GitError, moveCheckpoints, newWorktree } from "@/lib/server/git";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await sessionRows();
  const projects = [...new Set(rows.map((s) => s.cwd).filter(Boolean))].slice(0, 30);
  return NextResponse.json({ sessions: rows, projects });
}

export async function POST(req: NextRequest) {
  const body = await readJson(req);
  return once(body.clientId, () => startWithGit(body));
}

/* an optional worktree to start in, and a checkpoint of the folder before the first turn (kept under a
 * provisional key until the session has its id) */
async function startWithGit(body: Record<string, unknown>) {
  const cwd = str(body.cwd)?.trim();
  const text = str(body.text)?.trim();
  let worktree: { dir: string; branch: string } | null = null;
  if (body.worktree === true && cwd && text) {
    try {
      worktree = await newWorktree(cwd, text.slice(0, 40));
    } catch (err) {
      return NextResponse.json({ error: `Couldn't make a worktree: ${(err as Error).message}` }, { status: err instanceof GitError ? err.status : 500 });
    }
    body = { ...body, cwd: worktree.dir };
  }
  const dir = str(body.cwd)?.trim();
  const provisional = `pending-${crypto.randomUUID()}`;
  if (dir && text && path.isAbsolute(dir)) await beforeTurn(provisional, text, dir);
  const res = await start(body);
  if (res.ok && dir) {
    const data = (await res.clone().json().catch(() => null)) as { id?: string } | null;
    if (data?.id) {
      const agent = str(body.agent) as AgentId | undefined;
      const key = agent && agent !== "claude" && !data.id.includes(":") ? `${agent}:${data.id}` : data.id;
      await moveCheckpoints(dir, provisional, key).catch(() => undefined);
      if (worktree) return NextResponse.json({ ...data, worktree });
    }
  }
  return res;
}

async function start(body: Record<string, unknown>) {
  const agent = str(body.agent) as AgentId | undefined;
  if (agent && agent !== "claude") return agentStart(agent, body);
  const text = str(body.text)?.trim();
  const cwd = str(body.cwd)?.trim();
  if (!text) return NextResponse.json({ error: "Write a first message to start the session." }, { status: 400 });
  if (!cwd || !path.isAbsolute(cwd) || !(await fs.stat(cwd).then((s) => s.isDirectory()).catch(() => false))) {
    return NextResponse.json({ error: `No folder at ${cwd || "(empty)"} on the server.` }, { status: 400 });
  }
  const profile = pickProfile("claude", body.profile, null);
  const model = str(body.model) || undefined;
  const mode = parseMode(body.permissionMode) ?? "default";
  if (await claudeInTmux()) {
    try {
      const { id, terminal } = await startClaudeTui({ profile, cwd, text, model, permissionMode: mode });
      setSessionProfile(id, profile.id);
      return NextResponse.json({ id, terminal });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err), terminal: err instanceof TuiStartError ? err.terminal : undefined }, { status: 502 });
    }
  }
  const run = startRun({ cwd, model, permissionMode: mode, profile });
  run.send(text);
  const id = await Promise.race([run.sessionId(), new Promise<string>((r) => setTimeout(() => r(""), 90_000))]);
  if (!id) {
    run.close();
    return NextResponse.json({ error: run.state.error ?? "Claude didn't start within 90 seconds." }, { status: 502 });
  }
  setSessionProfile(id, profile.id);
  guardTurn({ key: id, text, mode, model, profile });
  return NextResponse.json({ id });
}
