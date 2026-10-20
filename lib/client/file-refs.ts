/* File paths written in messages and tool calls ("lib/app.ts:42", "`src/a.ts#L3-L9`", "[a.ts](src/a.ts)") as links
 * into the session's files, and the text that mentions one in the composer. No React, no DOM. */

import { findPathLinks, resolveTerminalPath } from "./terminal-links";
import { rangeText } from "./line-range";

export type FileRef = { path: string; line?: number; endLine?: number };

/* "a.ts:42", "a.ts:42:7" (a column, not kept), "a.ts:12-20", "a.ts#L12", "a.ts#L12-L20" */
const REF = /^(.+?)(?::(\d+)(?:-(\d+))?(?::\d+)?|#L(\d+)(?:-L?(\d+))?)?$/;

/* bare names in inline code only count with an extension like these: `process.env` and `console.log` aren't files */
const KNOWN_EXT = new Set(
  "ts tsx js jsx mjs cjs json jsonc md mdx py rb go rs java kt kts swift c h cc cpp hpp cs php sh bash zsh fish yml yaml toml ini cfg conf css scss sass less html htm vue svelte astro sql graphql gql proto txt csv lock xml svg png jpg jpeg gif webp pdf dart lua scala ex exs erl hs ml clj nix tf gradle mts cts".split(" "),
);

const extOf = (name: string) => /\.([A-Za-z][A-Za-z0-9]*)$/.exec(name)?.[1]?.toLowerCase() ?? null;

function split(text: string): FileRef | null {
  const m = REF.exec(text);
  if (!m) return null;
  const line = m[2] ?? m[4];
  const end = m[3] ?? m[5];
  const ref: FileRef = { path: m[1] };
  if (line) {
    ref.line = Number(line);
    if (end && Number(end) > ref.line) ref.endLine = Number(end);
  }
  return ref.line === 0 ? { path: m[1] } : ref;
}

const nameOf = (p: string) => p.slice(p.replace(/\/+$/, "").lastIndexOf("/") + 1);

/** A link target from markdown (`[x](src/a.ts#L4)`): any path that isn't a web address or an anchor in the page. */
export function refFromHref(href: string | null | undefined): FileRef | null {
  if (!href || href.startsWith("#")) return null;
  let h = href.trim();
  if (/^file:\/\//i.test(h)) h = h.replace(/^file:\/\/[^/]*/i, "");
  else if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return null;
  try {
    h = decodeURI(h);
  } catch {}
  if (!h || /[\n\r\0]/.test(h)) return null;
  const ref = split(h);
  const name = ref ? nameOf(ref.path) : "";
  if (!ref || !name || name === "." || name === ".." || ref.path.endsWith("/")) return null;
  return ref;
}

/** Inline code that names a file: no spaces, and an extension (any, with a folder or a line number; a common one alone). */
export function refFromCode(code: string): FileRef | null {
  const t = code.trim().replace(/^@/, "");
  if (!t || t.length > 300 || !/^[\w.@~+/-]+(?::\d+(?:-\d+)?(?::\d+)?|#L\d+(?:-L?\d+)?)?$/.test(t) || t.includes("://")) return null;
  const ref = split(t);
  if (!ref) return null;
  const name = nameOf(ref.path);
  const ext = extOf(name);
  if (!ext || (name.startsWith(".") && name.indexOf(".", 1) === -1)) return null;
  if (!ref.path.includes("/") && ref.line === undefined && !KNOWN_EXT.has(ext)) return null;
  return ref;
}

export type TextRef = FileRef & { start: number; end: number };

/** Path-looking spans of plain text (a message someone typed): ones with a letter extension, "12-20" ranges kept. */
export function findFileRefs(text: string): TextRef[] {
  const out: TextRef[] = [];
  for (const m of findPathLinks(text)) {
    if (!extOf(nameOf(m.path))) continue;
    let end = m.end;
    let endLine: number | undefined;
    const range = m.line !== undefined && m.col === undefined ? /^-(\d+)/.exec(text.slice(end)) : null;
    if (range && Number(range[1]) > m.line!) {
      endLine = Number(range[1]);
      end += range[0].length;
    }
    out.push({ path: m.path, line: m.line, endLine, start: m.start, end });
  }
  return out;
}

/** An absolute path for a reference, relative ones against the session's folder; null when it can't be placed. */
export const resolveRef = (path: string, root: string | null | undefined) => resolveTerminalPath(path, root, null);

/** What "Mention in message" types: `@path`, `@path:12` or `@path:12-20`, in backticks when the path has spaces. */
export function mentionToken(rel: string, first?: number, last?: number): string {
  const at = first ? `:${rangeText(first, last ?? first)}` : "";
  const token = `@${rel}${at}`;
  return /\s/.test(rel) ? `\`${token}\`` : token;
}

/** "12" or "12-20" for a reference with lines, else "" */
export const refLines = (r: FileRef) => (r.line ? rangeText(r.line, r.endLine ?? r.line) : "");
