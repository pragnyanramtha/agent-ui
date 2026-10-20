/* Prompts put aside from the composer (Mod+S), per folder, newest first. Kept in localStorage so they
 * outlive the tab; attachments are kept by their uploaded path. */

export type StashedFile = { name: string; size: number; path: string };
export type Stash = { id: string; text: string; files: StashedFile[]; at: number };

export const STASH_MAX = 20;
const key = (folder: string | undefined) => `cui:stash:${folder || ""}`;

function read(folder: string | undefined): Stash[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key(folder)) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((s): s is Stash => Boolean(s) && typeof s.id === "string" && typeof s.text === "string" && typeof s.at === "number" && Array.isArray(s.files));
  } catch {
    return [];
  }
}

function write(folder: string | undefined, list: Stash[]) {
  try {
    if (list.length) localStorage.setItem(key(folder), JSON.stringify(list));
    else localStorage.removeItem(key(folder));
    return true;
  } catch {
    return false;
  }
}

export const loadStash = (folder: string | undefined) => read(folder);

/** Adds a prompt at the top (the oldest past the cap drop off); null when storage refused it. */
export function pushStash(folder: string | undefined, text: string, files: StashedFile[] = [], now = Date.now()): Stash[] | null {
  const entry: Stash = { id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, text, files, at: now };
  const list = [entry, ...read(folder)].slice(0, STASH_MAX);
  return write(folder, list) ? list : null;
}

export function dropStash(folder: string | undefined, id: string): Stash[] {
  const list = read(folder).filter((s) => s.id !== id);
  write(folder, list);
  return list;
}

/** What a row shows: the first non-empty line, or the attachments when there's no text. */
export function stashTitle(s: Stash) {
  const line = s.text.split("\n").find((l) => l.trim())?.trim();
  if (line) return line;
  return s.files.length === 1 ? s.files[0].name : `${s.files.length} files`;
}
