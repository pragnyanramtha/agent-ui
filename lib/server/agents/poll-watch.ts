import type { Entry } from "@/lib/types";

/* For agents whose history is re-read whole (a folded log, a rewritten file): poll a cheap signature,
 * re-read on change, and send entries with ids not seen yet plus tool results whose content changed.
 * Ids must be stable across reads. `from` is the entry count the history page ended at. */

const POLL_MS = 1000;

export function pollEntries(
  read: () => { sig: string; entries: () => Entry[] },
  from: string,
  onEntries: (entries: Entry[], end: string) => void,
): () => void {
  const seen = new Set<string>();
  const results = new Map<string, string>();
  let seeded = false;
  let lastSig: string | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = () => {
    if (stopped) return;
    try {
      const snap = read();
      if (snap.sig !== lastSig) {
        lastSig = snap.sig;
        const entries = snap.entries();
        if (!seeded) {
          for (const e of entries.slice(0, Math.max(0, Number(from) || 0))) {
            seen.add(e.id);
            if (e.kind === "result") results.set(e.toolUseId, JSON.stringify(e.result));
          }
          seeded = true;
        }
        const fresh: Entry[] = [];
        for (const e of entries) {
          if (e.kind === "result") {
            const body = JSON.stringify(e.result);
            if (results.get(e.toolUseId) === body) continue;
            results.set(e.toolUseId, body);
            fresh.push(e);
          } else if (!seen.has(e.id)) {
            seen.add(e.id);
            fresh.push(e);
          }
        }
        if (fresh.length) onEntries(fresh, String(entries.length));
      }
    } catch {
      /* mid-write; next tick */
    }
    timer = setTimeout(tick, POLL_MS);
  };
  timer = setTimeout(tick, 0);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/** Pages start on a user message so a page never starts mid-turn; cursors are entry indexes. */
export function pageOf(entries: Entry[], before: string | null | undefined, size = 400) {
  const stop = before == null ? entries.length : Math.min(Math.max(0, Number(before) || 0), entries.length);
  let start = Math.max(0, stop - size);
  while (start > 0 && entries[start].kind !== "user") start--;
  return { entries: entries.slice(start, stop), cursor: start > 0 ? String(start) : null, end: String(entries.length) };
}
