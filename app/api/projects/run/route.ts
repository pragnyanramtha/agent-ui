import { NextResponse, type NextRequest } from "next/server";
import { readJson, str } from "@/lib/server/http";
import { cleanPath, locateProject } from "@/lib/server/projects";
import { launchCommand } from "@/lib/server/terminals";
import { folderName } from "@/lib/projects";

export const dynamic = "force-dynamic";

/** Runs one of a project's actions in a kept terminal: `{ cwd, action }` (the action's id; the command comes from
 * the project's settings, never from the request). */
export async function POST(req: NextRequest) {
  const body = await readJson(req);
  const cwd = cleanPath(body.cwd);
  if (typeof cwd !== "string") return NextResponse.json(cwd, { status: 400 });
  const hit = await locateProject(cwd);
  const action = hit?.project.actions.find((a) => a.id === str(body.action));
  if (!hit || !action) return NextResponse.json({ error: "That action isn't set up for this folder." }, { status: 404 });
  try {
    const t = await launchCommand({ cwd: hit.runDir, command: action.command, label: `${action.name} in ${folderName(hit.runDir)}`, cols: Number(body.cols) || undefined, rows: Number(body.rows) || undefined });
    return NextResponse.json({ ...t, label: action.name, cwd: hit.runDir });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
