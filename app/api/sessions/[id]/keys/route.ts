import { NextResponse, type NextRequest } from "next/server";
import { readJson } from "@/lib/server/http";
import { inputTarget, isTerminalKey, pressKey } from "@/lib/server/input";
import { terminalForKey } from "@/lib/server/agents/bridge";

export const dynamic = "force-dynamic";

/** Presses one whitelisted key in the session's terminal pane (Esc to interrupt, digits/Enter for dialogs). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const key = (await readJson(req)).key;
  if (!isTerminalKey(key)) return NextResponse.json({ error: "Unknown key." }, { status: 400 });
  const terminal = await terminalForKey(id);
  if (!terminal) return NextResponse.json({ error: "This session isn't open in a terminal." }, { status: 409 });
  const target = await inputTarget(terminal.pid);
  if (!target) return NextResponse.json({ error: "Can't reach this terminal." }, { status: 409 });
  try {
    await pressKey(target, key);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message.slice(0, 200) : "Couldn't press the key." }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
