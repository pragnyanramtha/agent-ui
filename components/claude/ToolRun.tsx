"use client";

import { memo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ChatBubble, EditPencil, Globe, NavArrowDown, Page, Search, Sparks, TaskList, Terminal, Tools } from "iconoir-react";
import type { Entry, ToolResult } from "@/lib/types";
import { highlight } from "@/lib/client/highlight";
import { cleanResult, hostOf, parsePatch, parseNumbered, parseWebSearch, prettyJson, relativeTo, splitPath, summarizeTool, type ToolIcon } from "@/lib/client/tools";
import { CodeCard, copyText } from "./CodeCard";
import { DiffBlock } from "./DiffBlock";
import { Markdown } from "./Markdown";
import { PathLabel } from "./PathLabel";
import { TodoList } from "./TodoList";
import { ENTER, SHIMMER, useOnScreen } from "./motion";

export type RunItem = Extract<Entry, { kind: "tool" | "thinking" }>;

const ICONS: Record<ToolIcon | "think", (p: { width: number; height: number; strokeWidth: number }) => ReactNode> = {
  read: (p) => <Page {...p} />,
  edit: (p) => <EditPencil {...p} />,
  run: (p) => <Terminal {...p} />,
  terminal: (p) => <Terminal {...p} />,
  search: (p) => <Search {...p} />,
  web: (p) => <Globe {...p} />,
  agent: (p) => <Sparks {...p} />,
  plan: (p) => <TaskList {...p} />,
  ask: (p) => <ChatBubble {...p} />,
  tool: (p) => <Tools {...p} />,
  think: (p) => <Sparks {...p} />,
};

const ease = "cubic-bezier(0.23, 1, 0.32, 1)";

/* Focus rings sit inside the control: rows live in overflow-clipped containers where an outset ring gets cut off. */
const FOCUS_INSET = "focus-visible:[outline-offset:-2px]! focus-visible:rounded-control!";

/* continuous animations inherit this play state from the run, which pauses them off screen */
const PLAY = "[animation-play-state:var(--run-play,running)]";

/* ── detail building blocks ────────────────────────────────── */

const BOX = "rounded-[8px] bg-inset shadow-hairline";
const SCROLL = `overflow-auto overscroll-contain focus-visible:[outline-offset:-2px]!`;
const MONO = "font-mono text-[11.5px] leading-[1.6]";

function Collapse({ open, children, className = "" }: { open: boolean; children: ReactNode; className?: string }) {
  return (
    <div
      className={`grid grid-cols-[minmax(0,1fr)] transition-[grid-template-rows,opacity] duration-300 ${className}`}
      style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0, transitionTimingFunction: ease }}
    >
      <div className="min-h-0 min-w-0 overflow-hidden">{open ? children : null}</div>
    </div>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <span className="text-[11px] font-medium text-ink-3">{children}</span>;
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
  return <p className="text-[12px] text-ink-3">{result.isError ? "Failed with no output" : "No output"}</p>;
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
              <span className="max-w-[40%] shrink-0 truncate font-mono text-[11px] text-ink-3">{hostOf(l.url)}</span>
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
        <div key={i} className="w-full overflow-hidden rounded-card bg-surface shadow-card">
          <div className="flex h-9 min-w-0 items-center gap-2 border-b border-line px-3 font-mono text-[12px]">
            <PathLabel path={f.moveTo ?? f.path} className="min-w-0" />
            {f.moveTo && <span className="shrink-0 font-sans text-[11.5px] text-ink-3">moved</span>}
            {PATCH_OP[f.op] && <span className="shrink-0 font-sans text-[11.5px] text-ink-3">{PATCH_OP[f.op]}</span>}
            <span className="ml-auto shrink-0 tabular-nums">
              <span className="text-green">+{f.added}</span> <span className="text-red">-{f.removed}</span>
            </span>
          </div>
          {f.lines.length > 0 && (
            <div tabIndex={0} translate="no" className={`max-h-[26rem] ${SCROLL} py-1.5 font-mono text-[12px] leading-[1.65] text-ink-2`}>
              <div className="relative min-w-fit">
                {f.lines.map((l, j) =>
                  l.tone === "hunk" ? (
                    l.text ? (
                      <div key={j} className="mt-1 py-0.5 pr-4 pl-4 text-[11px] whitespace-pre text-ink-3 first:mt-0">
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

function Detail({ item, result, active }: { item: RunItem; result?: ToolResult; active: boolean }) {
  if (item.kind === "thinking") {
    return item.text.trim() ? (
      <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere]">{item.text}</p>
    ) : (
      <p className="text-[12px] text-ink-3">Reasoning hidden.</p>
    );
  }
  const input = item.input;
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
          {((input.edits as { old_string?: string; new_string?: string }[]) ?? []).map((e, i) => (
            <DiffBlock key={i} before={e.old_string ?? ""} after={e.new_string ?? ""} file={i === 0 ? s("file_path") : undefined} />
          ))}
          {result?.isError && <Output result={result} />}
        </Stack>
      );
    case "Write":
      return (
        <Stack>
          <CodeCard code={s("content")} label={s("file_path")} />
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
      return <TodoList todos={(input.todos as []) ?? []} live={active} />;
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
          <span className={`${MONO} text-ink-3 [overflow-wrap:anywhere]`}>
            <BreakablePath path={s("file_path") || s("notebook_path")} />
            {typeof input.offset === "number" || typeof input.limit === "number" ? (
              <span className="font-sans">
                {"  "}from line {typeof input.offset === "number" ? input.offset : 1}
                {typeof input.limit === "number" ? `, ${input.limit} lines` : ""}
              </span>
            ) : null}
          </span>
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
          {qs.map((q, i) => q.question && <TextBlock key={i} text={q.question} max="max-h-24" />)}
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

const Row = memo(function Row({ item, result, active }: { item: RunItem; result?: ToolResult; active: boolean }) {
  const [open, setOpen] = useState(false);
  const summary = item.kind === "thinking" ? { verb: "Thought", chip: item.text.split("\n")[0], mono: false, icon: "think" as const } : summarizeTool(item.name, item.input);
  const failed = result?.isError;
  const waiting = item.kind === "tool" && !result && active;
  const iconProps = { width: 14, height: 14, strokeWidth: 1.8 };

  return (
    <div style={ENTER}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`group/row -mx-1 flex h-9 w-[calc(100%+8px)] min-w-0 items-center gap-2 rounded-control px-1 text-left transition-colors duration-100 hover:bg-hover-2 sm:h-7 ${FOCUS_INSET}`}
      >
        <span className="relative flex size-4 shrink-0 items-center justify-center text-ink-3">
          <span className={`flex transition-opacity duration-100 group-hover/row:opacity-0 group-focus-visible/row:opacity-0 ${open ? "opacity-0" : ""}`}>{ICONS[summary.icon](iconProps)}</span>
          <span
            className={`absolute flex transition-[opacity,transform] duration-150 group-hover/row:opacity-100 group-focus-visible/row:opacity-100 ${open ? "opacity-100" : "opacity-0"}`}
            style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }}
          >
            <NavArrowDown width={13} height={13} strokeWidth={2.2} />
          </span>
        </span>
        <span className="max-w-[45%] shrink-0 truncate text-[13px] font-medium text-ink sm:text-[12.5px]">{summary.verb}</span>
        {summary.chip && (
          <span className={`inline-flex h-5.5 min-w-0 items-center rounded-chip bg-field px-1.5 text-[11.5px] text-ink-2 shadow-hairline ${summary.mono ? "font-mono" : ""}`}>
            <span className="truncate">{summary.chip}</span>
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center pl-1">
          {waiting && (
            <span
              role="img"
              aria-label="Running"
              className={`size-3 rounded-full border-[1.5px] border-line-strong border-t-ink-2 animate-[spin_700ms_linear_infinite] motion-reduce:animate-none ${PLAY}`}
            />
          )}
          {failed && <span className="text-[11.5px] font-medium text-red">Failed</span>}
        </span>
      </button>
      <Collapse open={open}>
        <div className="mt-0.5 mb-2 ml-[7px] min-w-0 border-l border-line py-1 pl-3.5">
          <Detail item={item} result={result} active={active} />
        </div>
      </Collapse>
    </div>
  );
});

/** Live reasoning while the model thinks: the newest ~3 lines, tap to read it all. */
function LiveThinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 220 || text.split("\n").length > 3;
  return (
    <div style={ENTER}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? "Collapse thinking" : "Expand thinking"}
        onClick={() => setOpen((v) => !v)}
        className={`-mx-1 flex w-[calc(100%+8px)] min-w-0 gap-2 rounded-control px-1 py-1.5 text-left transition-colors duration-100 hover:bg-hover-2 ${FOCUS_INSET}`}
      >
        <span className="flex h-5 w-4 shrink-0 items-center justify-center text-ink-3 sm:h-[18px]">
          <Sparks width={14} height={14} strokeWidth={1.8} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={`w-fit text-[13px] font-medium sm:text-[12.5px] ${SHIMMER} ${PLAY}`}>Thinking…</span>
          {/* collapsed, the box pins to the bottom so the newest reasoning stays in view */}
          <span
            className={`flex flex-col text-[12.5px] leading-[1.6] text-ink-2 ${open ? "" : "max-h-[4.8em] justify-end overflow-hidden"}`}
            style={!open && long ? { maskImage: "linear-gradient(to bottom, transparent, black 1.6em)", WebkitMaskImage: "linear-gradient(to bottom, transparent, black 1.6em)" } : undefined}
          >
            <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</span>
          </span>
        </span>
      </button>
    </div>
  );
}

function headerLabel(items: RunItem[]) {
  const tools = items.filter((i) => i.kind === "tool").length;
  const thoughts = items.length - tools;
  if (!tools) return "Thought";
  const t = `${tools} tool ${tools === 1 ? "call" : "calls"}`;
  return thoughts ? `Thought, ${t}` : t;
}

/**
 * A run of tool calls and thinking between two pieces of prose, styled after Beautiful UI's ToolChips.
 * `results` holds only this run's results so memo skips runs whose results did not change.
 * `thinking` is live reasoning streaming in for the next step.
 */
export const ToolRun = memo(function ToolRun({
  items,
  results,
  active,
  thinking,
}: {
  items: RunItem[];
  results: Record<string, ToolResult>;
  active: boolean;
  thinking?: string;
}) {
  const [manual, setManual] = useState<boolean | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(rootRef, active);
  const open = manual ?? active;
  const last = items[items.length - 1];
  const lastSummary = last?.kind === "tool" ? summarizeTool(last.name, last.input) : null;
  const live = thinking?.trim() ? thinking : undefined;
  /* an open run's live thinking row carries the shimmer itself, so the header stays quiet while it streams */
  const shimmer = active && !(live && open);

  if (!items.length) {
    return (
      <div ref={rootRef} className="w-full min-w-0" style={active && !onScreen ? ({ "--run-play": "paused" } as CSSProperties) : undefined}>
        {live && <LiveThinking text={live} />}
      </div>
    );
  }

  return (
    <div ref={rootRef} className="w-full min-w-0" style={active && !onScreen ? ({ "--run-play": "paused" } as CSSProperties) : undefined}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setManual(!open)}
        className={`-mx-1.5 flex h-8 max-w-[calc(100%+12px)] min-w-0 items-center gap-1.5 rounded-control px-1.5 text-[13px] text-ink-2 transition-colors duration-100 hover:bg-hover-2 sm:h-7 sm:text-[12.5px] ${FOCUS_INSET}`}
      >
        <span className="flex shrink-0 transition-transform duration-200" style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }}>
          <NavArrowDown width={12} height={12} strokeWidth={2.2} />
        </span>
        {shimmer ? (
          <span className={`shrink-0 font-medium ${SHIMMER} ${PLAY}`}>{live || !lastSummary ? "Thinking…" : lastSummary.verb}</span>
        ) : (
          <span className="shrink-0 tabular-nums">{headerLabel(items)}</span>
        )}
        {!open && !live && lastSummary?.chip && (
          <span className={`min-w-0 truncate text-[11.5px] text-ink-3 ${lastSummary.mono ? "font-mono" : ""}`}>{lastSummary.chip}</span>
        )}
      </button>
      {/* the collapse clips overflow; widen it by the rows' hover bleed so their backgrounds and focus rings aren't cut */}
      <Collapse open={open} className="-mx-1">
        <div className="mt-1 flex min-w-0 flex-col gap-0.5 px-1 pb-1">
          {items.map((item) => (
            <Row key={item.id} item={item} result={item.kind === "tool" ? results[item.toolUseId] : undefined} active={active} />
          ))}
          {live && <LiveThinking text={live} />}
        </div>
      </Collapse>
    </div>
  );
});

/** Copy or save a proposed plan as Markdown. */
function PlanActions({ plan }: { plan: string }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  const btn = "tap relative h-7 rounded-[7px] px-2.5 text-[12px] font-medium text-ink-2 shadow-btn hover:bg-hover hover:text-ink";
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
