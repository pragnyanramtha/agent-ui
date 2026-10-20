import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { ATTACH_ROOT, sweepAttachments } from "@/lib/server/storage";

export const dynamic = "force-dynamic";

/** A new folder for one message's attachments; the composer uploads into it with /api/files/upload. */
export async function POST() {
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(ATTACH_ROOT, `${day}-${crypto.randomBytes(4).toString("hex")}`);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  void sweepAttachments().catch(() => 0);
  return NextResponse.json({ dir });
}
