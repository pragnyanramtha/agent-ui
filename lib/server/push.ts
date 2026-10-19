import fs from "node:fs";
import path from "node:path";
import webpush from "web-push";
import type { NotifyMessage } from "@/lib/notify-events";
import { CONFIG_DIR } from "./profiles";

/* Web Push: one VAPID key pair for this server, and the browsers that asked for notifications. Kept next to the
 * profiles config (not in the app folder, which every deploy replaces). */

export type Subscription = { endpoint: string; keys: { p256dh: string; auth: string }; origin: string; ua: string; at: number };
type Store = { publicKey: string; privateKey: string; subs: Subscription[] };

export const PUSH_PATH = process.env.AGENT_U_PUSH || path.join(CONFIG_DIR, "push.json");
const MAX_SUBS = 20;

/* instrumentation (notify) and the route handlers are separate bundles with their own module state: share the cache
 * through globalThis, and re-read the file whenever another writer replaced it */
const g = globalThis as typeof globalThis & { __agentuPush?: { cache: Store | null; stamp: string } };
const held = (g.__agentuPush ??= { cache: null, stamp: "" });

function stampOf() {
  try {
    const st = fs.statSync(PUSH_PATH);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return "";
  }
}

function load(): Store {
  const stamp = stampOf();
  if (held.cache && stamp && stamp === held.stamp) return held.cache;
  let text: string;
  try {
    text = fs.readFileSync(PUSH_PATH, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return unreadable(err, stamp);
    held.cache = { ...webpush.generateVAPIDKeys(), subs: [] };
    write();
    return held.cache;
  }
  try {
    const raw = JSON.parse(text) as Partial<Store>;
    if (!raw.publicKey || !raw.privateKey) throw new Error("no key pair in it");
    held.stamp = stamp;
    return (held.cache = { publicKey: raw.publicKey, privateKey: raw.privateKey, subs: Array.isArray(raw.subs) ? raw.subs : [] });
  } catch (err) {
    return unreadable(err, stamp);
  }
}

/* new keys would silently unsubscribe every browser, so a damaged file is never replaced with fresh ones */
function unreadable(err: unknown, stamp: string): Store {
  const why = `Can't read ${PUSH_PATH}: ${err instanceof Error ? err.message : String(err)}`;
  if (!held.cache) throw new Error(why);
  console.warn(`${why} (using the keys loaded earlier)`);
  /* warn once per version of the file, not on every poll */
  held.stamp = stamp;
  return held.cache;
}

function write() {
  if (!held.cache) return;
  fs.mkdirSync(path.dirname(PUSH_PATH), { recursive: true, mode: 0o700 });
  const tmp = `${PUSH_PATH}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(held.cache, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, PUSH_PATH);
  held.stamp = stampOf();
}

export const vapidPublicKey = () => load().publicKey;

export const subscriptionCount = () => load().subs.length;

export function subscribe(sub: Subscription) {
  const store = load();
  store.subs = [sub, ...store.subs.filter((s) => s.endpoint !== sub.endpoint)].slice(0, MAX_SUBS);
  write();
}

export function unsubscribe(endpoint: string) {
  const store = load();
  const before = store.subs.length;
  store.subs = store.subs.filter((s) => s.endpoint !== endpoint);
  if (store.subs.length !== before) write();
}

export type PushMessage = NotifyMessage;

/** Sends to every subscribed browser; ones the push service says are gone are dropped. */
export async function pushAll(msg: PushMessage, only?: string) {
  const store = load();
  const targets = only ? store.subs.filter((s) => s.endpoint === only) : store.subs;
  const gone: string[] = [];
  let sent = 0;
  await Promise.all(
    targets.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(msg), {
          /* Apple refuses a VAPID subject it can't read as a contact; the site's own https origin is one */
          vapidDetails: { subject: s.origin.startsWith("https://") ? s.origin : "mailto:agent-u@example.com", publicKey: store.publicKey, privateKey: store.privateKey },
          TTL: 60 * 60,
          urgency: msg.kind === "done" ? "normal" : "high",
          topic: msg.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || undefined,
        });
        sent++;
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) gone.push(s.endpoint);
        else console.warn(`push to ${new URL(s.endpoint).host} failed: ${code ?? (err as Error).message}`);
      }
    }),
  );
  if (gone.length) {
    /* reloaded: a browser may have subscribed while these were in flight */
    const now = load();
    now.subs = now.subs.filter((s) => !gone.includes(s.endpoint));
    write();
  }
  return { sent, dropped: gone.length };
}

/** test hook */
export const resetPushCache = () => {
  held.cache = null;
  held.stamp = "";
};
