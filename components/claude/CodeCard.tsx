"use client";

import { Fragment, memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "iconoir-react";
import { highlight, isPlainText } from "@/lib/client/highlight";
import { PathLabel } from "./PathLabel";

/** Copies text, falling back to a hidden textarea where the async clipboard API is unavailable (plain-http tunnels). */
export async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through */
    }
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  return ok;
}

/* both columns share one absolute line height, so the gutter's smaller digits stay level with their lines */
const LINE = "leading-[20.625px]";
const PREVIEW_LINES = 30;
/** blocks in the thread longer than this start collapsed */
export const COLLAPSE_LINES = 40;

/** Colored lines joined by newlines, for one `<code>`: no element per line, only per token. */
function codeBody(lines: string[], plain: boolean): ReactNode {
  if (plain) return lines.join("\n");
  return lines.map((line, i) => (
    <Fragment key={i}>
      {highlight(line)}
      {i < lines.length - 1 ? "\n" : null}
    </Fragment>
  ));
}

/**
 * Beautiful UI's CodeBlock card, fed real content: header with the language, copy, line gutter.
 * With `collapseAfter`, longer blocks show their first lines until "Show all"; copy always takes the whole text.
 */
export const CodeCard = memo(function CodeCard({ code, label, collapseAfter }: { code: string; label?: string; collapseAfter?: number }) {
  const plain = isPlainText(label);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const lines = useMemo(() => code.replace(/\n$/, "").split("\n"), [code]);
  const collapsible = collapseAfter !== undefined && lines.length > collapseAfter;
  const shown = collapsible && !expanded ? Math.min(PREVIEW_LINES, collapseAfter) : lines.length;
  const body = useMemo(() => codeBody(shown < lines.length ? lines.slice(0, shown) : lines, plain), [lines, shown, plain]);
  const numbers = useMemo(() => Array.from({ length: shown }, (_, i) => i + 1).join("\n"), [shown]);
  /* the gutter grows with the line count so four-digit files don't spill into the code */
  const gutter = `calc(${String(lines.length).length}ch + 18px)`;
  const copy = () =>
    copyText(code).then((ok) => {
      if (!ok) return;
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    });

  return (
    <div className="not-prose w-full min-w-0 overflow-hidden rounded-card bg-surface shadow-card">
      <div className="flex h-9 items-center gap-2 border-b border-line pr-1.5 pl-3 text-[12px]">
        {label?.includes("/") ? <PathLabel path={label} /> : <span className="truncate font-mono text-ink-3">{label || "text"}</span>}
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? "Copied" : "Copy code"}
          className={`ml-auto flex h-7 shrink-0 items-center gap-1 rounded-[6px] px-2 font-medium transition-colors duration-100 hover:bg-hover ${copied ? "text-green" : "text-ink-3 hover:text-ink"}`}
        >
          {copied ? <Check width={13} height={13} strokeWidth={2.2} /> : <Copy width={13} height={13} strokeWidth={1.8} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div
        tabIndex={0}
        translate="no"
        className="max-h-[28rem] overflow-auto overscroll-x-contain py-2.5 font-mono text-[12.5px] leading-[1.65] text-ink-2 focus-visible:[outline-offset:-2px]!"
      >
        <div className="flex min-w-fit items-start">
          {/* sticky so line numbers stay put while long lines scroll sideways */}
          <span
            aria-hidden
            className={`sticky left-0 shrink-0 self-stretch border-r border-line bg-surface pr-2 text-right text-[11px] whitespace-pre text-ink-3 tabular-nums select-none ${LINE}`}
            style={{ width: gutter }}
          >
            {numbers}
          </span>
          <pre className={`m-0 min-w-0 flex-1 pr-4 pl-2 font-mono whitespace-pre ${LINE}`}>
            <code>{body}</code>
          </pre>
        </div>
      </div>
      {collapsible && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex h-8 w-full items-center justify-center border-t border-line text-[12px] font-medium text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink"
        >
          {expanded ? "Show less" : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
});
