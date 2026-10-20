export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly terminal?: string) {
    super(message);
  }
}

export async function api<T = unknown>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  if (res.status === 401 && typeof window !== "undefined") {
    window.location.href = "/login";
    throw new ApiError("Signed out", 401);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string; terminal?: string };
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status, data.code, data.terminal);
  return data;
}

export function timeAgo(ms: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/* "~" only for the server user's own home; other users' folders (/home/pik) stay spelled out */
let serverHome: string | null = null;
export const setServerHome = (h: string | undefined) => void (h && h !== "/" && (serverHome = h.replace(/\/+$/, "")));
export const shortPath = (p: string) => (serverHome && (p === serverHome || p.startsWith(`${serverHome}/`)) ? `~${p.slice(serverHome.length)}` : p);
