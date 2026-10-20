import { NextResponse, type NextRequest } from "next/server";
import { once } from "./dedupe";
import { GitError } from "./git";
import { readJson } from "./http";
import { branch, BranchError } from "./branch";
import { parseBranchBody, type BranchKind } from "./branch-shape";

/** POST /api/sessions/[id]/fork and /edit: validate, then start the new session; answers { id } of it. */
export async function branchRoute(req: NextRequest, raw: string, kind: BranchKind) {
  const body = await readJson(req);
  return once(body.clientId, async () => {
    const parsed = parseBranchBody(kind, body);
    if (typeof parsed === "string") return NextResponse.json({ error: parsed }, { status: 400 });
    try {
      const id = await branch(decodeURIComponent(raw), kind, parsed, body.effort);
      return NextResponse.json({ id });
    } catch (err) {
      const status = err instanceof BranchError || err instanceof GitError ? err.status : 500;
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status });
    }
  });
}
