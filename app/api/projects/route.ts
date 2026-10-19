import { NextResponse, type NextRequest } from "next/server";
import { projectBranch, projectIcon } from "@/lib/server/project-icon";

export const dynamic = "force-dynamic";

const MAX_DIRS = 60;

/** ?dir=<folder> (repeatable): each folder's favicon path (read it through /api/files/raw), or null.
 * ?branch=<folder>: the branch checked out there, or null. Both are cached per folder on the server. */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const branch = params.get("branch");
  if (branch !== null) return NextResponse.json({ branch: await projectBranch(branch) });
  const dirs = [...new Set(params.getAll("dir"))].slice(0, MAX_DIRS);
  const found = await Promise.all(dirs.map(async (d) => [d, await projectIcon(d)] as const));
  return NextResponse.json({ icons: Object.fromEntries(found) }, { headers: { "Cache-Control": "private, max-age=60" } });
}
