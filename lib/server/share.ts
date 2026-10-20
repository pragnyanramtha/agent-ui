import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { attachName } from "@/lib/attachments";
import type { Shared, SharedFile } from "@/lib/share";

/* Shares from other apps: files land in the composer's attachments folder (app/api/attachments/route.ts sweeps it),
 * and the text and paths wait here until the browser the share came from picks them up. */

export const SHARE_MAX_BYTES = 100 * 1024 * 1024;
export const SHARE_MAX_FILES = 10;
const KEEP_MS = 10 * 60_000;

const attachRoot = () => process.env.AGENT_U_ATTACH || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "agent-u", "attachments");

/* the share route and /api/share are separate bundles: they meet through globalThis */
const g = globalThis as typeof globalThis & { __agentuShares?: Map<string, { at: number; shared: Shared }> };
const shares = (g.__agentuShares ??= new Map());

/** Saves the files and remembers the share; returns the id the browser asks for it by. */
export async function keepShared(text: string, files: File[], now = Date.now()): Promise<string> {
  const saved: SharedFile[] = [];
  const list = files.slice(0, SHARE_MAX_FILES);
  if (list.length) {
    const dir = path.join(attachRoot(), `${new Date(now).toISOString().slice(0, 10)}-${crypto.randomBytes(4).toString("hex")}`);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const taken = new Set<string>();
    for (const f of list) {
      let name = attachName(f.name || "shared");
      for (let n = 2; taken.has(name); n++) name = name.replace(/(-\d+)?(\.[^.]+)?$/, (_m, _d, ext = "") => `-${n}${ext}`);
      taken.add(name);
      const file = path.join(dir, name);
      await fs.writeFile(file, Buffer.from(await f.arrayBuffer()), { mode: 0o600, flag: "wx" });
      saved.push({ name, size: f.size, path: file });
    }
  }
  for (const [k, v] of shares) if (now - v.at > KEEP_MS) shares.delete(k);
  const id = crypto.randomBytes(12).toString("hex");
  shares.set(id, { at: now, shared: { text, files: saved } });
  return id;
}

/** A share kept in the last ten minutes. It stays until then, so a reload of the landing page still finds it. */
export function sharedById(id: string, now = Date.now()): Shared | null {
  const hit = shares.get(id);
  if (!hit || now - hit.at > KEEP_MS) return null;
  return hit.shared;
}
