import fs from "node:fs";
import path from "node:path";
import { pickValid, validatePatch, type Settings } from "@/lib/settings-schema";
import { CONFIG_DIR } from "./profiles";

/* Synced settings (lib/settings-schema.ts, scope "synced"): one small JSON file next to the profiles config, so every
 * browser signed in to this server sees the same palette, fonts and so on. Only values that were set are stored;
 * everything else is the registry default. */

export const SETTINGS_PATH = process.env.AGENT_U_SETTINGS || path.join(CONFIG_DIR, "settings.json");

export type SyncedFile = { settings: Partial<Settings>; updatedAt: number };

export function readSynced(): SyncedFile {
  let text: string;
  try {
    text = fs.readFileSync(SETTINGS_PATH, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`Can't read ${SETTINGS_PATH}: ${(err as Error).message}`);
    return { settings: {}, updatedAt: 0 };
  }
  try {
    const raw = JSON.parse(text) as { settings?: unknown; updatedAt?: unknown };
    /* a value an older or newer build doesn't know is dropped rather than failing the whole file */
    return { settings: pickValid(raw.settings, "synced").values, updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0 };
  } catch (err) {
    console.warn(`Can't parse ${SETTINGS_PATH}: ${(err as Error).message} (starting from defaults)`);
    return { settings: {}, updatedAt: 0 };
  }
}

function write(data: SyncedFile) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true, mode: 0o700 });
  const tmp = `${SETTINGS_PATH}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, SETTINGS_PATH);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

export type UpdateResult = { ok: true; file: SyncedFile } | { ok: false; errors: string[] };

/** Merges a patch into the stored settings: values replace, `null` goes back to the default. */
export function updateSynced(patch: unknown, now = Date.now()): UpdateResult {
  const checked = validatePatch(patch, { scope: "synced", allowNull: true });
  if (!checked.ok) return checked;
  const current = readSynced();
  const settings: Record<string, unknown> = { ...current.settings, ...checked.values };
  for (const key of checked.reset) delete settings[key];
  const file = { settings: settings as Partial<Settings>, updatedAt: now };
  write(file);
  return { ok: true, file };
}
