import type { ReactNode } from "react";

/* Light syntax coloring lifted from Beautiful UI's CodeBlock: keywords,
 * function calls, strings and numbers. Deliberately small; it's a hint, not a parser. */

const KEYWORDS = new Set([
  "import", "from", "export", "default", "async", "function", "const", "let", "var", "await", "return", "if", "else",
  "for", "while", "new", "throw", "try", "catch", "null", "true", "false", "undefined", "def", "class", "self", "None",
  "True", "False", "fn", "pub", "use", "struct", "impl", "match", "elif", "in", "not", "and", "or", "type", "interface",
]);
const TOKEN =
  /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`|#.*$|\/\/.*$|\b\d+(?:\.\d+)?\b|\b(?:import|from|export|default|async|function|const|let|var|await|return|if|else|for|while|new|throw|try|catch|null|true|false|undefined|def|class|self|None|True|False|fn|pub|use|struct|impl|match|elif|in|not|and|or|type|interface)\b|[A-Za-z_$][\w$]*(?=\s*\())/g;

/** prose and data files read better uncoloured ("for", "and", "from" aren't keywords there) */
export const isPlainText = (name?: string) => !!name && (/\.(txt|log|csv|tsv|rst|md|mdx|markdown)$/i.test(name) || /^(text|txt|plain|plaintext|log|markdown|md)$/i.test(name));

/* strings and numbers use --orange-ink: plain --orange is under 3:1 on a light surface */
const COMMENT = "text-ink-3 italic";
const LITERAL = "text-orange-ink";
const KEYWORD = "text-accent-ink";
const CALL = "font-medium text-ink";

/** One line of code as text runs and colored spans (only tokens get an element). */
export function highlight(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(TOKEN)) {
    const idx = m.index ?? 0;
    const t = m[0];
    if (idx > last) nodes.push(text.slice(last, idx));
    const cls = t.startsWith("#") || t.startsWith("//") ? COMMENT : /^["'`\d]/.test(t) ? LITERAL : KEYWORDS.has(t) ? KEYWORD : CALL;
    nodes.push(
      <span key={k++} className={cls}>
        {t}
      </span>,
    );
    last = idx + t.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
