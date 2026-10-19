import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { absPath, FsError, fsFail, looksText, mimeOf, real, safeName } from "@/lib/server/files";
import { readJson, str } from "@/lib/server/http";

export const dynamic = "force-dynamic";

const CAP = 2000;

/**
 * GET ?path=<abs> → a folder: { kind: "dir", path, parent, home, entries: [{ name, path, type, size, mtime }] }
 *                    a file:   { kind: "file", path, parent, size, mtime, mime, text }
 */
export async function GET(req: NextRequest) {
  const home = os.homedir();
  const want = req.nextUrl.searchParams.get("path") || home;
  const hidden = req.nextUrl.searchParams.get("hidden") === "1";
  try {
    const p = await real(want);
    const st = await fs.stat(p);
    const parent = path.dirname(p) === p ? null : path.dirname(p);
    if (!st.isDirectory()) {
      /* opening a FIFO blocks until a writer shows up, pinning a threadpool thread */
      if (!st.isFile()) return NextResponse.json({ kind: "file", path: p, parent, home, size: st.size, mtime: st.mtimeMs, mime: mimeOf(p), text: false });
      const h = await fs.open(p, "r");
      const head = Buffer.alloc(Math.min(st.size, 8192));
      await h.read(head, 0, head.length, 0).finally(() => h.close());
      return NextResponse.json({ kind: "file", path: p, parent, home, size: st.size, mtime: st.mtimeMs, mime: mimeOf(p), text: looksText(head) });
    }
    const dirents = await fs.readdir(p, { withFileTypes: true });
    const shown = dirents.filter((d) => hidden || !d.name.startsWith("."));
    const entries = await Promise.all(
      shown.slice(0, CAP).map(async (d) => {
        const full = path.join(p, d.name);
        const s = await fs.stat(full).catch(() => null);
        const type = s?.isDirectory() ? "dir" : s ? "file" : "broken";
        return { name: d.name, path: full, type, link: d.isSymbolicLink(), size: s?.size ?? 0, mtime: s?.mtimeMs ?? 0 };
      }),
    );
    entries.sort((a, b) => (a.type === "dir") !== (b.type === "dir") ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    return NextResponse.json({ kind: "dir", path: p, parent, home, entries, truncated: shown.length > CAP, hiddenCount: dirents.length - shown.length });
  } catch (err) {
    return fsFail(err, want);
  }
}

/**
 * POST { action: "mkdir", path: <parent>, name }
 *      { action: "rename", path, name }          (within the same folder)
 *      { action: "delete", path }                (folders recursively)
 *      { action: "write", path, text }           (text files, up to 5 MB)
 */
export async function POST(req: NextRequest) {
  const body = await readJson(req);
  const action = str(body.action);
  const target = str(body.path) ?? "";
  try {
    if (action === "mkdir") {
      const dir = path.join(await real(target), safeName(str(body.name)));
      await fs.mkdir(dir);
      return NextResponse.json({ path: dir });
    }
    if (action === "rename") {
      const from = absPath(target);
      const to = path.join(path.dirname(from), safeName(str(body.name)));
      if (await fs.stat(to).then(() => true).catch(() => false)) throw new FsError(`${to} already exists.`, 409);
      await fs.rename(from, to);
      return NextResponse.json({ path: to });
    }
    if (action === "delete") {
      const p = absPath(target);
      if (p === "/" || p === os.homedir()) throw new FsError(`Can't delete ${p}.`, 400);
      await fs.rm(p, { recursive: true });
      return NextResponse.json({ ok: true });
    }
    if (action === "write") {
      const abs = absPath(target);
      const text = typeof body.text === "string" ? body.text : null;
      if (text === null || text.length > 5_000_000) throw new FsError("File too large (max 5 MB).", 400);
      /* renaming over a symlink would replace the link instead of updating what it points to */
      const p = await fs.realpath(abs).catch(() => abs);
      const tmp = `${p}.agentu-${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`;
      const mode = await fs.stat(p).then((s) => s.mode & 0o777).catch(() => 0o644);
      try {
        await fs.writeFile(tmp, text, { mode });
        await fs.rename(tmp, p);
      } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        throw err;
      }
      return NextResponse.json({ path: abs });
    }
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (err) {
    return fsFail(err, target);
  }
}
