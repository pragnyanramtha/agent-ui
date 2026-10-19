/* Which Host headers the app answers. A DNS-rebinding page is same-origin with itself (its Origin and Host are both
 * the attacker's name pointed at this machine), so the Origin check alone can't refuse it; the Host has to be ours.
 * server/pty.mjs keeps a copy of this logic. */

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** "Host[:port]" (IPv6 in brackets) as lowercase [name, port]; ["", ""] when it doesn't parse */
function split(value: string): [string, string] {
  const m = /^(\[[0-9a-f:.]+\]|[^:/\s[\]]+)(?::(\d{1,5}))?$/.exec(value.trim().toLowerCase());
  return m ? [m[1].replace(/\.$/, ""), m[2] ?? ""] : ["", ""];
}

/** ALLOWED_HOSTS (comma list, an entry may pin a port) plus PUBLIC_HOSTNAME; null when neither is set (any Host goes) */
export function allowedHosts(env: Record<string, string | undefined> = process.env): [string, string][] | null {
  const raw = [...(env.ALLOWED_HOSTS ?? "").split(","), env.PUBLIC_HOSTNAME ?? ""].map((s) => s.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/.*$/, ""));
  const list = raw.filter(Boolean).map(split).filter(([name]) => name);
  return list.length ? list : null;
}

export function hostAllowed(host: string | null | undefined, allow: [string, string][] | null): boolean {
  if (!allow) return true;
  const [name, port] = split(host ?? "");
  if (!name) return false;
  if (LOOPBACK.has(name)) return true;
  return allow.some(([n, p]) => n === name && (!p || p === port));
}
