/** "Today 14:02", "Yesterday 09:10", "Mon, Oct 6 · 14:02", and "Mon, Oct 6, 2025 · 14:02" from another year */
export function stamp(ms: number, now = new Date(), locale?: string) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) return `Today ${time}`;
  if (diff === 1) return `Yesterday ${time}`;
  const year = d.getFullYear() !== now.getFullYear() ? "numeric" : undefined;
  return `${d.toLocaleDateString(locale, { weekday: "short", month: "short", day: "numeric", year })} · ${time}`;
}
