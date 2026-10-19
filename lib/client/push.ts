"use client";

import { api } from "./api";

/* Browser side of Web Push: the service worker, the subscription, and keeping the server's copy current. */

export type PushStatus = "on" | "off" | "denied" | "unsupported" | "install";

const ios = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

export function registerWorker() {
  if (!("serviceWorker" in navigator)) return;
  void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
}

const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

async function current() {
  const reg = await navigator.serviceWorker.ready;
  return { reg, sub: await reg.pushManager.getSubscription() };
}

export async function pushStatus(): Promise<PushStatus> {
  /* iOS only offers push to a site added to the Home Screen */
  if (!supported()) return ios() && !standalone() ? "install" : "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission !== "granted") return "off";
  const { sub } = await current();
  return sub ? "on" : "off";
}

function keyBytes(b64: string) {
  const raw = atob((b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

const sameKey = (a: ArrayBuffer | null, b: Uint8Array) => {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
};

async function subscription(publicKey: string) {
  const { reg, sub } = await current();
  const key = keyBytes(publicKey);
  /* a server that made new keys can't push to a subscription made for the old ones */
  if (sub && sameKey(sub.options.applicationServerKey, key)) return sub;
  await sub?.unsubscribe().catch(() => undefined);
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
}

/** Asks for permission (call from a tap), subscribes, and has the server send a test notification. */
export async function enablePush() {
  registerWorker();
  if ((await Notification.requestPermission()) !== "granted") throw new Error("Notifications are blocked. Allow them in site settings.");
  const { publicKey } = await api<{ publicKey: string }>("/api/push");
  const sub = await subscription(publicKey);
  await api("/api/push", { subscription: sub.toJSON(), test: true });
}

/** Has the server send this browser a test notification (push already on). */
export async function testPush() {
  const { publicKey } = await api<{ publicKey: string }>("/api/push");
  const sub = await subscription(publicKey);
  await api("/api/push", { subscription: sub.toJSON(), test: true });
}

export async function disablePush() {
  const { sub } = await current();
  if (!sub) return;
  await fetch("/api/push", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => undefined);
  await sub.unsubscribe().catch(() => undefined);
}

/** On load: a browser that already said yes re-sends its subscription, so a server that lost it gets it back. */
export async function resyncPush() {
  if (!supported() || Notification.permission !== "granted") return;
  const { sub } = await current();
  if (!sub) return;
  const { publicKey } = await api<{ publicKey: string }>("/api/push");
  const fresh = await subscription(publicKey);
  await api("/api/push", { subscription: fresh.toJSON() });
}
