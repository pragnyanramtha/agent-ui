import { NextResponse } from "next/server";
import { runDoctor, type DoctorReport } from "@/lib/server/doctor";

export const dynamic = "force-dynamic";

/* taps from two tabs share one run instead of spawning every CLI twice */
let inflight: Promise<DoctorReport> | null = null;

/** The health check: agent CLIs, sign-ins, the terminal service, tools, notifications and disk space. */
export async function GET() {
  inflight ??= runDoctor().finally(() => (inflight = null));
  return NextResponse.json(await inflight, { headers: { "Cache-Control": "no-store" } });
}
