"use client";

import { useState, type ReactNode } from "react";
import type { ToolResult } from "@/lib/types";
import type { RunItem } from "@/lib/client/turns";
import { highlight } from "@/lib/client/highlight";
import { cleanResult, hostOf, parsePatch, parseNumbered, parseWebSearch, prettyJson, relativeTo, splitPath } from "@/lib/client/tools";
import { CodeCard, copyText } from "./CodeCard";
import { DiffBlock } from "./DiffBlock";
import { Markdown } from "./Markdown";
import { PathLabel } from "./PathLabel";
import { TodoList } from "./TodoList";

/* What an expanded tool row shows. Loaded on its own (see ToolRun), since rows start collapsed. */

/* Focus rings sit inside the control: rows live in overflow-clipped containers where an outset ring gets cut off. */
const FOCUS_INSET = "focus-visible:[outline-offset:-2px]! focus-visible:rounded-control!";

/* ── detail building blocks ────────────────────────────────── */

const BOX = "rounded-[8px] bg-inset shadow-hairline";
const SCROLL = `overflow-auto overscroll-contain focus-visible:[outline-offset:-2px]!`;
const MONO = "font-mono text-[11.5px] leading-[1.6]";


function Label({ children }: { children: ReactNode }) {
  return <span className="text-2xs font-medium text-ink-3">{children}</span>;
}

/** A capped, scrollable mono block. `wrap` soft-wraps long lines; off, lines scroll sideways (code, paths). */
function Pre({ children, wrap = true, tone = "text-ink-2", max = "max-h-72" }: { children: ReactNode; wrap?: boolean; tone?: string; max?: string }) {
  return (
    <pre
      translate="no"
      tabIndex={0}
      className={`${max} ${SCROLL} ${BOX} px-2.5 py-2 ${MONO} ${tone} ${wrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre"}`}
    >
      {children}
    </pre>
  );
}

const Trimmed = ({ result }: { result: ToolResult }) => (result.truncated ? <span className="font-sans text-ink-3">{"\n"}Output trimmed</span> : null);

function Empty({ result }: { result: ToolResult }) {
  return <p className="text-xs text-ink-3">{result.isError ? "Failed with no output" : "No output"}</p>;
}

function Output({ result, wrap = true, json = false }: { result?: ToolResult; wrap?: boolean; json?: boolean }) {
  if (!result) return null;
  const text = cleanResult(result.text);
  if (!text.trim()) return <Empty result={result} />;
  return (
    <Pre wrap={wrap} tone={result.isError ? "text-red" : "text-ink-2"}>
      {json ? prettyJson(text) : text}
      <Trimmed result={result} />
    </Pre>
  );
}

/** Markdown inside a capped inset box, for results that are prose (subagents, fetched pages, plans). */
function ProseBox({ text, truncated }: { text: string; truncated?: boolean }) {
  return (
    <div tabIndex={0} className={`max-h-80 ${SCROLL} ${BOX} px-3 py-2`}>
      <Markdown text={text} compact />
      {truncated && <p className="mt-2 text-[11.5px] text-ink-3">Output trimmed</p>}
    </div>
  );
}

function ProseOutput({ result, strip }: { result?: ToolResult; strip?: (s: string) => string }) {
  if (!result) return null;
  let text = cleanResult(result.text);
  if (strip) text = strip(text);
  if (!text.trim()) return <Empty result={result} />;
  if (result.isError) return <Output result={{ ...result, text }} />;
  return <ProseBox text={text} truncated={result.truncated} />;
}

/* prose-like files read better soft-wrapped and without code coloring */
const PROSE_FILE = /\.(md|mdx|markdown|txt|rst|log|csv)$/i;

/** Read results: the `cat -n` numbers move into a sticky gutter; code keeps its lines and scrolls sideways. */
function FileOutput({ result, path }: { result?: ToolResult; path: string }) {
  if (!result) return null;
  const text = cleanResult(result.text);
  const rows = result.isError ? null : parseNumbered(text);
  if (!rows) return <Output result={{ ...result, text }} />;
  const prose = PROSE_FILE.test(path);
  const widest = rows.reduce((m, r) => Math.max(m, r.n ?? 0), 0);
  const gutter = `calc(${String(widest).length}ch + 14px)`;
  return (
    <div tabIndex={0} translate="no" className={`max-h-80 ${SCROLL} ${BOX} py-2 ${MONO} text-ink-2`}>
      <div className={prose ? "" : "min-w-fit"}>
        {rows.map((r, i) => (
          <div key={i} className="grid" style={{ gridTemplateColumns: `${gutter} minmax(0,1fr)` }}>
            <span className="sticky left-0 bg-inset pr-2 text-right text-[10.5px] text-ink-3 tabular-nums select-none">{r.n ?? ""}</span>
            <code className={`pr-3 pl-1 ${prose ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre"}`}>{prose ? r.text : highlight(r.text)}</code>
          </div>
        ))}
        {result.truncated && <div className="pt-1 pl-3 font-sans text-ink-3">Output trimmed</div>}
      </div>
    </div>
  );
}

/** A long path that prefers to wrap after slashes. */
function BreakablePath({ path }: { path: string }) {
  const parts = path.split("/");
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>
          {p}
          {i < parts.length - 1 && (
            <>
              /<wbr />
            </>
          )}
        </span>
      ))}
    </>
  );
}

/** One path per line, relative to the search root: the directory truncates first so the file name stays visible. */
function PathLine({ path }: { path: string }) {
  const { dir, base } = splitPath(path);
  return (
    <div className="flex min-w-0" title={path}>
      {dir && <span className="min-w-0 truncate text-ink-3">{dir}</span>}
      <span className="max-w-full shrink-0 truncate text-ink">{base}</span>
    </div>
  );
}

/** `path:12:text` (match) or `path-12-text` (context); the colon form wins so dashed file names parse right. */
function grepLine(line: string): { file: string; n: string; text: string; context: boolean } | null {
  const m = /^(.+?):(\d+):(.*)$/.exec(line);
  if (m) return { file: m[1], n: m[2], text: m[3], context: false };
  const c = /^(.+?)-(\d+)-(.*)$/.exec(line);
  return c ? { file: c[1], n: c[2], text: c[3], context: true } : null;
}

const looksLikePath = (line: string) => /^[^\s:]*\/[^\s:]*$/.test(line) || /^[\w.@-]+\.\w+$/.test(line);

/**
 * Grep / Glob output with the common root removed. File lists get one tidy
 * path per line; `path:line:text` matches wrap, with the location dimmed.
 */
function SearchOutput({ result, root }: { result?: ToolResult; root: string }) {
  if (!result) return null;
  const text = cleanResult(result.text);
  if (!text.trim() || result.isError) return <Output result={{ ...result, text }} />;
  const lines = text.split("\n").map((l) => relativeTo(l, root));
  const note = (l: string) => /^(Found \d+|No files|No matches)/.test(l);
  const paths = lines.every((l) => !l.trim() || note(l) || looksLikePath(l));
  return (
    <div tabIndex={0} translate="no" className={`max-h-72 ${SCROLL} ${BOX} px-2.5 py-2 ${MONO} text-ink-2`}>
      {lines.map((line, i) => {
        if (note(line)) return <div key={i} className="font-sans text-ink-3">{line}</div>;
        if (paths) return line.trim() ? <PathLine key={i} path={line} /> : null;
        /* ripgrep-style headings: the file once, then its matching lines under it */
        const match = grepLine(line);
        if (!match) {
          if (line === "--") return <div key={i} className="h-1.5" />;
          return (
            <div key={i} className="whitespace-pre-wrap [overflow-wrap:anywhere]">
              {line || " "}
            </div>
          );
        }
        const prev = i > 0 ? grepLine(lines[i - 1])?.file : undefined;
        return (
          <div key={i} className={prev === match.file ? "" : "mt-1.5 first:mt-0"}>
            {prev !== match.file && <PathLine path={match.file} />}
            <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
              <span className="min-w-[3ch] text-right text-ink-3 tabular-nums select-none">{match.n}</span>
              <span className={`whitespace-pre-wrap [overflow-wrap:anywhere] ${match.context ? "text-ink-3" : ""}`}>{match.text}</span>
            </div>
          </div>
        );
      })}
      {result.truncated && <div className="pt-1 font-sans text-ink-3">Output trimmed</div>}
    </div>
  );
}

function SearchLinks({ result }: { result?: ToolResult }) {
  if (!result) return null;
  const text = cleanResult(result.text);
  if (result.isError || !text.trim()) return <Output result={{ ...result, text }} />;
  const { links, rest } = parseWebSearch(text);
  if (!links.length) return <ProseOutput result={{ ...result, text }} />;
  return (
    <>
      <ul className={`max-h-64 ${SCROLL} ${BOX} flex flex-col p-1`}>
        {links.map((l, i) => (
          <li key={i} className="min-w-0">
            <a
              href={l.url}
              target="_blank"
              rel="noreferrer noopener"
              className={`flex min-w-0 items-baseline gap-2 rounded-[6px] px-2 py-1.5 transition-colors duration-100 hover:bg-hover-2 sm:py-1 ${FOCUS_INSET}`}
            >
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">{l.title}</span>
              <span className="max-w-[40%] shrink-0 truncate font-mono text-2xs text-ink-3">{hostOf(l.url)}</span>
            </a>
          </li>
        ))}
      </ul>
      {rest && <ProseBox text={rest} truncated={result.truncated} />}
    </>
  );
}

/** Tool input as a quiet key/value list instead of raw JSON. */
function Params({ input }: { input: Record<string, unknown> }) {
  const entries = Object.entries(input).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (!entries.length) return null;
  return (
    <dl tabIndex={0} className={`max-h-48 ${SCROLL} ${BOX} grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 px-2.5 py-2 ${MONO}`}>
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="max-w-[9rem] truncate text-ink-3" title={k}>
            {k}
          </dt>
          <dd className="min-w-0 whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere]">{typeof v === "string" ? v : JSON.stringify(v, null, typeof v === "object" ? 2 : 0)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Long free text (subagent prompts, questions): sans, capped, scrollable. */
function TextBlock({ text, max = "max-h-40" }: { text: string; max?: string }) {
  return (
    <div tabIndex={0} className={`${max} ${SCROLL} text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere]`}>
      {text}
    </div>
  );
}

const Stack = ({ children }: { children: ReactNode }) => <div className="flex min-w-0 flex-col gap-1.5">{children}</div>;

const PATCH_HATCH = "repeating-linear-gradient(45deg, var(--red) 0, var(--red) 1.5px, transparent 1.5px, transparent 3px)";
const PATCH_OP: Record<"update" | "add" | "delete", string> = { update: "", add: "added", delete: "deleted" };

/** Codex / OpenCode apply_patch envelopes: one DiffBlock-style card per file, rows tinted like DiffBlock. */
function PatchView({ patch }: { patch: string }) {
  const files = parsePatch(patch);
  if (!files.length) return <Pre wrap={false}>{patch || "Empty patch"}</Pre>;
  return (
    <>
      {files.map((f, i) => (
        <div key={i} className="diff-tone w-full overflow-hidden rounded-card bg-surface shadow-card">
          <div className="flex h-9 min-w-0 items-center gap-2 border-b border-line px-3 font-mono text-xs">
            <PathLabel path={f.moveTo ?? f.path} className="min-w-0" />
            {f.moveTo && <span className="shrink-0 font-sans text-[11.5px] text-ink-3">moved</span>}
            {PATCH_OP[f.op] && <span className="shrink-0 font-sans text-[11.5px] text-ink-3">{PATCH_OP[f.op]}</span>}
            <span className="ml-auto shrink-0 tabular-nums">
              <span className="text-green">+{f.added}</span> <span className="text-red">-{f.removed}</span>
            </span>
          </div>
          {f.lines.length > 0 && (
            <div tabIndex={0} translate="no" className={`max-h-[26rem] ${SCROLL} py-1.5 font-mono text-xs leading-[1.65] text-ink-2`}>
              <div className="relative min-w-fit">
                {f.lines.map((l, j) =>
                  l.tone === "hunk" ? (
                    l.text ? (
                      <div key={j} className="mt-1 py-0.5 pr-4 pl-4 text-2xs whitespace-pre text-ink-3 first:mt-0">
                        {l.text}
                      </div>
                    ) : (
                      <div key={j} className="mx-4 my-1 border-t border-dashed border-line first:hidden" />
                    )
                  ) : (
                    <div key={j} className={`relative pr-4 pl-4 ${l.tone === "add" ? "bg-green-tint" : l.tone === "del" ? "bg-red-tint" : ""}`}>
                      {l.tone !== "ctx" && <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: l.tone === "add" ? "var(--green)" : PATCH_HATCH }} />}
                      <code className="whitespace-pre">{l.text ? highlight(l.text) : " "}</code>
                    </div>
                  ),
                )}
              </div>
            </div>
          )}
        </div>
      ))}
    </>
  );
}

/* subagent results end with bookkeeping meant for the model, not the reader */
const stripAgentMeta = (s: string) =>
  s
    .replace(/<usage>[\s\S]*?<\/usage>/g, "")
    .split("\n")
    .filter((l) => !/^agentId:/.test(l))
    .join("\n")
    .trim();

export function Detail({ item, result, active }: { item: RunItem; result?: ToolResult; active: boolean }) {
  if (item.kind === "thinking") {
    return item.text.trim() ? (
      <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere]">{item.text}</p>
    ) : (
      <p className="text-xs text-ink-3">Reasoning hidden.</p>
    );
  }
  const input: Record<string, unknown> = item.input ?? {};
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  switch (item.name) {
    case "Edit":
      return (
        <Stack>
          <DiffBlock before={s("old_string")} after={s("new_string")} file={s("file_path")} />
          {result?.isError && <Output result={result} />}
        </Stack>
      );
    case "MultiEdit":
      return (
        <Stack>
          {(Array.isArray(input.edits) ? (input.edits as { old_string?: unknown; new_string?: unknown }[]) : []).map((e, i) => (
            <DiffBlock
              key={i}
              before={typeof e?.old_string === "string" ? e.old_string : ""}
              after={typeof e?.new_string === "string" ? e.new_string : ""}
              file={i === 0 ? s("file_path") : undefined}
            />
          ))}
          {result?.isError && <Output result={result} />}
        </Stack>
      );
    case "Write":
      return (
        <Stack>
          <CodeCard code={s("content")} label={s("file_path")} collapsible />
          {result?.isError && <Output result={result} />}
        </Stack>
      );
    case "ApplyPatch":
    case "apply_patch":
      return (
        <Stack>
          <PatchView patch={s("patch")} />
          {result?.isError && <Output result={result} />}
        </Stack>
      );
    case "TodoWrite":
      return <TodoList todos={Array.isArray(input.todos) ? input.todos.filter((t) => t && typeof t === "object") : []} live={active} />;
    case "Bash":
      return (
        <Stack>
          <Pre tone="text-ink" max="max-h-40">
            <span className="text-ink-3 select-none">$ </span>
            {s("command")}
          </Pre>
          <Output result={result} />
        </Stack>
      );
    case "Read":
    case "NotebookRead":
      return (
        <Stack>
          {typeof input.offset === "number" || typeof input.limit === "number" ? (
            <span className="text-xs text-ink-3">
              From line {typeof input.offset === "number" ? input.offset : 1}
              {typeof input.limit === "number" ? `, ${input.limit} lines` : ""}
            </span>
          ) : null}
          <FileOutput result={result} path={s("file_path") || s("notebook_path")} />
        </Stack>
      );
    case "Grep":
    case "Glob": {
      const root = s("path");
      return (
        <Stack>
          <span className={`${MONO} min-w-0 text-ink-3 [overflow-wrap:anywhere]`}>
            <span className="text-ink-2">{s("pattern")}</span>
            {root && <span className="font-sans"> in </span>}
            {root && <BreakablePath path={root} />}
            {s("glob") && <span className="font-sans"> matching </span>}
            {s("glob")}
          </span>
          <SearchOutput result={result} root={root} />
        </Stack>
      );
    }
    case "WebSearch":
      return (
        <Stack>
          <span className="text-[12.5px] text-ink-2 [overflow-wrap:anywhere]">{s("query")}</span>
          <SearchLinks result={result} />
        </Stack>
      );
    case "WebFetch":
      return (
        <Stack>
          <a href={s("url")} target="_blank" rel="noreferrer noopener" className={`${MONO} break-all text-accent-ink underline decoration-accent-ink/30 underline-offset-2 hover:decoration-current`}>
            {s("url")}
          </a>
          {s("prompt") && <TextBlock text={s("prompt")} max="max-h-24" />}
          <ProseOutput result={result} />
        </Stack>
      );
    case "Task":
    case "Agent":
      return (
        <Stack>
          {s("prompt") && (
            <>
              <Label>Prompt</Label>
              <TextBlock text={s("prompt")} />
            </>
          )}
          {result && <Label>Result</Label>}
          <ProseOutput result={result} strip={stripAgentMeta} />
        </Stack>
      );
    case "Skill":
      return (
        <Stack>
          {(s("args") || s("command")) && <TextBlock text={s("args") || s("command")} max="max-h-24" />}
          <Output result={result} />
        </Stack>
      );
    case "ExitPlanMode":
      return (
        <Stack>
          {s("plan") && <ProseBox text={s("plan")} />}
          {s("plan") && <PlanActions plan={s("plan")} />}
          {result && <Output result={result} />}
        </Stack>
      );
    case "AskUserQuestion": {
      const qs = Array.isArray(input.questions) ? (input.questions as { question?: string }[]) : [];
      return (
        <Stack>
          {qs.map((q, i) => typeof q?.question === "string" && q.question && <TextBlock key={i} text={q.question} max="max-h-24" />)}
          <Output result={result} />
        </Stack>
      );
    }
    default:
      return (
        <Stack>
          <Params input={input} />
          <Output result={result} json />
        </Stack>
      );
  }
}
/** Copy or save a proposed plan as Markdown. */
function PlanActions({ plan }: { plan: string }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  const btn = "tap relative h-7 rounded-[7px] px-2.5 text-xs font-medium text-ink-2 shadow-btn hover:bg-hover hover:text-ink";
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        className={btn}
        onClick={() =>
          void copyText(plan)
            .catch(() => false)
            .then((ok) => {
              setCopied(ok);
              setTimeout(() => setCopied(null), 1500);
            })
        }
      >
        {copied ? "Copied" : copied === false ? "Couldn't copy" : "Copy plan"}
      </button>
      <button
        type="button"
        className={btn}
        onClick={() => {
          const url = URL.createObjectURL(new Blob([plan], { type: "text/markdown" }));
          const a = document.createElement("a");
          a.href = url;
          a.download = "plan.md";
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }}
      >
        Download .md
      </button>
    </div>
  );
}
