"use client";

import { memo, useEffect, useId, useMemo, useRef, useState, type ComponentProps, type ElementType, type JSX } from "react";
import { Check, Copy } from "iconoir-react";
import type { Components, ExtraProps, MathPlugin, PluginConfig, StreamdownProps } from "streamdown";
import { CodeCard, COLLAPSE_LINES, copyText } from "./CodeCard";
import { useOverflow } from "@/lib/client/a11y";

/* ── Streamdown loads as its own chunk ──────────────────────────────────
 * It brings marked, remend, unified and sanitize (the browser build swaps the unused
 * rehype-raw for a stub, see next.config.ts). Fetching starts once the page is idle, or
 * when a session opens (preloadMarkdown), in parallel with its history fetch, so it is
 * normally ready before any message renders. */
/* An image in agent output is a request to whatever host the text names, and the URL can carry anything the
 * agent read; it loads only when asked. */
function RemoteImage({ src, alt }: { src: string; alt: string }) {
  const [shown, setShown] = useState(false);
  let host = "";
  try {
    host = new URL(src, location.href).host;
  } catch {}
  if (shown) return <img src={src} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" className="md-img" />;
  return (
    <button type="button" onClick={() => setShown(true)} title={src} className="my-1 inline-flex max-w-full items-center gap-1.5 rounded-[8px] border border-line px-2.5 py-1.5 text-left text-sm text-ink-2 hover:bg-hover">
      <span className="truncate">{alt ? `Image: ${alt}` : "Image"}</span>
      {host && <span className="shrink-0 text-ink-3">from {host}. Load</span>}
    </button>
  );
}

type SD = typeof import("streamdown");
let sd: SD | null = null;
let sdLoad: Promise<SD> | null = null;
const loadStreamdown = () => (sdLoad ??= import("streamdown").then((m) => (sd = m)));
/** Starts fetching the markdown renderer (once); call when a screen that shows messages opens. */
export const preloadMarkdown = () => void loadStreamdown().catch(() => (sdLoad = null));
if (typeof window !== "undefined") {
  if (typeof requestIdleCallback === "function") requestIdleCallback(preloadMarkdown, { timeout: 4000 });
  else setTimeout(preloadMarkdown, 1500);
}

/* ── hast helpers (local types; hast isn't a direct dependency) ───────── */

type HNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HNode[] };

const textOf = (n: HNode): string => (n.type === "text" ? (n.value ?? "") : (n.children ?? []).map(textOf).join(""));
const elements = (n: HNode, tag: string): HNode[] =>
  (n.children ?? []).flatMap((c) => (c.type !== "element" ? [] : c.tagName === tag ? [c] : tag === "tr" && c.tagName === "table" ? [] : elements(c, tag)));

/* A body cell reads as a number: counts, sizes, durations, money, percentages.
 * Versions ("1.2.3") and dates don't match, so those columns stay left-aligned. */
const NUMERIC = /^[~≈<>≤≥±+\-−]?\s?[$€£¥]?\s?\d[\d,_\u202f]*(\.\d+)?(e[+-]?\d+)?\s?(%|[kKMGTB]|[kKMGT]i?B|bytes?|ms|µs|us|ns|s|sec|min|h|x|×|pp|tok\/s|tokens?)?$/;
const BLANK = /^(|-|–|—|n\/a|na|none|\?)$/i;
const SHORT_CELL = 22;

/** Rehype pass that marks numeric table columns (`data-num`, right-aligned) and short ones (`data-short`, no wrap). Runs after sanitize. */
function rehypeNumericColumns() {
  const walk = (node: HNode) => {
    if (node.type === "element" && node.tagName === "table") {
      const rows = elements(node, "tr").map((tr) => (tr.children ?? []).filter((c) => c.type === "element" && (c.tagName === "td" || c.tagName === "th")));
      const body = rows.filter((r) => r.some((c) => c.tagName === "td"));
      const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
      for (let col = 0; col < width; col++) {
        const texts = rows.map((r) => (r[col] ? textOf(r[col]).trim() : ""));
        const vals = body.map((r) => (r[col] ? textOf(r[col]).trim() : "")).filter((v) => !BLANK.test(v));
        const numeric = vals.length > 0 && vals.every((v) => NUMERIC.test(v));
        /* short columns (ids, names, dates) stay on one line; prose columns take the wrapping */
        const short = texts.reduce((m, t) => Math.max(m, t.length), 0) <= SHORT_CELL;
        for (const r of rows) {
          const p = r[col]?.properties;
          if (!p) continue;
          /* an explicit GFM alignment (`---:`) wins */
          if (numeric && !p.align) p.dataNum = "";
          if (short) p.dataShort = "";
        }
      }
      return;
    }
    node.children?.forEach(walk);
  };
  return (tree: HNode) => walk(tree);
}

/* Streamdown's defaults are raw + sanitize + harden. Without `rehype-raw`, Streamdown
 * turns HTML in the markdown into plain text, so untrusted transcripts can never inject
 * markup. Sanitize (GitHub's schema: http/https/mailto/tel links, http/https images)
 * still runs on everything markdown produces. Harden is dropped: with Streamdown's
 * wildcard config its only effect is replacing relative links with "[blocked]". */
let rehype: StreamdownProps["rehypePlugins"];
const rehypeFor = (m: SD) => (rehype ??= [m.defaultRehypePlugins.sanitize, rehypeNumericColumns as never]);

/* Links Claude writes to repo files (`[runner.ts](lib/server/runner.ts)`) have nowhere to go in the browser */
const EXTERNAL = /^(https?:|mailto:|tel:)/i;

/* ── math: KaTeX loads only when a message contains `$$` or a ```math fence ── */

const MATH_HINT = /\$\$|```math/;
let mathPlugins: PluginConfig | null = null;
let mathLoad: Promise<PluginConfig> | null = null;

function loadMath() {
  mathLoad ??= import("@streamdown/math").then(({ createMathPlugin }) => {
    const base = createMathPlugin({ errorColor: "var(--ink-3)" });
    const [katex, opts] = base.rehypePlugin as unknown as [unknown, Record<string, unknown>];
    /* MathML output renders natively in current browsers, so no KaTeX stylesheet or fonts ship */
    const math: MathPlugin = { ...base, rehypePlugin: [katex, { ...opts, output: "mathml", strict: false }] as MathPlugin["rehypePlugin"] };
    return (mathPlugins = { math });
  });
  return mathLoad;
}

function useMathPlugins(text: string) {
  const wanted = MATH_HINT.test(text);
  const [plugins, setPlugins] = useState(mathPlugins);
  useEffect(() => {
    if (!wanted || plugins) return;
    let live = true;
    loadMath().then((p) => live && setPlugins(p), () => {});
    return () => {
      live = false;
    };
  }, [wanted, plugins]);
  return wanted ? (plugins ?? undefined) : undefined;
}

/* ── tables ─────────────────────────────────────────────────────────── */

function CopyTableButton({ label, title, onCopy }: { label: string; title: string; onCopy: () => Promise<boolean> }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      title={title}
      aria-label={done ? "Copied" : `Copy table as ${label}`}
      onClick={() =>
        onCopy().then((ok) => {
          if (!ok) return;
          setDone(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setDone(false), 1500);
        })
      }
      className={`flex h-6 items-center gap-1 rounded-[6px] px-1.5 text-xs font-medium transition-colors duration-100 hover:bg-hover pointer-coarse:h-10 pointer-coarse:min-w-11 pointer-coarse:justify-center pointer-coarse:px-3 pointer-coarse:text-sm ${done ? "text-green" : "text-ink-3 hover:text-ink"}`}
    >
      {done ? <Check width={12} height={12} strokeWidth={2.2} /> : <Copy width={12} height={12} strokeWidth={1.8} />}
      {label}
    </button>
  );
}

function Table({ children }: ComponentProps<"table"> & ExtraProps) {
  const ref = useRef<HTMLTableElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const scrolls = useOverflow(scroller, "both");
  const copy = (format: "md" | "csv") => () => {
    /* tables only render inside Streamdown, so the module is loaded by now */
    if (!ref.current || !sd) return Promise.resolve(false);
    const data = sd.extractTableDataFromElement(ref.current);
    return copyText(format === "md" ? sd.tableDataToMarkdown(data) : sd.tableDataToCSV(data, ","));
  };
  return (
    <div className="md-table group/table relative">
      <div
        ref={scroller}
        tabIndex={scrolls ? 0 : undefined}
        role={scrolls ? "group" : undefined}
        aria-label={scrolls ? "Scrollable table" : undefined}
        className="md-table-scroll focus-visible:[outline-offset:-2px]!"
      >
        <table ref={ref}>{children}</table>
      </div>
      {/* on touch there's no hover, so the controls stay visible in a strip under the table */}
      <div className="absolute top-1 right-1 z-10 flex gap-px rounded-[8px] bg-surface p-0.5 opacity-0 shadow-btn transition-opacity duration-150 group-focus-within/table:opacity-100 group-hover/table:opacity-100 pointer-coarse:static pointer-coarse:justify-end pointer-coarse:rounded-none pointer-coarse:border-t pointer-coarse:border-line pointer-coarse:p-0 pointer-coarse:opacity-100 pointer-coarse:shadow-none">
        <CopyTableButton label="MD" title="Copy table as Markdown" onCopy={copy("md")} />
        <CopyTableButton label="CSV" title="Copy table as CSV" onCopy={copy("csv")} />
      </div>
    </div>
  );
}

/* ── element map ────────────────────────────────────────────────────── */

/* Plain elements for everything Streamdown would otherwise style with shadcn
 * tokens; `.prose-claude` in globals.css owns the look. */
const plain = <T extends keyof JSX.IntrinsicElements>(Tag: T) =>
  function Plain({ node: _node, ...props }: JSX.IntrinsicElements[T] & ExtraProps) {
    const El = Tag as ElementType;
    return <El {...props} />;
  };

const components: Components = {
  p: plain("p"),
  h1: plain("h1"),
  h2: plain("h2"),
  h3: plain("h3"),
  h4: plain("h4"),
  h5: plain("h5"),
  h6: plain("h6"),
  ul: plain("ul"),
  ol: plain("ol"),
  li: plain("li"),
  hr: plain("hr"),
  strong: plain("strong"),
  blockquote: plain("blockquote"),
  sup: plain("sup"),
  sub: plain("sub"),
  section: plain("section"),
  thead: plain("thead"),
  tbody: plain("tbody"),
  tr: plain("tr"),
  th: plain("th"),
  td: plain("td"),
  table: Table,
  /* Streamdown's own `pre` stays: it renders no wrapper, it only tags the fenced
   * `code` child with `data-block`, which routes it to `code` instead of `inlineCode` */
  inlineCode: ({ children }) => <code className="md-code">{children}</code>,
  code: ({ className, children }) => {
    const lang = /language-([\w+#.-]+)/.exec(className ?? "")?.[1];
    return <CodeCard code={String(children ?? "")} label={lang} collapseAfter={COLLAPSE_LINES} />;
  },
  a: ({ node: _node, href, children, className, ...rest }) =>
    href?.startsWith("#") ? (
      /* footnote refs and backrefs jump within the page */
      <a href={href} className={className} {...rest}>
        {children}
      </a>
    ) : href && EXTERNAL.test(href) ? (
      <a href={href} className={className} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span className="md-deadlink" title={href || undefined}>
        {children}
      </span>
    ),
  img: ({ src, alt }) => (typeof src === "string" && src ? <RemoteImage src={src} alt={alt ?? ""} /> : null),
};

/* our `a` decides what's a link; Streamdown's confirm-before-open modal stays off */
const LINK_SAFETY_OFF = { enabled: false };

function useStreamdown() {
  const [mod, setMod] = useState(sd);
  useEffect(() => {
    if (mod) return;
    let live = true;
    loadStreamdown().then(
      (m) => live && setMod(m),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [mod]);
  return mod;
}

/**
 * Assistant prose, rendered with Streamdown so half-streamed markdown (open fences,
 * unclosed emphasis, partial tables) still renders cleanly. Raw HTML in the transcript is
 * shown as text, never rendered. `compact` is the denser size used inside tool details;
 * `streaming` marks text that is still arriving (block-level memo, incomplete-syntax repair, caret).
 */
export const Markdown = memo(function Markdown({ text, compact, streaming }: { text: string; compact?: boolean; streaming?: boolean }) {
  const plugins = useMathPlugins(text);
  /* footnote ids get a per-message prefix so two messages' `[^1]` don't collide;
   * only when footnotes appear, since a custom option means a separate parser instance */
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const hasFootnotes = text.includes("[^");
  const remarkRehypeOptions = useMemo(() => (hasFootnotes ? { clobberPrefix: `fn${uid}-` } : undefined), [hasFootnotes, uid]);
  const mod = useStreamdown();
  const className = `prose-claude min-w-0 space-y-0 ${compact ? "is-compact" : ""} ${streaming ? "is-streaming" : ""}`;
  /* first paint before the chunk lands (rare): the raw text, never blank */
  if (!mod)
    return (
      <div className={className}>
        <p className="whitespace-pre-wrap">{text}</p>
      </div>
    );
  const { Streamdown } = mod;
  return (
    <Streamdown
      mode={streaming ? "streaming" : "static"}
      isAnimating={!!streaming}
      parseIncompleteMarkdown={!!streaming}
      className={className}
      components={components}
      rehypePlugins={rehypeFor(mod)}
      remarkRehypeOptions={remarkRehypeOptions}
      urlTransform={mod.defaultUrlTransform}
      plugins={plugins}
      controls={false}
      lineNumbers={false}
      linkSafety={LINK_SAFETY_OFF}
    >
      {text}
    </Streamdown>
  );
});
