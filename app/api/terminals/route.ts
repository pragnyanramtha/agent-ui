import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { parseSessionKey, sessionKey } from "@/lib/server/agents";
import { adapterFor } from "@/lib/server/agents";
import { readJson, sessionContext, str } from "@/lib/server/http";
import { getProfile, pickProfile } from "@/lib/server/profiles";
import { getRun } from "@/lib/server/runner";
import { killTerminal, launchAgent, listTerminals } from "@/lib/server/terminals";
import { terminalForKey } from "@/lib/server/agents/bridge";

/* a double tap (or two devices) must not start two TUIs on one session */
const launching = new Map<string, Promise<Response>>();

export const dynamic = "force-dynamic";

/** Terminals the server keeps (shells and agents started from the web), running or recently finished. */
export async function GET() {
  try {
    return NextResponse.json(await listTerminals());
  } catch (err) {
    return NextResponse.json({ terminals: [], tmux: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Starts an agent's own TUI in a kept terminal: { profile, cwd } for a new session,
 * or { session } to open an existing one interactively (its folder and agent come from the session).
 */
export async function POST(req: NextRequest) {
  const body = await readJson(req);
  const raw = str(body.session);
  const lockKey = raw ? `s:${raw}` : null;
  if (!lockKey) return launch(body, raw);
  const busy = launching.get(lockKey);
  if (busy) return (await busy).clone();
  const p = launch(body, raw);
  launching.set(lockKey, p);
  try {
    return await p;
  } finally {
    launching.delete(lockKey);
  }
}

async function launch(body: Record<string, unknown>, raw: string | undefined): Promise<Response> {
  let cwd = str(body.cwd)?.trim() ?? "";
  let profile = getProfile(str(body.profile));
  let native: string | null = null;
  let key: string | null = null;
  if (raw) {
    const k = parseSessionKey(raw);
    if (!k) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    key = sessionKey(k.agent, k.native);
    native = k.native;
    /* already open somewhere: rejoin that instead of resuming a second copy */
    const kept = (await listTerminals().catch(() => null))?.terminals.find((t) => t.session === key && t.exited === null);
    if (kept) return NextResponse.json({ ...kept, label: kept.label });
    if (k.agent === "claude") {
      const run = getRun(k.native);
      if (run?.state.status === "running" && body.takeover !== true) {
        return NextResponse.json({ error: "Claude is working on a message from the web.", code: "busy" }, { status: 409 });
      }
      /* the SDK run ends mid-turn; the TUI resumes the same transcript */
      if (run && body.takeover === true) run.close();
      cwd = (await sessionContext(k.native))?.cwd ?? cwd;
    } else {
      const a = await adapterFor(k.agent);
      if (a?.runState(k.native)?.status === "running") return NextResponse.json({ error: `${a.label} is working on a message from the web. Open the terminal once it's done.`, code: "busy" }, { status: 409 });
      cwd = (await a?.get(k.native))?.cwd ?? cwd;
    }
    profile = pickProfile(k.agent, str(body.profile), key);
    let live = await terminalForKey(key);
    /* a headless (Agent SDK) process has no screen to join: stop it, when asked, and open the session here */
    if (live?.headless && body.takeover === true) {
      if (!(await stopProcess(live.pid))) return NextResponse.json({ error: "Couldn't stop the program running this session." }, { status: 409 });
      live = null;
    }
    if (live) {
      return NextResponse.json(
        live.headless
          ? { error: "Another program is running this session through the Agent SDK.", code: "headless" }
          : { error: live.multiplexer ? `This session is already open in ${live.multiplexer}. Open that instead.` : "This session is already running in another terminal or program. Continue it there.", code: "live_terminal" },
        { status: 409 },
      );
    }
  }
  if (!profile) return NextResponse.json({ error: "Pick an agent profile." }, { status: 400 });
  if (cwd === "~" || cwd.startsWith("~/")) cwd = path.join(os.homedir(), cwd.slice(1));
  if (!cwd || !path.isAbsolute(cwd) || !(await fs.stat(cwd).then((s) => s.isDirectory()).catch(() => false))) {
    return NextResponse.json({ error: `No folder at ${cwd || "(empty)"} on the server.` }, { status: 400 });
  }
  /* the idle web run hands the session over only once the launch can actually happen */
  if (key && native && parseSessionKey(key)?.agent === "claude") getRun(native)?.close();
  try {
    const t = await launchAgent({ profile, cwd, session: native, sessionKey: key, model: str(body.model) || null, cols: Number(body.cols) || undefined, rows: Number(body.rows) || undefined });
    return NextResponse.json({ ...t, label: profile.label });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}

/** SIGTERM, then SIGKILL after 5 seconds; resolves once the process is gone. */
async function stopProcess(pid: number) {
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return !alive();
  }
  for (let i = 0; i < 70 && alive(); i++) {
    if (i === 50) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* exited meanwhile */
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return !alive();
}

export async function DELETE(req: NextRequest) {
  const id = str((await readJson(req)).id);
  if (!id) return NextResponse.json({ error: "Which terminal?" }, { status: 400 });
  try {
    return NextResponse.json(await killTerminal(id));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
