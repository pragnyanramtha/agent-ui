/** Newest first; equal times fall back to the id, so the order (and every page cut from it) is the same on each call. */
export function newestFirst(a: { mtime: number; id: string }, b: { mtime: number; id: string }): number {
  return b.mtime - a.mtime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
