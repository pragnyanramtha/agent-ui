/* sessionStorage that never throws (quota, private mode), and the per-session keys that move with a session. */

export function save(key: string, value: string | null) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    /* over quota or storage disabled: the value just isn't kept */
  }
}

export function load(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Moves a session's unsent bubbles and its draft to the id it continues under. `pending` is the current list,
 * which can be newer than what an effect last saved. */
export function carryOver(from: string, to: string, pending?: unknown[]) {
  if (from === to) return;
  const p = pending ? (pending.length ? JSON.stringify(pending) : null) : load(`pending:${from}`);
  if (p) save(`pending:${to}`, p);
  const draft = load(`draft:${from}`);
  if (draft && !load(`draft:${to}`)) save(`draft:${to}`, draft);
  save(`pending:${from}`, null);
  save(`draft:${from}`, null);
  const effort = loadEffort(from);
  if (effort && !loadEffort(to)) saveEffort(to, effort);
}

/* The reasoning effort picked for a session, kept across reloads (localStorage); null when it uses the default. */
const EFFORT_KEY = (id: string) => `cui:effort:${id}`;

export function loadEffort(id: string): string | null {
  try {
    return localStorage.getItem(EFFORT_KEY(id));
  } catch {
    return null;
  }
}

export function saveEffort(id: string, effort: string | null) {
  try {
    if (!effort) localStorage.removeItem(EFFORT_KEY(id));
    else localStorage.setItem(EFFORT_KEY(id), effort);
  } catch {
    /* storage disabled: the pick lasts until the page reloads */
  }
}
