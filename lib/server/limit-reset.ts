/* When a usage limit says it lifts, read from the agent's own error text. Each CLI words it differently:
 *   Claude   "Claude AI usage limit reached|1760000000", "5-hour limit reached ∙ resets 3pm (Europe/Berlin)"
 *   Codex    "You've hit your usage limit. ... try again in 2 hours 13 minutes." / "try again at 3:45 PM"
 *   Gemini   "Quota exceeded ... Please retry in 41.2s." / "retryDelay": "41s"
 *   others   ISO timestamps ("resets at 2026-10-19T15:00:00Z"), "Retry-After: 30"
 * Anything else is null, and the caller falls back. */

/** the longest wait worth keeping a turn for; further out, another profile serves better */
export const MAX_RESET_WAIT_MS = 24 * 60 * 60_000;

const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };

function unitMs(word: string): number | null {
  const w = word.toLowerCase();
  if (/^(d|days?)$/.test(w)) return UNIT_MS.d;
  if (/^(h|hrs?|hours?)$/.test(w)) return UNIT_MS.h;
  if (/^(m|mins?|minutes?)$/.test(w)) return UNIT_MS.m;
  if (/^(s|secs?|seconds?)$/.test(w)) return UNIT_MS.s;
  return null;
}

/** "2 hours 13 minutes", "1h 30m", "41.2s", "4 days, 2 hours and 5 minutes" */
export function parseDuration(text: string): number | null {
  let total = 0;
  let any = false;
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) {
    const unit = unitMs(m[2]);
    if (unit === null) break;
    total += Number(m[1]) * unit;
    any = true;
  }
  return any ? Math.round(total) : null;
}

/** how far `timeZone`'s wall clock is ahead of UTC at `at` (ms); null for a zone this runtime doesn't know */
function zoneOffset(timeZone: string, at: number): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at);
    const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - Math.floor(at / 1000) * 1000;
  } catch {
    return null;
  }
}

/** the next time the clock in `timeZone` (else the server's) reads hour:minute */
function nextClock(hour: number, minute: number, now: number, timeZone?: string): number | null {
  if (hour > 23 || minute > 59) return null;
  const offset = timeZone ? zoneOffset(timeZone, now) : -new Date(now).getTimezoneOffset() * 60_000;
  if (offset === null) return null;
  const wall = new Date(now + offset);
  let at = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), hour, minute) - offset;
  if (at <= now) at += UNIT_MS.d;
  return at;
}

/** When the limit in `text` resets (epoch ms), if it says and that's within MAX_RESET_WAIT_MS; else null. */
export function parseResetAt(text: string, now = Date.now()): number | null {
  const within = (at: number | null) => (at !== null && Number.isFinite(at) && at > now && at - now <= MAX_RESET_WAIT_MS ? at : null);

  const stamp = /\|\s*(\d{10,13})\b/.exec(text);
  if (stamp) return within(stamp[1].length > 11 ? Number(stamp[1]) : Number(stamp[1]) * 1000);

  const iso = /\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))/.exec(text);
  if (iso) return within(Date.parse(iso[1].replace(" ", "T")));

  const delay = /retry[_ -]?delay"?\s*[:=]\s*"?(\d+(?:\.\d+)?)s\b/i.exec(text) ?? /retry-after:?\s*(\d+)\b/i.exec(text);
  if (delay) return within(now + Math.round(Number(delay[1]) * 1000));

  const inDur = /\b(?:try again|retry|resets?|reset|available(?: again)?|wait)\b[^.\d]{0,16}?\bin\s+((?:\d+(?:\.\d+)?\s*[a-z]+[\s,]*(?:and\s+)?)+)/i.exec(text);
  if (inDur) {
    const ms = parseDuration(inDur[1]);
    return ms === null ? null : within(now + ms);
  }

  const clock = /\b(?:try again|resets?|reset|available(?: again)?)\b(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z_+-]+)*)\))?/i.exec(text);
  if (clock && (clock[2] || clock[3])) {
    let hour = Number(clock[1]);
    const ampm = clock[3]?.toLowerCase();
    if (ampm && (hour < 1 || hour > 12)) return null;
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    return within(nextClock(hour, Number(clock[2] ?? 0), now, clock[4]));
  }
  return null;
}

/** "2 h 13 min", "45 s", for notices */
export function formatWait(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}
