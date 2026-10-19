import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/* Copy rules for anything a person reads (AGENTS.md): no em dashes, loading labels end with an ellipsis character,
 * and none of the plumbing words (tmux, zellij, pty, SSE, JSON-RPC, adapter, bridge). Strings are found through the
 * TypeScript AST, so comments, class names, imports and console output don't count. */

const ROOT = path.resolve(__dirname, "..");
const DIRS = ["app", "components", "lib"];

/** JSX attributes people read or hear */
const UI_ATTRS = new Set(["aria-label", "aria-description", "aria-roledescription", "aria-valuetext", "title", "placeholder", "alt", "label", "note", "hint", "description", "tip", "data-tip", "collapseLabel", "empty", "detail", "summary"]);
/** object keys whose string values end up on screen (toasts, settings, errors, menu items) */
const UI_KEYS = new Set(["title", "body", "label", "description", "note", "hint", "error", "message", "placeholder", "tip", "summary", "empty", "detail", "reason", "fixed", "text", "why"]);
/** calls whose string arguments end up on screen */
const UI_CALLS = new Set(["toast", "setError", "setNotice", "setReason", "setWarn", "setMsg", "setMessage", "setStatus", "setNote", "flash", "say", "fail", "alert", "confirm", "Error", "ApiError", "TypeError", "json"]);

export type Found = { file: string; line: number; text: string };

export function uiStrings(file: string): Found[] {
  const src = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Found[] = [];
  const rel = path.relative(ROOT, file);
  const add = (node: ts.Node, text: string) => {
    if (/[A-Za-z]/.test(text)) out.push({ file: rel, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text });
  };
  const calleeName = (call: ts.CallExpression | ts.NewExpression) => {
    const e = call.expression;
    if (ts.isIdentifier(e)) return e.text;
    if (ts.isPropertyAccessExpression(e)) return `${ts.isIdentifier(e.expression) ? `${e.expression.text}.` : ""}${e.name.text}`;
    return "";
  };
  /** whether a literal sits where a person reads it */
  const isUi = (node: ts.Node): boolean => {
    for (let n: ts.Node = node, p = node.parent; p; n = p, p = p.parent) {
      /* types, comparisons and switch cases hold values, not copy */
      if (ts.isTypeNode(p)) return false;
      if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(p.operatorToken.kind)) return false;
      if (ts.isCaseClause(p) && p.expression === n) return false;
      if (ts.isJsxAttribute(p)) {
        const name = p.name.getText(sf);
        return UI_ATTRS.has(name);
      }
      if (ts.isJsxExpression(p) && (ts.isJsxElement(p.parent) || ts.isJsxFragment(p.parent))) return true;
      if (ts.isPropertyAssignment(p) && p.initializer === n) {
        const key = p.name.getText(sf).replace(/^["']|["']$/g, "");
        if (UI_KEYS.has(key)) return true;
        if (key === "className" || key === "key" || key === "id") return false;
      }
      if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
        const name = calleeName(p);
        if (name.startsWith("console.")) return false;
        const last = name.split(".").pop()!;
        if (p.arguments?.some((a) => a === n)) return UI_CALLS.has(last);
      }
      if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) return false;
      if (ts.isBlock(p) || ts.isSourceFile(p)) return false;
    }
    return false;
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      const t = node.getText(sf).replace(/\s+/g, " ").trim();
      if (t) add(node, t);
    } else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && isUi(node)) add(node, node.text);
    else if (ts.isTemplateExpression(node) && isUi(node)) add(node, [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join("{}"));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

export const allUiStrings = () => DIRS.flatMap((d) => files(path.join(ROOT, d))).flatMap(uiStrings);

const BANNED = /\b(tmux|zellij|pty|JSON-RPC|adapters?|bridge)\b|\bSSE\b/i;
const LOADING = /^(Loading|Connecting|Reconnecting|Saving|Starting|Sending|Checking|Fetching|Opening|Deleting|Uploading|Searching|Stopping|Pushing|Pulling|Committing|Generating|Installing|Restarting|Waiting for|Reading|Preparing|Signing|Applying|Creating|Importing|Exporting|Moving|Renaming|Copying|Cloning)\b/;

/** Where a plumbing word is the right word: install hints, the health check's names for what it found, CLI flags. */
const ALLOW: { file: string; text: RegExp; why: string }[] = [
  { file: "components/claude/AgentsScreen.tsx", text: /^Install tmux so /, why: "install hint: the fix is installing that package" },
  { file: "lib/server/doctor.ts", text: /^Persistent terminals \((tmux|zellij)\)$/, why: "the health check names the tool it looked for, in parentheses" },
  { file: "lib/server/doctor.ts", text: /^Optional when tmux is installed\.$/, why: "the health check explaining the row above" },
];

const allowed = (f: Found) => ALLOW.some((a) => f.file === a.file && a.text.test(f.text));
const show = (list: Found[]) => list.map((f) => `${f.file}:${f.line}  ${JSON.stringify(f.text)}`);

describe("UI copy", () => {
  const found = allUiStrings();

  it("finds the strings people read", () => {
    expect(found.length).toBeGreaterThan(500);
    expect(found.some((f) => f.file === "components/claude/SessionList.tsx" && f.text === "New session")).toBe(true);
    expect(found.some((f) => f.text === "Session archived")).toBe(true);
  });

  it("reads copy from JSX, labels, toasts and errors, and skips code", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ui-copy-")), "Sample.tsx");
    fs.writeFileSync(
      file,
      [
        'import { x } from "tmux bridge";',
        "// the pty bridge \u2014 not copy",
        'export function A({ on }: { on: "tmux" | "pty" }) {',
        '  console.warn("pty bridge down");',
        '  if (on === "tmux") toast({ title: "Saved \u2014 done", body: `Uses ${on} pty` });',
        '  return <p className="pty" aria-label="Open the tmux pane">Loading...{on ? "Restarting zellij" : null}</p>;',
        "}",
      ].join("\n"),
    );
    expect(uiStrings(file).map((f) => f.text)).toEqual(["Saved \u2014 done", "Uses {} pty", "Open the tmux pane", "Loading...", "Restarting zellij"]);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("has no em dashes", () => {
    expect(show(found.filter((f) => f.text.includes("\u2014")))).toEqual([]);
  });

  it("doesn't name the plumbing", () => {
    expect(show(found.filter((f) => BANNED.test(f.text) && !allowed(f)))).toEqual([]);
  });

  it("ends loading labels with an ellipsis character", () => {
    const bad = found.filter((f) => f.text.includes("...") || (LOADING.test(f.text) && f.text.length < 40 && !/[.!?:\u2026]/.test(f.text) && !/\{\}$/.test(f.text)));
    expect(show(bad)).toEqual([]);
  });

  it("keeps the allowlist honest", () => {
    const unused = ALLOW.filter((a) => !found.some((f) => f.file === a.file && a.text.test(f.text)));
    expect(unused.map((a) => `${a.file} ${a.text}`)).toEqual([]);
  });
});
