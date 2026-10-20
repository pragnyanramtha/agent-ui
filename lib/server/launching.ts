/* Opening a Claude session in a terminal closes its web run, and the new TUI takes a few seconds to register
 * (~/.claude/sessions/<pid>.json). A message sent in that window has to wait for that terminal and go there,
 * not resume the session in a second claude process. */

const LAUNCH_MS = 15_000;
const POLL_MS = 400;

const g = globalThis as typeof globalThis & { __agentuLaunching?: Map<string, number> };
const until = () => (g.__agentuLaunching ??= new Map());

/** A terminal is starting for this Claude session; held until it registers, the launch fails, or `ms` pass. */
export function markLaunching(id: string, ms = LAUNCH_MS) {
  until().set(id, Date.now() + ms);
}

export function launchDone(id: string) {
  until().delete(id);
}

export function isLaunching(id: string) {
  const end = until().get(id);
  if (end === undefined) return false;
  if (Date.now() < end) return true;
  until().delete(id);
  return false;
}

/** While a launch is in flight, looks for the session's terminal until it shows up (and ends the lock), or resolves
 * null once the launch failed or timed out. */
export async function awaitLaunch<T>(id: string, find: () => Promise<T | null | undefined>, pollMs = POLL_MS): Promise<T | null> {
  while (isLaunching(id)) {
    const found = await find();
    if (found) {
      launchDone(id);
      return found;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return (await find()) ?? null;
}
