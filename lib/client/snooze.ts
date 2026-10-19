/* Snooze presets for the sidebar's row menu, resolved against the device's clock and time zone. */

export type SnoozePreset = { id: "hour" | "tonight" | "tomorrow" | "next-week"; label: string; at: number; when: string };

const HOUR = 3_600_000;
const EVENING = 18;
const MORNING = 9;

const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const weekday = (d: Date) => d.toLocaleDateString(undefined, { weekday: "short" });

const atHour = (base: Date, days: number, hour: number) => {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d;
};

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** In 1 hour, tonight at 18:00 (while that's over an hour away), tomorrow at 09:00 and next Monday at 09:00. */
export function snoozePresets(now: Date): SnoozePreset[] {
  const hour = new Date(now.getTime() + HOUR);
  const out: SnoozePreset[] = [{ id: "hour", label: "In 1 hour", at: hour.getTime(), when: time(hour) }];
  const tonight = atHour(now, 0, EVENING);
  if (tonight.getTime() - now.getTime() > HOUR) out.push({ id: "tonight", label: "Tonight", at: tonight.getTime(), when: time(tonight) });
  const tomorrow = atHour(now, 1, MORNING);
  out.push({ id: "tomorrow", label: "Tomorrow", at: tomorrow.getTime(), when: time(tomorrow) });
  const monday = atHour(now, (1 - now.getDay() + 7) % 7 || 7, MORNING);
  /* on a Sunday, next Monday is tomorrow */
  if (monday.getTime() !== tomorrow.getTime()) out.push({ id: "next-week", label: "Next week", at: monday.getTime(), when: `${weekday(monday)} ${time(monday)}` });
  return out;
}

/** When a snoozed session comes back, short: "6:00 PM" today, "Tue 9:00 AM" this week, else the date. */
export function wakeLabel(at: number, now: number): string {
  const d = new Date(at);
  const days = Math.round((startOfDay(d) - startOfDay(new Date(now))) / 86_400_000);
  if (days <= 0) return time(d);
  if (days < 7) return `${weekday(d)} ${time(d)}`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The full wake time, for hover titles. */
export const wakeFull = (at: number) => new Date(at).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
