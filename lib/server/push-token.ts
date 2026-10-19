import crypto from "node:crypto";
import { sessionEpoch } from "@/lib/auth";

/* Allow and Deny on an approval notification. The service worker can't count on the session cookie, so the push
 * carries a token that answers one request of one session, for ten minutes, once. It is an HMAC keyed by UI_SECRET
 * that also covers the session epoch and the password, like the cookie, so "Sign out everywhere" or a new password
 * ends every token too. The middleware lets that one route through on a valid token; the route spends it. */

export const RESPOND_PATH = "/api/push/respond";
export const RESPOND_HEADER = "x-agent-u-push";
export const RESPOND_TTL_MS = 10 * 60_000;

export type RespondTarget = { session: string; request: string; expires: number };

const MAX_TOKEN = 1024;

function secret() {
  const value = process.env.UI_SECRET;
  if (!value || value.length < 32) throw new Error("UI_SECRET must be set to at least 32 characters");
  return value;
}

const password = () => process.env.UI_PASSWORD_HASH || process.env.UI_PASSWORD || "";

const enc = (s: string) => Buffer.from(s, "utf8").toString("base64url");

function dec(s: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const out = Buffer.from(s, "base64url").toString("utf8");
  /* one spelling per value: anything that doesn't encode back the same was tampered with */
  return enc(out) === s ? out : null;
}

/* the "push-respond" prefix keeps these from ever matching a cookie signature, which signs other text */
const mac = (t: RespondTarget) =>
  crypto.createHmac("sha256", secret()).update(`push-respond\n${t.session}\n${t.request}\n${t.expires}\n${sessionEpoch()}\n${password()}`).digest("base64url");

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function signRespondToken(session: string, request: string, now = Date.now()): string {
  const t = { session, request, expires: now + RESPOND_TTL_MS };
  return `${enc(session)}.${enc(request)}.${t.expires}.${mac(t)}`;
}

/** What a token may answer, or null when it's malformed, forged, expired or from before a sign-out everywhere. */
export function readRespondToken(token: string | null | undefined, now = Date.now()): RespondTarget | null {
  if (typeof token !== "string" || !token || token.length > MAX_TOKEN) return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [s, r, e, sig] = parts;
  if (!/^\d{1,15}$/.test(e) || !sig) return null;
  const expires = Number(e);
  /* a minute of slack for clock steps, never a lifetime longer than we sign */
  if (expires < now || expires > now + RESPOND_TTL_MS + 60_000) return null;
  const session = dec(s);
  const request = dec(r);
  if (!session || !request) return null;
  const target = { session, request, expires };
  try {
    return safeEqual(sig, mac(target)) ? target : null;
  } catch {
    return null;
  }
}

/* spent tokens until they expire; the route handlers share one process, so globalThis holds it across bundles */
const g = globalThis as typeof globalThis & { __agentuSpentPush?: Map<string, number> };
const spent = (g.__agentuSpentPush ??= new Map());

/** Checks the token and marks it used; a second use (or a forged one) gets null. */
export function spendRespondToken(token: string | null | undefined, now = Date.now()): RespondTarget | null {
  const target = readRespondToken(token, now);
  if (!target) return null;
  for (const [k, exp] of spent) if (exp < now) spent.delete(k);
  if (spent.has(token!)) return null;
  spent.set(token!, target.expires);
  return target;
}
