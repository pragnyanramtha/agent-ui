import { adapterFor, parseSessionKey } from "./agents";
import { checkpoint } from "./git";
import { sessionContext } from "./http";
import { getRun } from "./runner";

/* A checkpoint before each message sent from the web, so the files can go back to how they were before that turn.
 * Never in the way: a slow snapshot (huge repo) stops being waited for after a few seconds, and errors are dropped.
 * Large untracked files are left out of it, and a folder with too much new data is skipped (git.ts keeps the reason
 * for the git panel), so checkpoints don't fill the repository's object store. */

const WAIT_MS = 4000;

export async function sessionCwd(key: string): Promise<string | null> {
  const k = parseSessionKey(key);
  if (!k) return null;
  if (k.agent === "claude") return getRun(k.native)?.cwd ?? (await sessionContext(k.native))?.cwd ?? null;
  return (await (await adapterFor(k.agent))?.get(k.native))?.cwd ?? null;
}

/** a turn is running in the web (rewinding then would race the agent's own writes) */
export async function turnRunning(key: string): Promise<boolean> {
  const k = parseSessionKey(key);
  if (!k) return false;
  if (k.agent === "claude") {
    const s = getRun(k.native)?.state.status;
    return s === "running" || s === "starting";
  }
  return (await adapterFor(k.agent))?.runState(k.native)?.status === "running";
}

export async function beforeTurn(key: string, text: string, cwd?: string | null) {
  try {
    const dir = cwd ?? (await sessionCwd(key));
    if (!dir) return;
    const job = checkpoint(dir, key, text).catch(() => null);
    await Promise.race([job, new Promise((r) => setTimeout(r, WAIT_MS))]);
  } catch {}
}
