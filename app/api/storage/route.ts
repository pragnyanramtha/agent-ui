import { NextResponse, type NextRequest } from "next/server";
import { noteCleanup, planCleanup, runCleanup, storageReport } from "@/lib/server/storage";

export const dynamic = "force-dynamic";

/** Disk used by worktrees and attachments, checkpoint refs, the cleanup policies and the last cleanup. */
export async function GET(req: NextRequest) {
  const fresh = req.nextUrl.searchParams.get("fresh") === "1";
  return NextResponse.json(await storageReport({ fresh }), { headers: { "Cache-Control": "no-store" } });
}

/** `{ action: "plan" }` lists what a cleanup would remove (nothing is touched); `{ action: "clean", paths }` removes
 * those of them that still qualify under the policies. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { action?: unknown; paths?: unknown } | null;
  if (body?.action === "plan") return NextResponse.json(await planCleanup());
  if (body?.action === "clean") {
    const paths = Array.isArray(body.paths) ? body.paths.filter((p): p is string => typeof p === "string") : null;
    if (!paths?.length) return NextResponse.json({ error: "Nothing to clean up." }, { status: 400 });
    const result = await runCleanup({ only: paths });
    noteCleanup(result);
    return NextResponse.json(result);
  }
  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
