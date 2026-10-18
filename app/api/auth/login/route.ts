import { scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { NextResponse, type NextRequest } from "next/server";
import { COOKIE, SESSION_DAYS, signSession } from "@/lib/auth";
import { readJson, str } from "@/lib/server/http";

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

/* Small in-memory limiter: 8 attempts per 15 minutes per client address. */
const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 8;
const g = globalThis as typeof globalThis & { __claudeUiLogin?: Map<string, number[]> };
const attempts = (g.__claudeUiLogin ??= new Map());

async function checkPassword(password: string) {
  /* plain UI_PASSWORD is allowed for convenience; the hash wins when both are set */
  const plain = process.env.UI_PASSWORD;
  if (plain && !process.env.UI_PASSWORD_HASH) {
    const a = Buffer.from(password);
    const b = Buffer.from(plain);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  const stored = process.env.UI_PASSWORD_HASH ?? "";
  /* ":"-separated: Next's .env loader expands "$" sequences */
  const [scheme, salt, hash] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !hash) throw new Error("No password set. Add UI_PASSWORD to .env.local.");
  const expected = Buffer.from(hash, "base64url");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64url"), expected.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(actual, expected);
}

export async function POST(req: NextRequest) {
  const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const now = Date.now();
  if (attempts.size > 10_000) {
    for (const [key, times] of attempts) if (times.every((t: number) => now - t >= WINDOW_MS)) attempts.delete(key);
  }
  const recent = (attempts.get(ip) ?? []).filter((t: number) => now - t < WINDOW_MS);
  if (recent.length >= MAX_ATTEMPTS) {
    return NextResponse.json({ error: "Too many attempts. Wait 15 minutes and try again." }, { status: 429 });
  }
  /* count the attempt before the slow hash, so parallel requests can't all slip under the limit */
  attempts.set(ip, [...recent, now]);

  const password = str((await readJson(req)).password);
  if (!password || password.length > 1024 || !(await checkPassword(password))) {
    return NextResponse.json({ error: "Wrong password." }, { status: 401 });
  }

  attempts.delete(ip);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, await signSession(), {
    httpOnly: true,
    sameSite: "strict",
    secure: req.headers.get("x-forwarded-proto") === "https" || req.nextUrl.protocol === "https:",
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  });
  return res;
}
