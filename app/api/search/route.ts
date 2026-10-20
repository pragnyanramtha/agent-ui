import { NextResponse, type NextRequest } from "next/server";
import { searchMessages } from "@/lib/server/search";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (q.length < 2 || q.length > 200) return NextResponse.json({ error: "Search for 2 to 200 characters." }, { status: 400 });
  return NextResponse.json(await searchMessages(q, { signal: req.signal }));
}
