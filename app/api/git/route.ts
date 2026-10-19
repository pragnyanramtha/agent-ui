import { NextResponse, type NextRequest } from "next/server";
import { readJson, str } from "@/lib/server/http";
import { sessionCwd, turnRunning } from "@/lib/server/checkpoints";
import { autoFetch, checkpoint, checkpointSkip, commitAll, GitError, listCheckpoints, pull, pullRequest, push, rewind, sinceCheckpoint, status, suggestCommitMessage } from "@/lib/server/git";

export const dynamic = "force-dynamic";

const fail = (err: unknown) =>
  NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: err instanceof GitError ? err.status : 500 });

/** ?session=<id>: the session folder's branch and changes, and its checkpoints */
export async function GET(req: NextRequest) {
  const session = req.nextUrl.searchParams.get("session") ?? "";
  try {
    const cwd = await sessionCwd(session);
    if (!cwd) return NextResponse.json({ error: "Session not found." }, { status: 404 });
    const st = await status(cwd);
    if (!st) return NextResponse.json({ repo: null, cwd });
    /* the panel polls this while it's open, which keeps ahead/behind current */
    if (st.remote) void autoFetch(st.root);
    return NextResponse.json({ repo: st, cwd, checkpoints: await listCheckpoints(cwd, session), checkpointSkip: checkpointSkip(st.root, session) });
  } catch (err) {
    return fail(err);
  }
}

/** { session, action: "checkpoint" | "since" | "rewind" | "commit" | "push" | "pull" | "pr" | "suggest-message", id?, message?, title? } */
export async function POST(req: NextRequest) {
  const body = await readJson(req);
  const session = str(body.session) ?? "";
  try {
    const cwd = await sessionCwd(session);
    if (!cwd) return NextResponse.json({ error: "Session not found." }, { status: 404 });
    const id = str(body.id) ?? "";
    switch (body.action) {
      case "checkpoint": {
        const cp = await checkpoint(cwd, session, str(body.message) || "Manual checkpoint");
        if (!cp) throw new GitError(`${cwd} isn't a git repository.`, 404);
        return NextResponse.json({ checkpoint: cp });
      }
      case "since":
        return NextResponse.json({ files: await sinceCheckpoint(cwd, session, id) });
      case "rewind":
        if (await turnRunning(session)) throw new GitError("Stop the turn first.", 409);
        return NextResponse.json(await rewind(cwd, session, id));
      case "commit":
        return NextResponse.json({ commit: await commitAll(cwd, str(body.message) ?? "") });
      case "push":
        return NextResponse.json({ branch: await push(cwd) });
      case "pull":
        return NextResponse.json({ branch: await pull(cwd) });
      case "suggest-message":
        return NextResponse.json(await suggestCommitMessage(cwd));
      case "pr":
        return NextResponse.json({ url: await pullRequest(cwd, str(body.title)) });
      default:
        return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }
  } catch (err) {
    return fail(err);
  }
}
