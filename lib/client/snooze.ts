import { clockTime, fullDateTime, upcomingTime, weekdayShort, type TimeFormat } from "@/lib/time-format";
import { getSetting } from "./settings";

/* Snooze presets for the sidebar's row menu, resolved against the device's clock and time zone. */

export type SnoozePreset = { id: "hour" | "tonight" | "tomorrow" | "next-week"; label: string; at: number; when: string };

const HOUR = 3_600_000;
const EVENING = 18;
const MORNING = 9;

const fmtNow = (): TimeFormat => getSetting("timeFormat");

const atHour = (base: Date, days: number, hour: number) => {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d;
};

/** In 1 hour, tonight at 18:00 (while that's over an hour away), tomorrow at 09:00 and next Monday at 09:00. */
export function snoozePresets(now: Date, fmt = fmtNow()): SnoozePreset[] {
  const time = (d: Date) => clockTime(d, fmt);
  const hour = new Date(now.getTime() + HOUR);
  const out: SnoozePreset[] = [{ id: "hour", label: "In 1 hour", at: hour.getTime(), when: time(hour) }];
  const tonight = atHour(now, 0, EVENING);
  if (tonight.getTime() - now.getTime() > HOUR) out.push({ id: "tonight", label: "Tonight", at: tonight.getTime(), when: time(tonight) });
  const tomorrow = atHour(now, 1, MORNING);
  out.push({ id: "tomorrow", label: "Tomorrow", at: tomorrow.getTime(), when: time(tomorrow) });
  const monday = atHour(now, (1 - now.getDay() + 7) % 7 || 7, MORNING);
  /* on a Sunday, next Monday is tomorrow */
  if (monday.getTime() !== tomorrow.getTime()) out.push({ id: "next-week", label: "Next week", at: monday.getTime(), when: `${weekdayShort(monday)} ${time(monday)}` });
  return out;
}

/** When a snoozed session comes back, short: "6:00 PM" today, "Tue 9:00 AM" this week, else the date. */
export const wakeLabel = (at: number, now: number, fmt = fmtNow()): string => upcomingTime(at, now, fmt);

/** The full wake time, for hover titles. */
export const wakeFull = (at: number, fmt = fmtNow()) => fullDateTime(at, fmt);
