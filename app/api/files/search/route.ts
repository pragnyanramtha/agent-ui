import fs from "node:fs/promises";
import { NextResponse, type NextRequest } from "next/server";
import { FsError, fsFail, real } from "@/lib/server/files";
import { listFiles, rankFiles } from "@/lib/server/file-search";

export const dynamic = "force-dynamic";

/**
 * GET ?cwd=<abs folder>&q=<query>&limit=<n> → { root, files: [relative paths, best first], truncated }
 * Feeds the composer's @ picker.
 */
export async function GET(req: NextRequest) {
  const want = req.nextUrl.searchParams.get("cwd");
  const q = (req.nextUrl.searchParams.get("q") ?? "").slice(0, 200);
  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get("limit")) || 50, 1), 200);
  try {
    const root = await real(want);
    if (!(await fs.stat(root)).isDirectory()) throw new FsError(`${root} isn't a folder.`, 400);
    const { files, truncated } = await listFiles(root);
    return NextResponse.json({ root, files: rankFiles(files, q, limit), truncated });
  } catch (err) {
    return fsFail(err, want ?? "");
  }
}
