import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PermissionMode } from "@/lib/types";
import { parseMode } from "../http";
import { CONFIG_DIR } from "../profiles";

/* Messages queued behind a running non-Claude turn, and each session's approval mode, kept on disk next to
 * state.json so a restart neither drops the queue nor quietly turns Ask first into Bypass. Shared through
 * globalThis: instrumentation and the route handlers are separate bundles with their own module state. */

/** `effort`: undefined is the profile's default, null was picked as "default" in the composer */
export type Queued = { id: string; text: string; model?: string; effort?: string | null; mode: PermissionMode; profile: unknown; at: number };
type Store = { file: string; queues: Map<string, Queued[]>; modes: Map<string, PermissionMode>; timer: ReturnType<typeof setTimeout> | null };

/** a write waits at most this long, so a crash loses little */
const WRITE_MS = 150;
/** modes of the sessions changed most recently; older ones fall back to the default */
const MAX_MODES = 2000;

const g = globalThis as typeof globalThis & { __agentuQueueStore?: Store };

export const queueFile = () => process.env.AGENT_U_QUEUE || path.join(CONFIG_DIR, "queue.json");

function read(file: string): Pick<Store, "queues" | "modes"> {
  const queues = new Map<string, Queued[]>();
  const modes = new Map<string, PermissionMode>();
  let raw: { modes?: Record<string, unknown>; queues?: Record<string, unknown> } = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8")) ?? {};
  } catch {
    /* missing or unreadable: start empty */
  }
  for (const [key, m] of Object.entries(raw.modes ?? {})) {
    const mode = parseMode(m);
    if (mode) modes.set(key, mode);
  }
  for (const [key, list] of Object.entries(raw.queues ?? {})) {
    if (!Array.isArray(list)) continue;
    const items = list.flatMap((q): Queued[] => {
      if (!q || typeof q !== "object" || typeof q.id !== "string" || typeof q.text !== "string" || !q.text) return [];
      return [{ id: q.id, text: q.text, model: typeof q.model === "string" ? q.model : undefined, effort: typeof q.effort === "string" || q.effort === null ? q.effort : undefined, mode: parseMode(q.mode) ?? "default", profile: q.profile, at: typeof q.at === "number" ? q.at : 0 }];
    });
    if (items.length) queues.set(key, items);
  }
  return { queues, modes };
}

/** The persisted queues and modes, read from disk on first use. */
export function queueStore(): Store {
  if (g.__agentuQueueStore) return g.__agentuQueueStore;
  const file = queueFile();
  const store: Store = { file, ...read(file), timer: null };
  g.__agentuQueueStore = store;
  process.once("exit", () => {
    if (store.timer) flushQueues();
  });
  return store;
}

/** Writes the store now (temp file and rename, so a crash never leaves half a file). */
export function flushQueues() {
  const store = g.__agentuQueueStore;
  if (!store) return;
  if (store.timer) clearTimeout(store.timer);
  store.timer = null;
  for (const key of [...store.modes.keys()].slice(0, Math.max(0, store.modes.size - MAX_MODES))) store.modes.delete(key);
  const data = {
    modes: Object.fromEntries(store.modes),
    queues: Object.fromEntries([...store.queues].filter(([, list]) => list.length)),
  };
  try {
    fs.mkdirSync(path.dirname(store.file), { recursive: true, mode: 0o700 });
    const tmp = `${store.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, store.file);
  } catch (err) {
    console.error(`queue store: couldn't write ${store.file}: ${err instanceof Error ? err.message : err}`);
  }
}

/** Call after every change to the queues. */
export function saveQueues() {
  const store = queueStore();
  store.timer ??= setTimeout(flushQueues, WRITE_MS);
}

export const modeOf = (key: string): PermissionMode | undefined => queueStore().modes.get(key);

export function setMode(key: string, mode: PermissionMode) {
  const { modes } = queueStore();
  if (modes.get(key) === mode) return;
  /* re-inserted, so the oldest entries are the least recently changed */
  modes.delete(key);
  modes.set(key, mode);
  saveQueues();
}
