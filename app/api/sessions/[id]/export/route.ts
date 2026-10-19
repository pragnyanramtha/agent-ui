import { NextResponse, type NextRequest } from "next/server";
import { collectSession, exportFilename, toJson, toMarkdown, TOOL_DETAILS, type ToolDetail } from "@/lib/server/export";

export const dynamic = "force-dynamic";

/** The whole session as a download: ?format=md|json (default md), ?tools=summary|full|none for Markdown (default summary). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  const format = req.nextUrl.searchParams.get("format") ?? "md";
  const tools = req.nextUrl.searchParams.get("tools") ?? "summary";
  if (format !== "md" && format !== "json") return NextResponse.json({ error: "Unknown format. Use md or json." }, { status: 400 });
  if (!(TOOL_DETAILS as string[]).includes(tools)) return NextResponse.json({ error: "Unknown tools option. Use summary, full or none." }, { status: 400 });
  let session;
  try {
    session = await collectSession(decodeURIComponent(raw));
  } catch (err) {
    return NextResponse.json({ error: `Couldn't export: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 });
  }
  if (!session) return NextResponse.json({ error: "Session not found." }, { status: 404 });
  const now = new Date();
  const body =
    format === "json"
      ? `${JSON.stringify(toJson(session, now), null, 2)}\n`
      : toMarkdown(session.entries, { title: session.title, agent: session.agent, cwd: session.cwd, tools: tools as ToolDetail, exportedAt: now });
  return new Response(body, {
    headers: {
      "Content-Type": format === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFilename(session.title, session.entries, format, now)}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
