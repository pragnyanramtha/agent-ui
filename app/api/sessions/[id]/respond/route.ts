import { NextResponse, type NextRequest } from "next/server";
import { readJson, str } from "@/lib/server/http";
import { getRun } from "@/lib/server/runner";
import { parseSessionKey, sessionKey } from "@/lib/server/agents";
import { answerTurn } from "@/lib/server/agents/cli-run";
import { once } from "@/lib/server/dedupe";

export const dynamic = "force-dynamic";

/** Answers a pending tool approval or AskUserQuestion prompt. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await readJson(req);
  /* a retry after a lost reply gets the first answer instead of "already closed" */
  return once(body.clientId, async () => answer(id, body));
}

async function answer(id: string, body: Record<string, unknown>) {
  const requestId = str(body.requestId);
  if (!requestId) return NextResponse.json({ error: "Nothing is waiting for an answer." }, { status: 404 });
  const key = parseSessionKey(decodeURIComponent(id));
  if (key && key.agent !== "claude") {
    const ok = answerTurn(sessionKey(key.agent, key.native), requestId, { allow: body.allow === true, always: body.always === true });
    return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "That request already closed." }, { status: 410 });
  }
  const run = getRun(id);
  if (!run) return NextResponse.json({ error: "Nothing is waiting for an answer." }, { status: 404 });
  const answers =
    body.answers && typeof body.answers === "object" && !Array.isArray(body.answers)
      ? Object.fromEntries(Object.entries(body.answers).filter((kv): kv is [string, string] => typeof kv[1] === "string"))
      : undefined;
  const ok = run.respond(requestId, {
    allow: body.allow === true,
    always: body.always === true,
    answers,
    message: str(body.message),
  });
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "That request already closed." }, { status: 410 });
}
