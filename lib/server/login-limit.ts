/* Login throttling. Per client: 8 attempts per 15 minutes. Across all clients: 30 failures per 10 minutes, so
 * rotating addresses (or a header nobody vouches for) can't buy unlimited guesses.
 *
 * The client address only counts when a proxy we trust put it there: with TRUST_PROXY_HEADERS=1 (scripts/setup.sh sets
 * it for the Cloudflare tunnel, which overwrites cf-connecting-ip) that header is the client. Otherwise anyone could
 * send their own, and route handlers can't see the socket peer, so every such request shares one bucket. */

export const WINDOW_MS = 15 * 60_000;
export const MAX_ATTEMPTS = 8;
export const GLOBAL_WINDOW_MS = 10 * 60_000;
export const GLOBAL_MAX_FAILURES = 30;
export const SHARED = "untrusted";

/** IPv4 as is; IPv6 by its /64 (one host usually owns a whole /64); anything else is one shared bucket */
export function ipBucket(raw: string): string {
  const ip = raw.trim().toLowerCase();
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (v4) return v4[1];
  if (!/^[0-9a-f:]+$/.test(ip) || !ip.includes(":")) return SHARED;
  const halves = ip.split("::");
  if (halves.length > 2) return SHARED;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groups = halves.length === 2 ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail] : head;
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return SHARED;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

export function clientKey(headers: Headers, trustProxy = process.env.TRUST_PROXY_HEADERS === "1"): string {
  if (!trustProxy) return SHARED;
  const ip = headers.get("cf-connecting-ip");
  return ip ? ipBucket(ip) : SHARED;
}

export class LoginLimiter {
  private attempts = new Map<string, number[]>();
  private failures: number[] = [];

  /** counts an attempt for `key`; refused ones say how many seconds to wait */
  begin(key: string, now = Date.now()): { ok: true } | { ok: false; retryAfter: number } {
    this.failures = this.failures.filter((t) => now - t < GLOBAL_WINDOW_MS);
    if (this.failures.length >= GLOBAL_MAX_FAILURES) return { ok: false, retryAfter: Math.ceil((this.failures[0] + GLOBAL_WINDOW_MS - now) / 1000) };
    if (this.attempts.size > 10_000) {
      for (const [k, times] of this.attempts) if (times.every((t) => now - t >= WINDOW_MS)) this.attempts.delete(k);
    }
    const recent = (this.attempts.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= MAX_ATTEMPTS) return { ok: false, retryAfter: Math.ceil((recent[0] + WINDOW_MS - now) / 1000) };
    this.attempts.set(key, [...recent, now]);
    return { ok: true };
  }

  failed(now = Date.now()) {
    this.failures.push(now);
  }

  succeeded(key: string) {
    this.attempts.delete(key);
  }
}
