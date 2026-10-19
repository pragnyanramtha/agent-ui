import { NextResponse, type NextRequest } from "next/server";
import { COOKIE, newSessionEpoch } from "@/lib/auth";
import { readJson } from "@/lib/server/http";

/** {everywhere: true} also ends every other browser's session (and the terminals' sockets) */
export async function POST(req: NextRequest) {
  if ((await readJson(req)).everywhere === true) newSessionEpoch();
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(COOKIE);
  return res;
}
