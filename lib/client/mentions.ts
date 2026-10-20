/* The composer's @ file picker: finding the "@query" being typed and putting a path in its place. */

/** The @ token around the caret (typed at the start or after whitespace), or null. `end` covers the rest of the word. */
export function mentionAt(text: string, caret: number): { start: number; end: number; query: string } | null {
  const m = /(?:^|\s)@([^\s@`]*)$/.exec(text.slice(0, caret));
  if (!m) return null;
  const start = caret - m[1].length - 1;
  const rest = /^[^\s@`]*/.exec(text.slice(caret))?.[0] ?? "";
  return { start, end: caret + rest.length, query: m[1] + rest };
}

/** Replaces text[start, end) with the path (in backticks when it has spaces) and one space after it. */
export function insertMention(text: string, start: number, end: number, rel: string): { text: string; caret: number } {
  const token = /\s/.test(rel) ? `\`${rel}\`` : rel;
  const after = text.slice(end);
  const glue = /^\s/.test(after) ? "" : " ";
  return { text: `${text.slice(0, start)}${token}${glue}${after}`, caret: start + token.length + 1 };
}
