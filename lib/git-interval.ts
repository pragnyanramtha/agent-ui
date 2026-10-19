/* How often a repo someone is looking at gets fetched in the background. The server's default comes from
 * GIT_FETCH_INTERVAL_MS (ms, 0 turns it off); Settings > Git > Check the remote overrides it once someone picks one. */

/** The default when the server doesn't set GIT_FETCH_INTERVAL_MS. */
export const DEFAULT_FETCH_INTERVAL_MS = 60_000;

/** GIT_FETCH_INTERVAL_MS as a number of ms; anything unreadable is the default. */
export function parseFetchInterval(raw: string | undefined): number {
  const text = raw?.trim();
  const n = text ? Number(text) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_FETCH_INTERVAL_MS;
}

/** The setting's value in ms, or null for "server" (the server's own default). */
export function choiceMs(choice: string): number | null {
  if (choice === "server") return null;
  if (choice === "off") return 0;
  const n = Number(choice);
  return Number.isFinite(n) && n > 0 ? n * 60_000 : null;
}

const plural = (n: number, unit: string) => (n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`);

/** An interval as the setting names it: "Off", "Every minute", "Every 5 minutes", "Every 30 seconds". */
export function fetchIntervalLabel(ms: number): string {
  if (ms <= 0) return "Off";
  if (ms % 3_600_000 === 0) return plural(ms / 3_600_000, "hour");
  if (ms % 60_000 === 0) return plural(ms / 60_000, "minute");
  const s = Math.round(ms / 1000);
  return s % 60 === 0 ? plural(s / 60, "minute") : plural(Math.max(1, s), "second");
}
