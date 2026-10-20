import { NextResponse, type NextRequest } from "next/server";
import { parseMode, readJson, str } from "@/lib/server/http";
import { getRun } from "@/lib/server/runner";
import { parseSessionKey } from "@/lib/server/agents";
import { agentControl } from "@/lib/server/agents/routes";

export const dynamic = "force-dynamic";

/** Interrupt the current turn, switch permission mode, model or effort, or shut the web run down. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  const body = await readJson(req);
  const key = parseSessionKey(decodeURIComponent(raw));
  if (!key) return NextResponse.json({ error: "Session not found." }, { status: 404 });
  if (key.agent !== "claude") return agentControl(key.agent, key.native, body);
  const id = key.native;
  const run = getRun(id);
  if (!run) return NextResponse.json({ error: "Nothing is running." }, { status: 404 });

  try {
    if (body.action === "interrupt") await run.interrupt();
    else if (body.action === "stop") run.close();
    else if (body.action === "mode") {
      const mode = parseMode(body.value);
      if (!mode) return NextResponse.json({ error: "Unknown approval mode." }, { status: 400 });
      await run.setPermissionMode(mode);
    } else if (body.action === "model") await run.setModel(str(body.value) || undefined);
    else if (body.action === "effort") await run.setEffort(str(body.value) || null);
    else return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
