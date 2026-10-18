import { NextResponse, type NextRequest } from "next/server";
import { sessionCwd } from "@/lib/server/checkpoints";
import { diff, GitError, type DiffScope } from "@/lib/server/git";

export const dynamic = "force-dynamic";

const SCOPES: DiffScope[] = ["uncommitted", "checkpoint", "branch"];

/** ?session=<id>&scope=uncommitted|checkpoint|branch&checkpoint=<id>&ws=1: the folder's changes as parsed patch files */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const session = q.get("session") ?? "";
  const scope = (q.get("scope") ?? "uncommitted") as DiffScope;
  if (!SCOPES.includes(scope)) return NextResponse.json({ error: "Unknown scope." }, { status: 400 });
  const checkpoint = q.get("checkpoint") ?? "";
  if (scope === "checkpoint" && !checkpoint) return NextResponse.json({ error: "Choose a checkpoint." }, { status: 400 });
  try {
    const cwd = await sessionCwd(session);
    if (!cwd) return NextResponse.json({ error: "Session not found." }, { status: 404 });
    return NextResponse.json(await diff(cwd, session, { scope, checkpoint, ignoreWhitespace: q.get("ws") === "1" }));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: err instanceof GitError ? err.status : 500 });
  }
}
