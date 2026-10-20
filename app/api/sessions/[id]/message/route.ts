import { NextResponse, type NextRequest } from "next/server";
import { folderGone, parseMode, readJson, sessionContext, str } from "@/lib/server/http";
import { FOLDER_GONE, folderGoneMessage } from "@/lib/empty-states";
import { InputRefused, inputTarget, typeIntoTerminal } from "@/lib/server/input";
import { getRun, startRun } from "@/lib/server/runner";
import { claudeInTmux, startClaudeTui } from "@/lib/server/claude-tui";
import { liveTerminals } from "@/lib/server/sessions";
import { awaitLaunch, isLaunching } from "@/lib/server/launching";
import { parseSessionKey } from "@/lib/server/agents";
import { agentMessage } from "@/lib/server/agents/routes";
import { once } from "@/lib/server/dedupe";
import { guardTurn, sameStore } from "@/lib/server/fallback";
import { pickProfile, setSessionProfile } from "@/lib/server/profiles";
import { beforeTurn } from "@/lib/server/checkpoints";
import { parseEffort } from "@/lib/agent-traits";

export const dynamic = "force-dynamic";

const resuming = new Map<string, Promise<unknown>>();

/**
 * Sends a message to the one claude that owns this session; the server decides
 * where it goes, so a stale tab can't pick wrong:
 *  - a web run: straight into it
 *  - open in a terminal (zellij/tmux): typed into that pane
 *  - otherwise: resumed through the SDK under the same id
 * There is never a second claude or a copy.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  const body = await readJson(req);
  const key = parseSessionKey(decodeURIComponent(raw));
  if (!key) return NextResponse.json({ error: "Session not found." }, { status: 404 });
  const text = str(body.text)?.trim();
  const checkpointFirst = async () => text && (await beforeTurn(decodeURIComponent(raw), text));
  if (key.agent !== "claude") return once(body.clientId, async () => (await checkpointFirst(), agentMessage(key.agent, key.native, body)));
  return once(body.clientId, async () => (await checkpointFirst(), claudeMessage(key.native, body)));
}

async function claudeMessage(id: string, body: Record<string, unknown>): Promise<NextResponse> {
  const text = str(body.text)?.trim();
  if (!text) return NextResponse.json({ error: "Enter a message." }, { status: 400 });
  const before = pickProfile("claude", null, id);
  const profile = pickProfile("claude", body.profile, id);
  if (!sameStore(before, profile)) {
    return NextResponse.json({ error: `Can't switch this session to ${profile.label}. Use Continue in another agent.`, code: "other_store" }, { status: 409 });
  }
  const model = str(body.model) || undefined;
  /* undefined keeps what the run has (or the profile's default for a new one); null goes back to Claude's default */
  const effort = parseEffort("claude", body.effort);

  let existing = getRun(id);
  /* another account or proxy: the next turn runs in a new process on the same transcript */
  if (existing && (existing.profile?.id ?? "claude") !== profile.id && existing.state.status !== "running" && !existing.state.pending.length) {
    existing.close();
    existing = null;
  }
  if (existing) {
    if (effort !== undefined) await existing.setEffort(effort).catch(() => undefined);
    existing.send(text);
    guardTurn({ key: id, text, mode: existing.state.permissionMode, model, effort, profile: existing.profile ?? profile });
    return NextResponse.json({ id: existing.state.sessionId, via: "web" });
  }

  const findTerminal = () => liveTerminals(0).then((t) => t.get(id) ?? null);
  const [ctx, found] = await Promise.all([sessionContext(id), findTerminal()]);
  /* the session is being opened in a terminal: send there once it's up, never into a second claude */
  const terminal = found ?? (isLaunching(id) ? await awaitLaunch(id, findTerminal) : null);
  if (!ctx && !terminal) return NextResponse.json({ error: "Session not found." }, { status: 404 });

  if (terminal) {
    const target = await inputTarget(terminal.pid);
    if (!target) {
      return NextResponse.json(
        { error: "Can't send to this terminal. Reply there.", code: "no_pane" },
        { status: 409 },
      );
    }
    let queued = false;
    let cleared: string | null = null;
    try {
      ({ queued, cleared } = await typeIntoTerminal(target, text));
    } catch (err) {
      if (err instanceof InputRefused) return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
      return NextResponse.json({ error: `Couldn't send to the terminal: ${err instanceof Error ? err.message.slice(0, 160) : err}`, code: "terminal_error" }, { status: 500 });
    }
    return NextResponse.json({ id, via: "terminal", queued, cleared });
  }

  if (!ctx) return NextResponse.json({ error: "Session not found." }, { status: 404 });
  /* another request may have started a run while we were awaiting */
  const raced = getRun(id);
  if (raced) {
    if (effort !== undefined) await raced.setEffort(effort).catch(() => undefined);
    raced.send(text);
    setSessionProfile(id, (raced.profile ?? profile).id);
    guardTurn({ key: id, text, mode: raced.state.permissionMode, model, effort, profile: raced.profile ?? profile });
    return NextResponse.json({ id: raced.state.sessionId, via: "web" });
  }

  if (await folderGone(ctx.cwd)) return NextResponse.json({ error: folderGoneMessage(ctx.cwd), code: FOLDER_GONE }, { status: 409 });
  const mode = parseMode(body.permissionMode) ?? parseMode(ctx.meta.permissionMode) ?? "default";
  if (await claudeInTmux()) {
    /* a second message while the TUI is still starting is typed into it once it's up */
    const starting = resuming.get(id);
    if (starting) return starting.catch(() => undefined).then(() => claudeMessage(id, body));
    const launch = startClaudeTui({ profile, cwd: ctx.cwd, text, model, effort, permissionMode: mode, resume: id });
    resuming.set(id, launch);
    try {
      await launch;
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err), code: "tui_start" }, { status: 502 });
    } finally {
      resuming.delete(id);
    }
    setSessionProfile(id, profile.id);
    return NextResponse.json({ id, via: "terminal" });
  }
  const run = startRun({ resume: id, cwd: ctx.cwd, model, effort, permissionMode: mode, profile });
  run.send(text);
  setSessionProfile(id, profile.id);
  guardTurn({ key: id, text, mode, model, effort, profile });
  return NextResponse.json({ id, via: "web" });
}
