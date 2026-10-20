/* Sharing to agent-u from another app (the manifest's share_target): the server keeps the files as attachments and
 * sends the browser to a new session with `?share=<id>`, whose composer then starts with the text and files. */

export const SHARE_PARAM = "share";
/** the redirect's marker for a share too large to take */
export const SHARE_TOO_BIG = "big";
export const SHARE_ID = /^[a-f0-9]{24}$/;

export type SharedFile = { name: string; size: number; path: string };
export type Shared = { text: string; files: SharedFile[] };

/** What `?share=` asks for: a stored share's id, the too-large note, or nothing usable. */
export function parseShareParam(search: string): { id: string } | { error: "big" } | null {
  const v = new URLSearchParams(search).get(SHARE_PARAM);
  if (!v) return null;
  if (v === SHARE_TOO_BIG) return { error: "big" };
  return SHARE_ID.test(v) ? { id: v } : null;
}

/** One message from the title, text and url an app shares. Apps repeat themselves (the url inside the text, the title
 * as the text), so each part only goes in when it isn't there already. */
export function sharedText(parts: { title?: string | null; text?: string | null; url?: string | null }, max = 20_000): string {
  const clean = (s: string | null | undefined) => (s ?? "").replace(/\r\n?/g, "\n").trim();
  const title = clean(parts.title);
  const text = clean(parts.text);
  const url = clean(parts.url);
  const out: string[] = [];
  if (title && !text.includes(title) && !(url && title === url)) out.push(title);
  if (text) out.push(text);
  if (url && !text.includes(url)) out.push(url);
  return out.join("\n\n").slice(0, max);
}
