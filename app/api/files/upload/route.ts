import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { FsError, fsFail, real, safeName } from "@/lib/server/files";
import { guard } from "@/lib/guard";

export const dynamic = "force-dynamic";

const CHUNK_MAX = 9 * 1024 * 1024;

/* A phone that times out resends a chunk while the first copy is still being written. Chunks of one upload run one
 * at a time, and a resent last chunk of an upload that already finished is answered as done (not started over). */
const g = globalThis as { __agentuUploadLocks?: Map<string, Promise<unknown>>; __agentuUploadsDone?: Map<string, { at: number; target: string; total: number }> };
const locks = (g.__agentuUploadLocks ??= new Map());
const finished = (g.__agentuUploadsDone ??= new Map());
const DONE_TTL = 10 * 60_000;

function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  void tail.then(() => locks.get(key) === tail && locks.delete(key));
  return run;
}

/** the body, refused before it's read when Content-Length is over `max`, and as soon as it passes `max` without one */
async function readCapped(req: NextRequest, max: number): Promise<Buffer> {
  const declared = req.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= max)) throw new FsError("Chunk too large.", 413);
  if (!req.body) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  let size = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new FsError("Chunk too large.", 413);
    }
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts, size);
}

/**
 * Resumable upload in chunks: POST ?dir=<abs>&name=<file>&offset=<n>&total=<bytes>&key=<id>[&replace=1] with the raw bytes.
 * The partial file is kept next to the target; an offset that doesn't match what's there gets a 409 with
 * the size received so far, so a client that lost its connection carries on from there.
 * An empty POST at offset 0 asks for that size. The last chunk moves the file into place.
 */
export async function POST(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return denied;
  const q = req.nextUrl.searchParams;
  const dirParam = q.get("dir");
  try {
    const dir = await real(dirParam);
    if (!(await fs.stat(dir)).isDirectory()) throw new FsError(`${dir} isn't a folder.`, 400);
    const name = safeName(q.get("name"));
    const total = Number(q.get("total"));
    const offset = Number(q.get("offset") ?? 0);
    if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(offset) || offset < 0 || offset > total) throw new FsError("Bad offset or size.", 400);
    const target = path.join(dir, name);
    /* the client's key (size and modified time) keeps a different file of the same name from resuming this one */
    const key = (q.get("key") ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
    const part = path.join(dir, `.${name}.${key || total}.agentu-upload`);
    const body = await readCapped(req, CHUNK_MAX);
    if (offset + body.length > total) throw new FsError("More bytes than the file's size.", 400);

    return await serial(part, async () => {
      const now = Date.now();
      for (const [k, v] of finished) if (now - v.at > DONE_TTL) finished.delete(k);
      const done = finished.get(part);
      if (done && done.total === total && offset + body.length === total) return NextResponse.json({ done: true, path: done.target, received: total });
      if (q.get("replace") !== "1" && (await fs.stat(target).then(() => true).catch(() => false))) {
        return NextResponse.json({ error: `${name} already exists in ${dir}.`, code: "exists" }, { status: 409 });
      }
      const have = await fs.stat(part).then((s) => s.size).catch(() => 0);
      if (offset !== have) return NextResponse.json({ error: "Out of step", code: "offset", received: have }, { status: 409 });
      if (body.length || offset === 0) await fs.appendFile(part, body, { mode: 0o644 });
      const received = offset + body.length;
      if (received === total) {
        await fs.rename(part, target);
        finished.set(part, { at: Date.now(), target, total });
        return NextResponse.json({ done: true, path: target, received });
      }
      finished.delete(part);
      return NextResponse.json({ done: false, received });
    });
  } catch (err) {
    return fsFail(err, dirParam ?? "");
  }
}
