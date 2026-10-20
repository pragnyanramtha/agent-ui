import { fenceBlock } from "./composer-insert";

/** Selected prose as a Markdown quote: `> ` on every line, blank lines kept as `>` so the quote stays one block. */
export function quoteMarkdown(text: string): string {
  const body = text
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "");
  if (!body.trim()) return "";
  return body
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");
}

/** A code card's label as a fence language: "ts" stays, "src/app.tsx" becomes "tsx", anything else is dropped. */
export function codeLang(label: string | null | undefined): string {
  const l = (label ?? "").trim();
  if (!l) return "";
  const ext = /\.([\w+-]+)$/.exec(l);
  if (l.includes("/") || ext) return ext ? ext[1].toLowerCase() : "";
  return /^[\w+#-]{1,20}$/.test(l) && l !== "text" ? l.toLowerCase() : "";
}

/** What a selection becomes in the composer: a fenced block when it's all inside one code block, else a quote. */
export function selectionBlock(text: string, code?: { lang?: string | null } | null): string {
  if (!text.trim()) return "";
  return code ? fenceBlock(text, codeLang(code.lang)) : quoteMarkdown(text);
}

/** The text to hand the composer so the block ends with a blank line under it (appendToDraft adds one newline). */
export const askText = (block: string) => `${block}\n`;
