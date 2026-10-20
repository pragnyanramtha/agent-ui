export type DiffLine = { tone: "add" | "del" | "ctx"; text: string; old: number | null; cur: number | null };

/* The same edit is diffed for the Changes counts, the Changes panel and the thread; keyed by the strings
 * themselves (their hashes are cached), dropped wholesale once it holds this many. */
const DIFF_CACHE_MAX = 500;
const diffCache = new Map<number, Map<string, Map<string, DiffLine[]>>>();
let diffCached = 0;

/** Line diff via LCS. Large inputs fall back to "all removed, then all added". Results are shared: don't mutate them. */
export function lineDiff(before: string, after: string, max = 400): DiffLine[] {
  let byBefore = diffCache.get(max);
  const hit = byBefore?.get(before)?.get(after);
  if (hit) return hit;
  const out = computeLineDiff(before, after, max);
  if (diffCached >= DIFF_CACHE_MAX) {
    diffCache.clear();
    diffCached = 0;
    byBefore = undefined;
  }
  if (!byBefore) diffCache.set(max, (byBefore = new Map()));
  let byAfter = byBefore.get(before);
  if (!byAfter) byBefore.set(before, (byAfter = new Map()));
  byAfter.set(after, out);
  diffCached++;
  return out;
}

function computeLineDiff(before: string, after: string, max: number): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  if (a.length > max || b.length > max) {
    return [
      ...a.map((text, i) => ({ tone: "del" as const, text, old: i + 1, cur: null })),
      ...b.map((text, i) => ({ tone: "add" as const, text, old: null, cur: i + 1 })),
    ];
  }
  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) out.push({ tone: "ctx", text: a[i], old: ++i, cur: ++j });
    else if (j < b.length && (i === a.length || dp[i][j + 1] > dp[i + 1][j])) out.push({ tone: "add", text: b[j], old: null, cur: ++j });
    else out.push({ tone: "del", text: a[i], old: ++i, cur: null });
  }
  return out;
}

/** Keeps changed lines plus a little context; long unchanged stretches collapse to a gap marker. */
export function compact(lines: DiffLine[], context = 2): (DiffLine | { gap: number })[] {
  const keep = lines.map((l) => l.tone !== "ctx");
  const near = keep.map((_, i) => keep.slice(Math.max(0, i - context), i + context + 1).some(Boolean));
  const out: (DiffLine | { gap: number })[] = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (near[i]) {
      if (skipped) out.push({ gap: skipped });
      skipped = 0;
      out.push(l);
    } else skipped += 1;
  });
  if (skipped) out.push({ gap: skipped });
  return out;
}

/* ── unified patches (git diff output) ─────────────────── */

export type PatchLine = { type: "add" | "del" | "ctx"; oldNo?: number; newNo?: number; text: string; noEol?: boolean };
export type PatchHunk = { header: string; oldStart: number; newStart: number; lines: PatchLine[] };
export type PatchStatus = "added" | "modified" | "deleted" | "renamed" | "binary";
export type PatchFile = {
  path: string;
  oldPath?: string;
  status: PatchStatus;
  additions: number;
  deletions: number;
  hunks: PatchHunk[];
  truncated?: boolean;
  modeChange?: { from: string; to: string };
  /** no text diff; status still says whether it was added, deleted or renamed */
  binary?: boolean;
};

const ESC: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/** git's C-style quoted path ("a/caf\303\251.txt") back to text */
function unquote(s: string): string {
  if (!s.startsWith('"') || !s.endsWith('"') || s.length < 2) return s;
  const bytes: number[] = [];
  const body = s.slice(1, -1);
  const enc = new TextEncoder();
  for (let i = 0; i < body.length; ) {
    /* plain stretches are encoded whole: one UTF-16 unit at a time would split emoji into lone surrogates */
    const at = body.indexOf("\\", i);
    const end = at === -1 ? body.length : at;
    if (end > i) bytes.push(...enc.encode(body.slice(i, end)));
    if (at === -1) break;
    const n = body[at + 1] ?? "";
    if (/[0-7]/.test(n)) {
      const oct = /^[0-7]{1,3}/.exec(body.slice(at + 1))![0];
      bytes.push(parseInt(oct, 8) & 0xff);
      i = at + 1 + oct.length;
    } else {
      bytes.push(ESC[n] ?? n.charCodeAt(0));
      i = at + 2;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** a path from a ---/+++ line or rename header: unquoted, prefix and git's trailing tab (names with spaces) dropped */
function cleanPath(raw: string, prefix: "a/" | "b/" | null): string | null {
  let s = raw.replace(/\t$/, "");
  if (s === "/dev/null") return null;
  s = unquote(s);
  return prefix && s.startsWith(prefix) ? s.slice(2) : s;
}

/** "diff --git a/x b/y": both names, assuming they're the same when unquoted (renames carry their own headers) */
function headerPaths(rest: string): [string, string] | null {
  if (rest.startsWith('"')) {
    const m = /^("(?:\\.|[^"\\])*")\s+(.+)$/.exec(rest);
    if (m) return [cleanPath(m[1], "a/") ?? "", cleanPath(m[2], "b/") ?? ""];
  }
  const p = (rest.length - 5) / 2;
  if (Number.isInteger(p) && rest.startsWith("a/") && rest.slice(2 + p, 5 + p) === " b/" && rest.slice(2, 2 + p) === rest.slice(5 + p)) return [rest.slice(2, 2 + p), rest.slice(5 + p)];
  const at = rest.indexOf(" b/");
  if (at > 0) return [cleanPath(rest.slice(0, at), "a/") ?? "", cleanPath(rest.slice(at + 1), "b/") ?? ""];
  return null;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parses `git diff` output into files, hunks and numbered lines. Unknown lines are skipped, so a cut-off patch still parses. */
export function parseUnifiedPatch(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  const lines = patch.split("\n");
  /* the final newline isn't an empty context line, even when a cut-off hunk still expects more */
  if (lines.at(-1) === "") lines.pop();
  let file: PatchFile | null = null;
  let hunk: PatchHunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let oldNo = 0;
  let newNo = 0;
  let binary = false;
  let added = false;
  let deleted = false;
  let renamed = false;

  const finish = () => {
    if (!file) return;
    file.status = added ? "added" : deleted ? "deleted" : renamed || (file.oldPath && file.oldPath !== file.path) ? "renamed" : binary ? "binary" : "modified";
    if (binary) file.binary = true;
    if (file.oldPath === file.path) delete file.oldPath;
    files.push(file);
    file = null;
    hunk = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const f = file as PatchFile | null;
      const c = line[0];
      if (c === "+" || c === "-" || c === " " || line === "") {
        const text = line.slice(1);
        if (c === "+") {
          hunk.lines.push({ type: "add", newNo: newNo++, text });
          newLeft--;
          if (f) f.additions++;
        } else if (c === "-") {
          hunk.lines.push({ type: "del", oldNo: oldNo++, text });
          oldLeft--;
          if (f) f.deletions++;
        } else {
          hunk.lines.push({ type: "ctx", oldNo: oldNo++, newNo: newNo++, text });
          oldLeft--;
          newLeft--;
        }
        continue;
      }
      if (c !== "\\") hunk = null;
    }
    if (line.startsWith("\\")) {
      const last = (hunk as PatchHunk | null)?.lines.at(-1);
      if (last) last.noEol = true;
      continue;
    }
    if (line.startsWith("diff --git ")) {
      finish();
      const names = headerPaths(line.slice(11));
      file = { path: names?.[1] ?? "", oldPath: names?.[0], status: "modified", additions: 0, deletions: 0, hunks: [] };
      binary = added = deleted = renamed = false;
      continue;
    }
    if (!file) continue;
    const f: PatchFile = file;
    const m = HUNK.exec(line);
    if (m) {
      oldNo = Number(m[1]);
      newNo = Number(m[3]);
      oldLeft = m[2] === undefined ? 1 : Number(m[2]);
      newLeft = m[4] === undefined ? 1 : Number(m[4]);
      hunk = { header: line, oldStart: oldNo, newStart: newNo, lines: [] };
      f.hunks.push(hunk);
    } else if (line.startsWith("--- ")) {
      const p = cleanPath(line.slice(4), "a/");
      if (p === null) added = true;
      else f.oldPath = p;
    } else if (line.startsWith("+++ ")) {
      const p = cleanPath(line.slice(4), "b/");
      if (p === null) {
        deleted = true;
        if (f.oldPath) f.path = f.oldPath;
      } else f.path = p;
    } else if (line.startsWith("new file mode")) added = true;
    else if (line.startsWith("deleted file mode")) deleted = true;
    else if (line.startsWith("rename from ")) {
      f.oldPath = cleanPath(line.slice(12), null) ?? f.oldPath;
      renamed = true;
    } else if (line.startsWith("rename to ")) {
      f.path = cleanPath(line.slice(10), null) ?? f.path;
      renamed = true;
    } else if (line.startsWith("old mode ")) f.modeChange = { from: line.slice(9), to: f.modeChange?.to ?? "" };
    else if (line.startsWith("new mode ")) f.modeChange = { from: f.modeChange?.from ?? "", to: line.slice(9) };
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") binary = true;
  }
  finish();
  return files;
}

export type SplitRow = { left: PatchLine | null; right: PatchLine | null };

/** Side-by-side rows for one hunk: context on both sides, each run of removals paired with the additions after it. */
export function splitRows(lines: PatchLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  for (let i = 0; i < lines.length; ) {
    if (lines[i].type === "ctx") {
      rows.push({ left: lines[i], right: lines[i] });
      i++;
      continue;
    }
    const dels: PatchLine[] = [];
    const adds: PatchLine[] = [];
    while (i < lines.length && lines[i].type === "del") dels.push(lines[i++]);
    while (i < lines.length && lines[i].type === "add") adds.push(lines[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
  }
  return rows;
}
