import { NextResponse, type NextRequest } from "next/server";
import { inputTarget, paneScreen, readPrompt } from "@/lib/server/input";
import { terminalForKey } from "@/lib/server/agents/bridge";

export const dynamic = "force-dynamic";

/** What the session's terminal pane shows right now, plus whether its prompt can take input. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const terminal = await terminalForKey(id);
  if (!terminal) return NextResponse.json({ error: "This session isn't open in a terminal." }, { status: 404 });
  const target = await inputTarget(terminal.pid);
  if (!target) return NextResponse.json({ error: "Can't read this terminal." }, { status: 404 });
  try {
    const ansi = await paneScreen(target, true);
    const screen = ansi.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/\s+$/, "");
    /* the prompt check understands Claude's input box only */
    return NextResponse.json({ screen, prompt: decodeURIComponent(id).includes(":") ? null : readPrompt(ansi) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message.slice(0, 200) : "Couldn't read the terminal." }, { status: 502 });
  }
}
