import { NextResponse, type NextRequest } from "next/server";
import { parseMode, sessionContext } from "@/lib/server/http";
import { getRun } from "@/lib/server/runner";
import { terminalFor } from "@/lib/server/sessions";
import { metaTitle, readHistory } from "@/lib/server/transcript";
import { parseSessionKey, sessionKey } from "@/lib/server/agents";
import { agentHistory } from "@/lib/server/agents/routes";
import { getSessionMeta, parseSessionMetaPatch, pickProfile, setSessionMeta } from "@/lib/server/profiles";

export const dynamic = "force-dynamic";

/**
 * Without `before`: the latest history page plus session state (same shape as the SSE history event, with `end`).
 * With `before`: an older page, walking backwards from that byte offset.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  const key = parseSessionKey(decodeURIComponent(raw));
  if (!key) return NextResponse.json({ error: "Session not found." }, { status: 404 });
  const beforeParam = req.nextUrl.searchParams.get("before");
  const custom = beforeParam === null ? getSessionMeta(sessionKey(key.agent, key.native)).title : undefined;
  if (key.agent !== "claude") {
    const res = await agentHistory(key.agent, key.native, beforeParam);
    if (!custom || !res.ok) return res;
    const data = (await res.json()) as Record<string, unknown>;
    return NextResponse.json({ ...data, title: custom });
  }
  const id = key.native;
  const ctx = await sessionContext(id);
  const run = getRun(id);
  if (beforeParam === null) {
    const terminal = await terminalFor(id, Boolean(run));
    /* a terminal session that hasn't written its transcript yet still exists */
    if (!ctx && !run && !terminal) return NextResponse.json({ error: "Session not found." }, { status: 404 });
    const page = ctx ? await readHistory(ctx.file) : { entries: [], cursor: null, end: 0 };
    return NextResponse.json({
      type: "history",
      entries: run ? [...page.entries, ...run.extras] : page.entries,
      cursor: page.cursor,
      end: page.end,
      terminal,
      run: run ? run.state : null,
      title: custom ?? (ctx && metaTitle(ctx.meta)) ?? "New session",
      cwd: ctx?.cwd ?? run?.cwd ?? terminal?.cwd ?? "",
      permissionMode: parseMode(ctx?.meta.permissionMode),
      profile: (run?.profile ?? pickProfile("claude", null, id)).id,
    });
  }
  if (!ctx) return NextResponse.json({ error: "Session not found." }, { status: 404 });
  const before = Math.floor(Number(beforeParam));
  if (!Number.isFinite(before) || before <= 0) return NextResponse.json({ entries: [], cursor: null });
  const { entries, cursor } = await readHistory(ctx.file, before);
  return NextResponse.json({ entries, cursor });
}

/** Pin, archive or rename: { pinned?: boolean, archived?: boolean, title?: string | null }. An empty title clears it. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  const key = parseSessionKey(decodeURIComponent(raw));
  if (!key) return NextResponse.json({ error: "Session not found." }, { status: 404 });
  const patch = parseSessionMetaPatch(await req.json().catch(() => null));
  if (typeof patch === "string") return NextResponse.json({ error: patch }, { status: 400 });
  try {
    const meta = setSessionMeta(sessionKey(key.agent, key.native), patch);
    return NextResponse.json({ ok: true, pinned: Boolean(meta.pinned), archived: Boolean(meta.archived), title: meta.title ?? null });
  } catch (err) {
    return NextResponse.json({ error: `Couldn't save: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 });
  }
}
