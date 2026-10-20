/* Fuzzy matching of a typed query against file paths, shared by the server's ranking and the pickers that mark
 * which characters matched. Case-insensitive; "/" in the query matches a "/" in the path. */

/** The tightest run of the query's characters in order along `path`, as positions; null when they aren't all there. */
export function fuzzyPositions(path: string, query: string): number[] | null {
  const p = path.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return [];
  let best: number[] | null = null;
  for (let s = p.indexOf(q[0]); s !== -1; s = p.indexOf(q[0], s + 1)) {
    const at = [s];
    for (let i = s + 1, j = 1; j < q.length && i < p.length; i++) if (p[i] === q[j]) (at.push(i), j++);
    if (at.length < q.length) break;
    if (!best || at[at.length - 1] - at[0] < best[best.length - 1] - best[0]) best = at;
  }
  return best;
}

/** Where to mark a match: the query whole in the file name, else whole in the path, else spread along it. */
export function matchPositions(path: string, query: string): number[] {
  const q = query.trim().toLowerCase().replace(/^\.\//, "");
  if (!q) return [];
  const p = path.toLowerCase();
  const base = p.lastIndexOf("/") + 1;
  const run = (from: number) => Array.from({ length: q.length }, (_, k) => from + k);
  const inBase = p.indexOf(q, base);
  if (inBase !== -1) return run(inBase);
  const inPath = p.indexOf(q);
  if (inPath !== -1) return run(inPath);
  return fuzzyPositions(path, q) ?? [];
}

/** For ordering spread-out matches: fewer skipped characters first, and ones ending in the file name before others. */
export function fuzzyCost(path: string, query: string): number {
  const at = fuzzyPositions(path, query);
  if (!at) return Infinity;
  const gaps = at.length ? at[at.length - 1] - at[0] + 1 - at.length : 0;
  const inName = at.length > 0 && at[at.length - 1] > path.lastIndexOf("/");
  return gaps + (inName ? 0 : 1000);
}

/** Text cut into runs, marked where `positions` fall: for drawing a match. */
export function markRuns(text: string, positions: readonly number[]): { text: string; hit: boolean }[] {
  const hits = new Set(positions);
  const out: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = hits.has(i);
    const last = out.at(-1);
    if (last && last.hit === hit) last.text += text[i];
    else out.push({ text: text[i], hit });
  }
  return out;
}

/** "src/app.ts:42" typed in a picker: what to search for, and the line to open at. */
export function splitQueryLine(query: string): { query: string; line?: number } {
  const m = /^(.*?):(\d+)$/.exec(query.trim());
  return m && m[1] ? { query: m[1], line: Number(m[2]) || undefined } : { query: query.trim() };
}
