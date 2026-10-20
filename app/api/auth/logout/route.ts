import { NextResponse, type NextRequest } from "next/server";
import { COOKIE, newSessionEpoch } from "@/lib/auth";
import { readJson, str } from "@/lib/server/http";
import { unsubscribe, unsubscribeAll } from "@/lib/server/push";

/** {everywhere: true} also ends every other browser's session (and the terminals' sockets) and drops every push
 * subscription; {endpoint} drops this browser's */
export async function POST(req: NextRequest) {
  const body = await readJson(req);
  if (body.everywhere === true) {
    newSessionEpoch();
    unsubscribeAll();
  } else {
    const endpoint = str(body.endpoint);
    if (endpoint) unsubscribe(endpoint);
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(COOKIE);
  return res;
}
