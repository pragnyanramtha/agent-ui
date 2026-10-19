/* Session cookie signing with Web Crypto (Node route handlers and the Node-runtime middleware).
 * The cookie is `<expiry>.<hmac>`, the HMAC (keyed by UI_SECRET) also covering the session epoch and the password, so a
 * new password or "Sign out everywhere" (a new epoch) ends every session. server/pty.mjs verifies the same way. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const COOKIE = "cui_session";
export const SESSION_DAYS = 30;

const encoder = new TextEncoder();

function secret() {
  const value = process.env.UI_SECRET;
  if (!value || value.length < 32) throw new Error("UI_SECRET must be set to at least 32 characters");
  return value;
}

/** what checkPassword in the login route compares against: the hash wins when both are set */
const password = () => process.env.UI_PASSWORD_HASH || process.env.UI_PASSWORD || "";

const b64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** next to config.json (lib/server/profiles.ts CONFIG_DIR) */
export const authFile = () =>
  path.join(process.env.AGENT_U_HOME || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "agent-u"), "auth.json");

let cached: { key: string; epoch: string } | null = null;

/** "" until the first "Sign out everywhere"; a file that exists but can't be read counts as its own epoch */
export function sessionEpoch(): string {
  const file = authFile();
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return "";
  }
  const key = `${file}:${st.ino}:${st.mtimeMs}:${st.size}`;
  if (cached?.key === key) return cached.epoch;
  let epoch = "invalid";
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8")).epoch;
    if (typeof value === "string" && value) epoch = value;
  } catch {
    /* unreadable or not JSON */
  }
  cached = { key, epoch };
  return epoch;
}

/** a fresh epoch: every cookie signed before stops working, here and in the terminal backend */
export function newSessionEpoch(): string {
  const file = authFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const epoch = b64url(crypto.getRandomValues(new Uint8Array(18)).buffer);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ epoch, changedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  cached = null;
  return epoch;
}

async function hmac(expires: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, encoder.encode(`${expires}\n${sessionEpoch()}\n${password()}`)));
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
