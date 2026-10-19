/* Session cookie signing with Web Crypto, so it runs in both the edge
 * middleware and Node route handlers. The cookie is `<expiry>.<hmac>`. */

export const COOKIE = "cui_session";
export const SESSION_DAYS = 30;

const encoder = new TextEncoder();

function secret() {
  const value = process.env.UI_SECRET;
  if (!value || value.length < 32) throw new Error("UI_SECRET must be set to at least 32 characters");
  return value;
}

const b64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hmac(payload: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** not expired, and not further out than a cookie we sign could be (a minute of slack for clock steps) */
const inLifetime = (expires: number) => expires >= Date.now() && expires <= Date.now() + SESSION_DAYS * 86_400_000 + 60_000;

export async function signSession() {
  const expires = Date.now() + SESSION_DAYS * 86_400_000;
  return `${expires}.${await hmac(String(expires))}`;
}

export async function verifySession(cookie: string | undefined) {
  if (!cookie) return false;
  const [expires, sig, extra] = cookie.split(".");
  if (!/^\d+$/.test(expires ?? "") || !sig || extra !== undefined || !inLifetime(Number(expires))) return false;
  return safeEqual(sig, await hmac(expires));
}
