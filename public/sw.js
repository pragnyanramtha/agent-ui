/* agent-u service worker: shows push notifications and opens the session they're about. No caching. */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

/* Safari takes push permission back from sites whose pushes show nothing, so there it always shows */
const apple = /Safari/.test(navigator.userAgent) && !/Chrome|Chromium|CriOS|Edg|Firefox|FxiOS/.test(navigator.userAgent);

/* how long "Allowed" or "Denied" stays up after a tap on the notification's button */
const CONFIRM_MS = 4000;

self.addEventListener("push", (event) => {
  let msg;
  try {
    msg = event.data.json();
  } catch {
    msg = { title: "agent-u", body: event.data ? event.data.text() : "", tag: "agent-u", url: "/", kind: "test" };
  }
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of wins) c.postMessage({ type: "push", msg });
      const watching = wins.some((c) => c.focused && c.visibilityState === "visible");
      if (watching && !apple && msg.kind !== "test") return;
      const token = msg.respond && typeof msg.respond.token === "string" ? msg.respond.token : null;
      await self.registration.showNotification(msg.title || "agent-u", {
        body: msg.body || "",
        tag: msg.tag || "agent-u",
        renotify: msg.kind !== "done",
        icon: "/apple-touch-icon.png",
        /* browsers without notification buttons ignore these; a tap still opens the session */
        actions: token
          ? [
              { action: "allow", title: "Allow" },
              { action: "deny", title: "Deny" },
            ]
          : [],
        data: { url: msg.url || "/", token, body: msg.body || "", tag: msg.tag || "agent-u" },
      });
    })(),
  );
});

async function openUrl(url) {
  const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const win = wins.find((c) => new URL(c.url).origin === self.location.origin);
  if (win) {
    await win.focus();
    win.postMessage({ type: "open", url });
    return;
  }
  await self.clients.openWindow(url);
}

/* the token, not the cookie, answers this one approval; anything but a clean yes opens the session instead */
async function respond(action, data, url) {
  let ok = false;
  try {
    const res = await fetch("/api/push/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-agent-u-push": data.token },
      body: JSON.stringify({ action }),
      cache: "no-store",
    });
    ok = res.ok;
  } catch {}
  if (!ok) return openUrl(url);
  const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const c of wins) c.postMessage({ type: "push", msg: { kind: "answered" } });
  const tag = data.tag || "agent-u";
  await self.registration.showNotification(action === "allow" ? "Allowed" : "Denied", {
    body: data.body || "",
    tag,
    renotify: false,
    silent: true,
    icon: "/apple-touch-icon.png",
    data: { url },
  });
  await new Promise((resolve) => setTimeout(resolve, CONFIRM_MS));
  for (const n of await self.registration.getNotifications({ tag })) if (n.data && !n.data.token) n.close();
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = new URL(data.url || "/", self.location.origin).href;
  if ((event.action === "allow" || event.action === "deny") && data.token) {
    event.waitUntil(respond(event.action, data, url));
    return;
  }
  event.waitUntil(openUrl(url));
});
