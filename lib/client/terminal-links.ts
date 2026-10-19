/* File paths in terminal output (src/app.ts:12, ./notes.md, /etc/hosts, ~/x.py:3:7) that open in Files. */

export type PathMatch = { text: string; path: string; line?: number; col?: number; start: number; end: number };

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>]+/gi;
/* rooted (/, ./, ../, ~/) or relative with a slash, or a bare file name followed by :line */
const PATH_RE = /(?:~\/|\.{1,2}\/|\/)[^\s"'`<>()[\]{}|;,]+|[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*(?:\/[A-Za-z0-9._@+-]+)+(?::\d+){0,2}|[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*\.[A-Za-z0-9]+:\d+(?::\d+)?/g;
const TRAILING = /[.,;:!?'"]+$/;
const LOCATION = /^(.*?)(?::(\d+))?(?::(\d+))?$/;

/** Path-looking spans of a line, skipping URLs; only ones that look like files (an extension or a :line) */
export function findPathLinks(text: string): PathMatch[] {
  const urls = [...text.matchAll(URL_RE)].map((m) => [m.index!, m.index! + m[0].length] as const);
  const out: PathMatch[] = [];
  for (const m of text.matchAll(PATH_RE)) {
    const start = m.index!;
    /* the path inside a URL, or a word that runs into one */
    if (start > 0 && /[A-Za-z0-9._~:/-]/.test(text[start - 1])) continue;
    const raw = m[0].replace(TRAILING, "");
    const end = start + raw.length;
    if (urls.some(([a, b]) => start < b && a < end)) continue;
    const loc = LOCATION.exec(raw);
    if (!loc) continue;
    const path = loc[1];
    const line = loc[2] ? Number(loc[2]) : undefined;
    const col = loc[3] ? Number(loc[3]) : undefined;
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (!name || name === "." || name === "..") continue;
    if (line === undefined && !/.\.[A-Za-z0-9]+$/.test(name)) continue;
    out.push({ text: raw, path, line, col, start, end });
  }
  return out;
}

/** An absolute path for `p` as seen from `cwd`; null when it's relative and there's no folder to resolve against */
export function resolveTerminalPath(p: string, cwd: string | null | undefined, home: string | null | undefined): string | null {
  let abs: string;
  if (p.startsWith("/")) abs = p;
  else if (p.startsWith("~/")) {
    if (!home) return null;
    abs = `${home.replace(/\/+$/, "")}/${p.slice(2)}`;
  } else {
    if (!cwd || !cwd.startsWith("/")) return null;
    abs = `${cwd.replace(/\/+$/, "")}/${p}`;
  }
  const parts: string[] = [];
  for (const seg of abs.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return `/${parts.join("/")}`;
}
