import { NextResponse, type NextRequest } from "next/server";
import { readJson, str } from "@/lib/server/http";
import { pushAll, subscribe, unsubscribe, vapidPublicKey } from "@/lib/server/push";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ publicKey: vapidPublicKey() });
}

/** { subscription } saves a browser; { subscription, test: true } also sends it a test notification */
export async function POST(req: NextRequest) {
  const body = await readJson(req);
  const sub = body.subscription as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | undefined;
  const endpoint = str(sub?.endpoint);
  const p256dh = str(sub?.keys?.p256dh);
  const auth = str(sub?.keys?.auth);
  if (!endpoint || !p256dh || !auth || !/^https:\/\//.test(endpoint) || endpoint.length > 2048) {
    return NextResponse.json({ error: "That isn't a push subscription." }, { status: 400 });
  }
  const origin = req.headers.get("origin") ?? "";
  subscribe({ endpoint, keys: { p256dh, auth }, origin, ua: (req.headers.get("user-agent") ?? "").slice(0, 200), at: Date.now() });
  if (body.test !== true) return NextResponse.json({ ok: true });
  const res = await pushAll({ kind: "test", title: "Notifications are on", body: "You'll hear when an agent finishes, needs you, or fails.", tag: "test", url: "/" }, endpoint);
  if (!res.sent) return NextResponse.json({ error: "Test notification failed." }, { status: 502 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const endpoint = str((await readJson(req)).endpoint);
  if (endpoint) unsubscribe(endpoint);
  return NextResponse.json({ ok: true });
}
