import { AGENT_LABEL, type SessionSummary } from "@/lib/types";
import { clockTime, type TimeFormat } from "@/lib/time-format";

/* The sidebar's list logic, apart from React so it can be tested: the order sessions show in, how they group, how a
 * row says when, and where arrow keys move focus. */

export type SidebarSort = "activity" | "created" | "title";
export type RecentsGroup = "none" | "time" | "agent";

type Sortable = Pick<SessionSummary, "id" | "title" | "mtime" | "created">;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const createdAt = (s: Sortable) => s.created || s.mtime;
const byId = (a: Sortable, b: Sortable) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Newest activity first, newest first by start time, or A to Z by title. Ties keep a fixed order, so rows don't swap between polls. */
export function sortSessions<T extends Sortable>(rows: readonly T[], by: SidebarSort): T[] {
  const out = [...rows];
  if (by === "title") return out.sort((a, b) => collator.compare(a.title, b.title) || b.mtime - a.mtime || byId(a, b));
  const key = by === "created" ? createdAt : (s: Sortable) => s.mtime;
  return out.sort((a, b) => key(b) - key(a) || byId(a, b));
}

export type ProjectGroup<T> = { key: string; name: string; rows: T[] };

/** Sessions by folder, each folder sorted. Folders follow their first session (the newest one), or go A to Z when
 * sorting by title. Sessions without a folder come last then. */
export function groupByProject<T extends Sortable & Pick<SessionSummary, "cwd" | "project">>(rows: readonly T[], by: SidebarSort): ProjectGroup<T>[] {
  const groups = new Map<string, ProjectGroup<T>>();
  for (const s of sortSessions(rows, by)) {
    const key = s.cwd || "";
    const g = groups.get(key) ?? { key, name: s.project || "No folder", rows: [] };
    g.rows.push(s);
    groups.set(key, g);
  }
  const out = [...groups.values()];
  if (by === "title") out.sort((a, b) => Number(!a.key) - Number(!b.key) || collator.compare(a.name, b.name) || collator.compare(a.key, b.key));
  return out;
}

export type ProjectCap = "5" | "10" | "20" | "all";
export const capCount = (cap: ProjectCap): number | null => (cap === "all" ? null : Number(cap));

/** The first `cap` rows, plus `keep` (the open session) when it sits further down, so it never hides behind "Show more". */
export function capRows<T extends { id: string }>(rows: readonly T[], cap: number | null, keep?: string | null): { shown: T[]; hidden: number } {
  if (cap === null || rows.length <= cap) return { shown: [...rows], hidden: 0 };
  const shown = rows.slice(0, cap);
  const i = keep ? rows.findIndex((r) => r.id === keep) : -1;
  if (i >= cap) shown.push(rows[i]);
  return { shown, hidden: rows.length - shown.length };
}

const DAY = 86_400_000;
const startOfDay = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
/** whole calendar days from `ms` to `now`, in local time (a DST day still counts as one) */
const daysAgo = (ms: number, now: number) => Math.round((startOfDay(now) - startOfDay(ms)) / DAY);

const TIME_BUCKETS = ["Today", "Yesterday", "This week", "This month", "Older"] as const;

export function timeBucket(ms: number, now: number): (typeof TIME_BUCKETS)[number] {
  const d = daysAgo(ms, now);
  return d <= 0 ? "Today" : d === 1 ? "Yesterday" : d < 7 ? "This week" : d < 31 ? "This month" : "Older";
}

/** The flat list split by day or by agent. Day groups keep calendar order whatever the sort; agents follow their first row. */
export function groupRows<T extends Pick<SessionSummary, "mtime" | "agent">>(rows: readonly T[], by: RecentsGroup, now: number): [string, T[]][] {
  if (by === "none") return [["", [...rows]]];
  const groups = new Map<string, T[]>();
  for (const s of rows) {
    const key = by === "time" ? timeBucket(s.mtime, now) : AGENT_LABEL[s.agent];
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const out = [...groups.entries()];
  if (by === "time") out.sort((a, b) => TIME_BUCKETS.indexOf(a[0] as (typeof TIME_BUCKETS)[number]) - TIME_BUCKETS.indexOf(b[0] as (typeof TIME_BUCKETS)[number]));
  return out;
}

/** A row's time, short: "now", "4m", "2h", "Yesterday", "Mon", then "Mar 4" this year and "Mar 2025" before. */
export function relativeTime(ms: number, now: number, locale?: string): string {
  const diff = now - ms;
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < DAY) return `${Math.floor(diff / 3_600_000)}h`;
  const days = daysAgo(ms, now);
  if (days <= 1) return "Yesterday";
  if (days < 7) return new Date(ms).toLocaleDateString(locale, { weekday: "short" });
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  return new Date(ms).toLocaleDateString(locale, sameYear ? { month: "short", day: "numeric" } : { month: "short", year: "numeric" });
}

/** A row's time as a clock or a date: "2:05 PM" (or "14:05", as Time format says) today, "Mar 4" this year, "3/4/25" before. */
export function absoluteTime(ms: number, now: number, locale?: string, fmt: TimeFormat = "system"): string {
  const d = new Date(ms);
  if (daysAgo(ms, now) === 0) return clockTime(d, fmt, locale);
  if (d.getFullYear() === new Date(now).getFullYear()) return d.toLocaleDateString(locale, { month: "short", day: "numeric" });
  return d.toLocaleDateString(locale, { year: "2-digit", month: "numeric", day: "numeric" });
}

/* ── roving focus ─────────────────────────────────────────── */

/** Where a key moves focus in a list of `count` items from `index` (-1: nothing focused yet). Null: not a move key.
 * The ends don't wrap, like a tree or a listbox. */
export function rovingTarget(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowDown":
      return index < 0 ? 0 : Math.min(index + 1, count - 1);
    case "ArrowUp":
      return index < 0 ? count - 1 : Math.max(index - 1, 0);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** Which item holds the list's one tab stop: the last one focused if it's still there, else the open session's row,
 * else the item nearest to where the last one was, else the first. -1 for an empty list. */
export function tabStop(keys: readonly string[], last: string | null, active: string | null, lastIndex = 0): number {
  if (!keys.length) return -1;
  const at = (k: string | null) => (k ? keys.indexOf(k) : -1);
  const i = at(last);
  if (i >= 0) return i;
  const a = at(active);
  if (a >= 0) return a;
  return Math.max(0, Math.min(lastIndex, keys.length - 1));
}
