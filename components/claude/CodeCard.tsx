"use client";

import { useEffect, useRef, useState } from "react";
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

/** Beautiful UI's CodeBlock card, fed real content: header with the language, copy, line gutter. */
export function CodeCard({ code, label }: { code: string; label?: string }) {
  const plain = isPlainText(label);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const lines = code.replace(/\n$/, "").split("\n");
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
      <div className="flex h-9 items-center gap-2 border-b border-line pr-1.5 pl-3 text-xs">
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
        className="max-h-[28rem] overflow-auto overscroll-x-contain py-2.5 font-mono text-sm leading-[1.65] text-ink-2 focus-visible:[outline-offset:-2px]!"
      >
        <div className="min-w-fit">
          {lines.map((line, i) => (
            <div key={i} className="grid items-start" style={{ gridTemplateColumns: `${gutter} minmax(0,1fr)` }}>
              {/* sticky so line numbers stay put while long lines scroll sideways */}
              <span className="sticky left-0 border-r border-line bg-surface pr-2 text-right text-2xs text-ink-3 tabular-nums select-none">{i + 1}</span>
              <code className="pr-4 pl-2 whitespace-pre">{plain ? line : highlight(line)}</code>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
