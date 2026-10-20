import { scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { NextResponse, type NextRequest } from "next/server";
import { COOKIE, SESSION_DAYS, signSession } from "@/lib/auth";
import { readJson, str } from "@/lib/server/http";
import { clientKey, LoginLimiter } from "@/lib/server/login-limit";

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

const g = globalThis as typeof globalThis & { __agentuLoginLimit?: LoginLimiter };
const limiter = (g.__agentuLoginLimit ??= new LoginLimiter());

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
  const key = clientKey(req.headers);
  /* counted before the slow hash, so parallel requests can't all slip under the limit */
  const gate = limiter.begin(key);
  if (!gate.ok) {
    const minutes = Math.max(1, Math.ceil(gate.retryAfter / 60));
    return NextResponse.json(
      { error: `Too many attempts. Wait ${minutes} minute${minutes === 1 ? "" : "s"} and try again.` },
      { status: 429, headers: { "Retry-After": String(Math.max(1, gate.retryAfter)) } },
    );
  }

  const password = str((await readJson(req)).password);
  if (!password || password.length > 1024 || !(await checkPassword(password))) {
    limiter.failed();
    return NextResponse.json({ error: "Wrong password." }, { status: 401 });
  }

  limiter.succeeded(key);
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
