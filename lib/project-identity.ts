/* How a project folder looks in the sidebar when it has no favicon of its own: two letters on a tint picked from its
 * name, so the same folder always gets the same mark. No React, no DOM, so the server and tests can use it too. */

/** Theme colors a monogram may take. Each is defined for light and dark (app/globals.css), so it reads in both. */
export const PROJECT_TINTS = ["--accent", "--green", "--orange", "--agent-devin", "--agent-cursor", "--agent-gemini", "--agent-antigravity"] as const;

const words = (name: string) =>
  name
    .normalize("NFKC")
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .match(/[\p{L}\p{N}]+/gu) ?? [];

/** "agent-ui" is AU, "myProject" MP, "workspace" WO, "web3" W3; "" when the name has no letters or digits. */
export function monogram(name: string): string {
  const [head, next] = words(name);
  if (!head) return "";
  const first = Array.from(head);
  const second = next ? Array.from(next)[0] : (first.find((g, i) => i > 0 && /\p{N}/u.test(g)) ?? first[1]);
  return `${first[0]}${second ?? ""}`.toLocaleUpperCase();
}

/** A stable index into PROJECT_TINTS for a name (case and spacing don't matter). */
export function tintIndex(name: string): number {
  const seed = name.normalize("NFKC").trim().toLowerCase() || "project";
  let h = 0;
  for (const ch of seed) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return h % PROJECT_TINTS.length;
}

/** The colors for a monogram: letters mixed toward the text color so they stay legible, on a faint wash of the tint. */
export function monogramColors(name: string): { color: string; background: string } {
  const tint = `var(${PROJECT_TINTS[tintIndex(name)]})`;
  return { color: `color-mix(in oklch, ${tint} 78%, var(--ink))`, background: `color-mix(in oklch, ${tint} 16%, transparent)` };
}

/** Where a repository usually keeps its icon, best first, relative to its folder. */
export const FAVICON_CANDIDATES = [
  "public/favicon.svg",
  "public/favicon.ico",
  "public/favicon.png",
  "app/icon.svg",
  "app/icon.png",
  "app/favicon.ico",
  "src/app/icon.svg",
  "src/app/icon.png",
  "src/app/favicon.ico",
  "static/favicon.svg",
  "static/favicon.ico",
  "static/favicon.png",
  "favicon.svg",
  "favicon.ico",
  "favicon.png",
] as const;
