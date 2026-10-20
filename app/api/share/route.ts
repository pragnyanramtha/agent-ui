import { NextResponse, type NextRequest } from "next/server";
import { SHARE_ID } from "@/lib/share";
import { sharedById } from "@/lib/server/share";

export const dynamic = "force-dynamic";

/** GET ?id=: the text and attachments of a share (app/share/route.ts), for the new session's composer. */
export function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") ?? "";
  const shared = SHARE_ID.test(id) ? sharedById(id) : null;
  if (!shared) return NextResponse.json({ error: "Nothing was shared, or it was too long ago." }, { status: 404 });
  return NextResponse.json(shared);
}
