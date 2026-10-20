import type { NextRequest } from "next/server";
import { branchRoute } from "@/lib/server/branch-route";

export const dynamic = "force-dynamic";

/** { entryId, text, checkpoint?, permissionMode?, model?, profile?, effort?, clientId? }: a new session with the
 * conversation before the prompt `entryId`, sent `text` in its place. With `checkpoint` the files go back to it first. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return branchRoute(req, (await params).id, "edit");
}
