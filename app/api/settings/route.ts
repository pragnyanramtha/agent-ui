import { NextResponse, type NextRequest } from "next/server";
import { readSynced, serverDefaults, updateSynced } from "@/lib/server/settings";

export const dynamic = "force-dynamic";

/** the settings shared by every browser signed in to this server, and what "server default" means here */
export function GET() {
  return NextResponse.json({ ...readSynced(), defaults: serverDefaults() });
}

/** a JSON merge of synced settings: `{ "palette": "nord", "accent": null }` (null goes back to the default) */
export async function PUT(req: NextRequest) {
  const patch: unknown = await req.json().catch(() => undefined);
  let res: ReturnType<typeof updateSynced>;
  try {
    res = updateSynced(patch);
  } catch (err) {
    console.error("settings: save failed", err);
    return NextResponse.json({ error: "Couldn't save settings on the server." }, { status: 500 });
  }
  if (!res.ok) return NextResponse.json({ error: res.errors.join(" "), errors: res.errors, rejected: res.rejected }, { status: 400 });
  return NextResponse.json(res.file);
}
