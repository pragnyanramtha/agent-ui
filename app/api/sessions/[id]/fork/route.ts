import type { NextRequest } from "next/server";
import { branchRoute } from "@/lib/server/branch-route";

export const dynamic = "force-dynamic";

/** { entryId, text?, permissionMode?, model?, profile?, effort?, clientId? }: a new session with the conversation up to
 * and including the reply `entryId` (its whole turn). Claude's copy needs no message; other agents start with `text`. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return branchRoute(req, (await params).id, "fork");
}
