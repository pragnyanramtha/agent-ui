import { NextResponse, type NextRequest } from "next/server";
import { readJson } from "@/lib/server/http";
import { getRun } from "@/lib/server/runner";
import { parseSessionKey, sessionKey } from "@/lib/server/agents";
import { answerTurn, turnState } from "@/lib/server/agents/cli-run";
import { RESPOND_HEADER, spendRespondToken } from "@/lib/server/push-token";
import type { PendingAsk } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Allow or Deny from a notification: { action: "allow" | "deny" }, authorized by the token in the header (never the
 * cookie), and only for the approval that token names. Questions are never answered here. */
export async function POST(req: NextRequest) {
  const action = (await readJson(req)).action;
  if (action !== "allow" && action !== "deny") return NextResponse.json({ error: "Allow or deny?" }, { status: 400 });
  const target = spendRespondToken(req.headers.get(RESPOND_HEADER));
  if (!target) return NextResponse.json({ error: "This notification expired. Open the session to answer." }, { status: 401 });
  const ok = answer(target.session, target.request, action === "allow");
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "That request already closed." }, { status: 410 });
}

function answer(session: string, request: string, allow: boolean): boolean {
  const key = parseSessionKey(session);
  if (!key) return false;
  if (key.agent !== "claude") {
    const k = sessionKey(key.agent, key.native);
    const ask = turnState(k)?.pending?.find((p) => p.requestId === request);
    return ask?.kind === "permission" && answerTurn(k, request, { allow, always: false });
  }
  const run = getRun(session);
  const ask = run?.state.pending.find((p: PendingAsk) => p.requestId === request);
  return Boolean(run && ask?.kind === "permission" && run.respond(request, { allow, always: false }));
}
