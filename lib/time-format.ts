/* Every time of day the app shows goes through here, so the thread's dividers, message stamps, usage tables, snooze
 * labels and hover titles all read the same way. `fmt` is the Time format setting: "system" leaves the 12 or 24-hour
 * choice to the locale, the others force it. No React, no DOM, so the server and tests can use it too. */

export type TimeFormat = "system" | "12h" | "24h";

type At = number | string | Date;

const toDate = (at: At): Date | null => {
  if (at === "" || at === null || at === undefined) return null;
  const d = at instanceof Date ? at : new Date(at);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Options for the time part: "2:17 PM" or "14:17". Hour cycles are explicit so en-US can read 24-hour and en-GB 12-hour. */
export function timeOptions(fmt: TimeFormat): Intl.DateTimeFormatOptions {
  if (fmt === "12h") return { hour: "numeric", minute: "2-digit", hourCycle: "h12" };
  if (fmt === "24h") return { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  return { hour: "numeric", minute: "2-digit" };
}

const cache = new Map<string, Intl.DateTimeFormat>();
function formatter(locale: string | undefined, opts: Intl.DateTimeFormatOptions) {
  const key = `${locale ?? ""}|${JSON.stringify(opts)}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, opts);
    if (cache.size > 64) cache.clear();
    cache.set(key, f);
  }
  return f;
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
/** whole calendar days from `now` to `d` (negative in the past); rounded so DST days still count as one */
const dayDiff = (d: Date, now: Date) => Math.round((startOfDay(d) - startOfDay(now)) / 86_400_000);

/** "2:17 PM" or "14:17"; "" for a missing or unreadable time. */
export function clockTime(at: At, fmt: TimeFormat = "system", locale?: string): string {
  const d = toDate(at);
  return d ? formatter(locale, timeOptions(fmt)).format(d) : "";
}

/** The thread's time divider: "Today 14:02", "Yesterday 09:10", "Mon, Oct 6 · 14:02", "Mon, Oct 6, 2025 · 14:02". */
export function dayStamp(at: At, fmt: TimeFormat = "system", now = new Date(), locale?: string): string {
  const d = toDate(at);
  if (!d) return "";
  const time = clockTime(d, fmt, locale);
  const diff = dayDiff(d, now);
  if (diff === 0) return `Today ${time}`;
  if (diff === -1) return `Yesterday ${time}`;
  const year = d.getFullYear() !== now.getFullYear() ? "numeric" : undefined;
  return `${formatter(locale, { weekday: "short", month: "short", day: "numeric", year }).format(d)} · ${time}`;
}

/** The full date and time, for hover titles: "Mon, Oct 6, 2026, 2:17 PM". */
export function fullDateTime(at: At, fmt: TimeFormat = "system", locale?: string): string {
  const d = toDate(at);
  return d ? formatter(locale, { weekday: "short", year: "numeric", month: "short", day: "numeric", ...timeOptions(fmt) }).format(d) : "";
}

/** A time ahead, short: "6:00 PM" today, "Tue 9:00 AM" this week, else the date. */
export function upcomingTime(at: At, now: At, fmt: TimeFormat = "system", locale?: string): string {
  const d = toDate(at);
  const n = toDate(now);
  if (!d || !n) return "";
  const days = dayDiff(d, n);
  if (days <= 0) return clockTime(d, fmt, locale);
  if (days < 7) return `${weekdayShort(d, locale)} ${clockTime(d, fmt, locale)}`;
  return formatter(locale, { month: "short", day: "numeric" }).format(d);
}

export const weekdayShort = (at: At, locale?: string) => {
  const d = toDate(at);
  return d ? formatter(locale, { weekday: "short" }).format(d) : "";
};
