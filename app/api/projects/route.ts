import { NextResponse, type NextRequest } from "next/server";
import { readJson } from "@/lib/server/http";
import { allProfiles } from "@/lib/server/profiles";
import { projectBranch, projectIcon } from "@/lib/server/project-icon";
import { cleanPath, locateProject, projectEntries, readProjects, removeProject, saveProject, seedScripts } from "@/lib/server/projects";
import { sessionRows } from "@/lib/server/rows";
import { WORKTREE_ROOT } from "@/lib/server/git";

export const dynamic = "force-dynamic";

const MAX_DIRS = 60;

/* how many sessions are looked at for folders worth listing */
const SCAN = 1000;

const known = () => new Map(allProfiles().map((p) => [p.id, p.agent] as const));

/**
 * `?dir=<folder>` (repeatable): each folder's favicon path (read it through /api/files/raw), or null.
 * `?branch=<folder>`: the branch checked out there, or null. Both are cached per folder on the server.
 * Settings > Projects. `?for=<folder>`: the project a session's folder belongs to and where its actions run.
 * `?scripts=<folder>`: actions for the scripts in its package.json. Else every configured project and the folders
 * sessions ran in.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const branch = params.get("branch");
  if (branch !== null) return NextResponse.json({ branch: await projectBranch(branch) });
  if (params.has("dir")) {
    const dirs = [...new Set(params.getAll("dir"))].slice(0, MAX_DIRS);
    const found = await Promise.all(dirs.map(async (d) => [d, await projectIcon(d)] as const));
    return NextResponse.json({ icons: Object.fromEntries(found) }, { headers: { "Cache-Control": "private, max-age=60" } });
  }
  const forDir = params.get("for");
  if (forDir !== null) {
    const dir = cleanPath(forDir);
    if (typeof dir !== "string") return NextResponse.json(dir, { status: 400 });
    const hit = await locateProject(dir);
    return NextResponse.json({ project: hit?.project ?? null, runDir: hit?.runDir ?? null });
  }
  const scripts = params.get("scripts");
  if (scripts !== null) {
    const dir = cleanPath(scripts);
    if (typeof dir !== "string") return NextResponse.json(dir, { status: 400 });
    return NextResponse.json(await seedScripts(dir));
  }
  const rows = await sessionRows(SCAN).catch(() => []);
  return NextResponse.json({ projects: projectEntries(readProjects(), rows, [WORKTREE_ROOT]) });
}

/** Adds or replaces one project's settings: `{ project: { path, name?, profile?, ..., actions? } }`. */
export async function PUT(req: NextRequest) {
  const body = await readJson(req);
  if (!body.project) return NextResponse.json({ error: "Send { project: {...} }." }, { status: 400 });
  let res: ReturnType<typeof saveProject>;
  try {
    res = saveProject(body.project, known());
  } catch (err) {
    console.error("projects: save failed", err);
    return NextResponse.json({ error: "Couldn't save the project on the server." }, { status: 500 });
  }
  if ("error" in res) return NextResponse.json(res, { status: 400 });
  return NextResponse.json(res);
}

/** Forgets one project's settings: `{ path }`. Its sessions stay. */
export async function DELETE(req: NextRequest) {
  const res = removeProject((await readJson(req)).path);
  if ("error" in res) return NextResponse.json(res, { status: 400 });
  return NextResponse.json(res);
}
