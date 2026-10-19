import os from "node:os";
import { NextResponse, type NextRequest } from "next/server";
import { readJson } from "@/lib/server/http";
import { allProfiles, CONFIG_PATH, profileInfo, saveProfiles } from "@/lib/server/profiles";

export const dynamic = "force-dynamic";

/** Every agent profile (built-ins and the config file's), secrets masked. */
export async function GET() {
  return NextResponse.json({ profiles: allProfiles().map(profileInfo), configPath: CONFIG_PATH, home: os.homedir() });
}

/** Replaces the profiles stored in the config file (built-ins that aren't listed go back to their defaults). */
export async function PUT(req: NextRequest) {
  const body = await readJson(req);
  if (!Array.isArray(body.profiles)) return NextResponse.json({ error: "Send a list of profiles." }, { status: 400 });
  const r = saveProfiles(body.profiles);
  if ("error" in r) return NextResponse.json(r, { status: 400 });
  return NextResponse.json({ profiles: allProfiles().map(profileInfo), configPath: CONFIG_PATH, home: os.homedir() });
}
