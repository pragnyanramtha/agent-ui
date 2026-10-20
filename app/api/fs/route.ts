import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const CAP = 500;

/**
 * Directory listing for the folder picker: subfolders only, never file contents.
 * GET /api/fs?path=<abs>[&hidden=1] → { path, parent, home, dirs: [{ name, path }], truncated }.
 * No path lists the home folder. The path is resolved through symlinks first, so `path` is always the real folder.
 * `&stat=1` only checks the folder is there: { path } or the same errors, without reading it.
 */
export async function GET(req: NextRequest) {
  const home = os.homedir();
  const raw = req.nextUrl.searchParams.get("path") || home;
  const hidden = req.nextUrl.searchParams.get("hidden") === "1";
  if (raw.includes("\0") || !path.isAbsolute(raw)) return NextResponse.json({ error: "Use an absolute path." }, { status: 400 });

  let real: string;
  try {
    real = await fs.realpath(path.resolve(raw));
    if (!(await fs.stat(real)).isDirectory()) return NextResponse.json({ error: `${raw} isn't a folder.` }, { status: 400 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") return NextResponse.json({ error: `No permission to open ${raw}.` }, { status: 403 });
    return NextResponse.json({ error: `No folder at ${raw}.` }, { status: 404 });
  }
  if (req.nextUrl.searchParams.get("stat") === "1") return NextResponse.json({ path: real });

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(real, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return NextResponse.json({ error: code === "EACCES" || code === "EPERM" ? `No permission to open ${real}.` : `Couldn't read ${real}.` }, { status: code === "EACCES" || code === "EPERM" ? 403 : 500 });
  }

  const candidates = entries.filter((e) => (hidden || !e.name.startsWith(".")) && (e.isDirectory() || e.isSymbolicLink()));
  /* symlinks count only when they point at a folder (stat follows the link; dangling ones drop out) */
  const checked = await Promise.all(
    candidates.map(async (e) => (e.isDirectory() ? e : (await fs.stat(path.join(real, e.name)).then((s) => s.isDirectory()).catch(() => false)) ? e : null)),
  );
  const names = checked
    .filter((e): e is import("node:fs").Dirent => e !== null)
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));

  const parent = path.dirname(real);
  return NextResponse.json({
    path: real,
    parent: parent === real ? null : parent,
    home,
    dirs: names.slice(0, CAP).map((name) => ({ name, path: path.join(real, name) })),
    truncated: names.length > CAP,
  });
}
