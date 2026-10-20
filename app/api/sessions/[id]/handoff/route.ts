import { NextResponse, type NextRequest } from "next/server";
import { once } from "@/lib/server/dedupe";
import { handoff, loadSource } from "@/lib/server/handoff";
import { parseMode, readJson, str } from "@/lib/server/http";
import { getProfile } from "@/lib/server/profiles";
import { guardTurn } from "@/lib/server/fallback";

export const dynamic = "force-dynamic";

/** Continues this session under another profile (another agent, account, proxy or model) in a new session. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  const body = await readJson(req);
  return once(body.clientId, async () => {
    const profile = getProfile(str(body.profile));
    if (!profile) return NextResponse.json({ error: "Choose a profile." }, { status: 400 });
    if (profile.bin && !profile.binPath) return NextResponse.json({ error: `${profile.label} isn't installed.` }, { status: 400 });
    const src = await loadSource(decodeURIComponent(raw));
    if (!src) return NextResponse.json({ error: "Session not found." }, { status: 404 });
    const text = str(body.text)?.trim() ?? "";
    const mode = parseMode(body.permissionMode) ?? "default";
    const model = str(body.model) || undefined;
    try {
      const id = await Promise.race([
        handoff(src, { text, mode, model, profile }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${profile.label} didn't start in time.`)), 90_000)),
      ]);
      guardTurn({ key: id, text: text || "Continue where the previous session left off.", mode, model, profile });
      return NextResponse.json({ id });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
  });
}
