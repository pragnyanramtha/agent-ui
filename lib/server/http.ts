import fs from "node:fs/promises";
import path from "node:path";
import type { PermissionMode } from "@/lib/types";
import { findSessionFile, sessionMeta } from "./sessions";

const MODES: PermissionMode[] = ["default", "acceptEdits", "bypassPermissions", "plan"];

export const parseMode = (value: unknown): PermissionMode | null =>
  typeof value === "string" && (MODES as string[]).includes(value) ? (value as PermissionMode) : null;

/** A JSON object body, or {} for anything else (bad JSON, null, arrays, primitives). */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const body: unknown = await req.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export const str = (value: unknown) => (typeof value === "string" ? value : undefined);

/** True when `dir` is set but nothing is there any more (moved or deleted). Permission errors and the like aren't "gone". */
export async function folderGone(dir: string | null | undefined): Promise<boolean> {
  if (!dir || !path.isAbsolute(dir)) return false;
  try {
    return !(await fs.stat(dir)).isDirectory();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

/** Everything a route needs to know about a session on disk. */
export async function sessionContext(id: string) {
  const file = await findSessionFile(id);
  if (!file) return null;
  const stat = await fs.stat(file).catch(() => null);
  if (!stat) return null;
  const meta = await sessionMeta(file, stat.mtimeMs, stat.size);
  const cwd = meta.cwd ?? path.dirname(file);
  return { file, meta, cwd, size: stat.size };
}
