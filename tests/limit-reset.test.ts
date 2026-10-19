import { describe, expect, it } from "vitest";
import { formatWait, MAX_RESET_WAIT_MS, parseDuration, parseResetAt } from "@/lib/server/limit-reset";

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const MIN = 60_000;

describe("reading when a usage limit resets", () => {
  it("reads Claude's epoch stamp, in seconds or ms", () => {
    expect(parseResetAt(`Claude AI usage limit reached|${(NOW + 90 * MIN) / 1000}`, NOW)).toBe(NOW + 90 * MIN);
    expect(parseResetAt(`usage limit reached|${NOW + 5 * MIN}`, NOW)).toBe(NOW + 5 * MIN);
  });

  it("reads durations", () => {
    expect(parseResetAt("You've hit your usage limit. Upgrade to Pro, or try again in 2 hours 13 minutes.", NOW)).toBe(NOW + 133 * MIN);
    expect(parseResetAt("Quota exceeded for quota metric. Please retry in 41.2s.", NOW)).toBe(NOW + 41_200);
    expect(parseResetAt("Rate limited, try again in 1h 30m", NOW)).toBe(NOW + 90 * MIN);
    expect(parseResetAt("limit reached; resets in 4 days, 2 hours and 5 minutes", NOW)).toBeNull();
    expect(parseResetAt('429 {"error":{"details":[{"retryDelay":"17s"}]}}', NOW)).toBe(NOW + 17_000);
    expect(parseResetAt("429 Too Many Requests. Retry-After: 30", NOW)).toBe(NOW + 30_000);
  });

  it("reads clock times in a stated zone", () => {
    /* 12:00 UTC is 14:00 in Berlin (CEST), so 3pm there is in an hour */
    expect(parseResetAt("5-hour limit reached ∙ resets 3pm (Europe/Berlin)", NOW)).toBe(NOW + 60 * MIN);
    /* 1pm Berlin has passed: tomorrow */
    expect(parseResetAt("You've hit your limit · resets 1pm (Europe/Berlin)", NOW)).toBe(NOW + 23 * 60 * MIN);
    expect(parseResetAt("resets 12:30am (UTC)", NOW)).toBe(NOW + 12.5 * 60 * MIN);
  });

  it("reads ISO timestamps", () => {
    expect(parseResetAt("quota exhausted until 2026-10-19T12:45:00Z", NOW)).toBe(NOW + 45 * MIN);
    expect(parseResetAt("resets at 2026-10-19T14:00:00+02:00", NOW)).toBeNull();
  });

  it("is null when it doesn't say, the time has passed, or it's too far off", () => {
    expect(parseResetAt("You've hit your usage limit.", NOW)).toBeNull();
    expect(parseResetAt("rate limit exceeded (code 429)", NOW)).toBeNull();
    expect(parseResetAt(`usage limit reached|${(NOW - MIN) / 1000}`, NOW)).toBeNull();
    expect(parseResetAt(`usage limit reached|${(NOW + MAX_RESET_WAIT_MS + MIN) / 1000}`, NOW)).toBeNull();
    expect(parseResetAt("resets 13pm", NOW)).toBeNull();
  });

  it("adds up durations and words them for notices", () => {
    expect(parseDuration("2 hours 13 minutes")).toBe(133 * MIN);
    expect(parseDuration("soon")).toBeNull();
    expect(formatWait(45_000)).toBe("45 s");
    expect(formatWait(133 * MIN)).toBe("2 h 13 min");
    expect(formatWait(120 * MIN)).toBe("2 h");
  });
});
