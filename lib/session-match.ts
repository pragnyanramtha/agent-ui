import type { SessionSummary } from "@/lib/types";

/**
 * How well `q` matches `text`: prefix > word start > substring > in-order
 * characters (so "agu" finds "agent-u"). 0 means no match.
 */
export function score(text: string, q: string) {
  const t = text.toLowerCase();
  const i = t.indexOf(q);
  if (i === 0) return 100;
  if (i > 0) return /[\s/_.-]/.test(t[i - 1]) ? 80 : 60;
  let at = 0;
  for (const ch of q) {
    at = t.indexOf(ch, at);
    if (at < 0) return 0;
    at++;
  }
  return q.length > 1 ? 20 : 0;
}

/** Every word of the query has to land somewhere; the title counts most. */
export function matchSession(s: SessionSummary, words: string[]) {
  let total = 0;
  for (const w of words) {
    const best = Math.max(score(s.title, w) * 1.5, score(s.project, w), score(s.cwd, w) * 0.8);
    if (!best) return 0;
    total += best;
  }
  return total;
}

export const queryWords = (q: string) => q.trim().toLowerCase().split(/\s+/).filter(Boolean);
