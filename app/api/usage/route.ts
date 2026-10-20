import { NextResponse, type NextRequest } from "next/server";
import { AGENT_IDS, type AgentId } from "@/lib/types";
import { RANGES, safeZone } from "@/lib/usage-report";
import { usageReport } from "@/lib/server/usage";

export const dynamic = "force-dynamic";

const text = (v: string | null, max: number) => (v && v.length <= max ? v : null);

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const days = Number(q.get("days"));
  const agent = q.get("agent");
  const report = await usageReport({
    tz: safeZone(q.get("tz")),
    days: (RANGES as readonly number[]).includes(days) ? days : 30,
    filters: {
      agent: agent && AGENT_IDS.includes(agent as AgentId) ? agent : null,
      profile: text(q.get("profile"), 64),
      project: text(q.get("project"), 4096),
    },
  });
  return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
}
