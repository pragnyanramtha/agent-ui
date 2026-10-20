"use client";

/* The tab title, the tab icon and the installed app's badge all carry how many sessions are waiting on you. */

export type BadgeStyle = "off" | "dot" | "count";

/** "(2) agent-u" while two sessions need you */
export const titleFor = (base: string, n: number, style: BadgeStyle) => (n > 0 && style !== "off" ? `(${n > 99 ? "99+" : n}) ${base}` : base);

/** What the tab icon shows: nothing, a plain dot, or the count (9+ past nine, there's no room for more) */
export function badgeMark(n: number, style: BadgeStyle): { kind: "none" } | { kind: "dot" } | { kind: "count"; text: string } {
  if (n <= 0 || style === "off") return { kind: "none" };
  if (style === "dot") return { kind: "dot" };
  return { kind: "count", text: n > 9 ? "9+" : String(n) };
}

let base = "agent-u";
let count = 0;
let style: BadgeStyle = "count";
let flash = 0;

const shown = () => Math.max(count, flash);

function apply() {
  document.title = titleFor(base, shown(), style);
  void drawIcon(badgeMark(shown(), style));
}

export function setBaseTitle(title: string) {
  base = title;
  document.title = titleFor(base, shown(), style);
}

export function setAttention(n: number) {
  if (n === count) return;
  count = n;
  apply();
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  void (n && style !== "off" ? nav.setAppBadge?.(n) : nav.clearAppBadge?.())?.catch(() => undefined);
}

export function setBadgeStyle(next: BadgeStyle) {
  if (next === style) return;
  style = next;
  apply();
}

/** Shows a badge of one for a few seconds (the test notification). */
export function flashAttention(ms = 5000) {
  flash = 1;
  apply();
  setTimeout(() => {
    flash = 0;
    apply();
  }, ms);
}

/* ── the tab icon ─────────────────────────────────────────── */

const SIZE = 64;
let original: Map<HTMLLinkElement, string> | null = null;
let iconImg: Promise<HTMLImageElement | null> | null = null;
let drawn = "";

function links(): HTMLLinkElement[] {
  return [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')];
}

function loadIcon(href: string) {
  iconImg ??= new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = href;
  });
  return iconImg;
}

async function drawIcon(mark: ReturnType<typeof badgeMark>) {
  const key = mark.kind === "count" ? `count:${mark.text}` : mark.kind;
  if (key === drawn) return;
  drawn = key;
  original ??= new Map(links().map((l) => [l, l.href]));
  if (mark.kind === "none") {
    for (const [l, href] of original) {
      l.href = href;
      l.removeAttribute("data-badge");
    }
    return;
  }
  const first = [...original.values()][0] ?? "/icon.svg";
  const img = await loadIcon(first);
  if (drawn !== key) return;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  const g = canvas.getContext("2d");
  if (!g) return;
  if (img) g.drawImage(img, 0, 0, SIZE, SIZE);
  g.fillStyle = "#e5484d";
  g.strokeStyle = "#ffffff";
  g.lineWidth = 3;
  g.beginPath();
  if (mark.kind === "dot") g.arc(SIZE - 15, 15, 13, 0, Math.PI * 2);
  else g.arc(SIZE - 19, 19, 19, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  if (mark.kind === "count") {
    g.fillStyle = "#ffffff";
    g.font = `700 ${mark.text.length > 1 ? 22 : 28}px system-ui, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(mark.text, SIZE - 19, 20.5);
  }
  const url = canvas.toDataURL("image/png");
  /* links Next added later (a navigation) are picked up too */
  for (const l of links()) {
    if (!original.has(l)) original.set(l, l.href);
    l.href = url;
    l.setAttribute("data-badge", key);
  }
  if (!links().length) {
    const l = document.createElement("link");
    l.rel = "icon";
    l.href = url;
    document.head.appendChild(l);
    original.set(l, first);
  }
}
