"use client";

import { memo, useEffect, useRef, useState } from "react";
import { Check, Copy } from "iconoir-react";
import { copyText } from "./CodeCard";

/** "14:02", always 24-hour. */
export function clock(ts: string) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function CopyButton({ text, onCopied }: { text: string; onCopied: (v: boolean) => void }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () =>
    copyText(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      onCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setCopied(false);
        onCopied(false);
      }, 1500);
    });
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? "Copied" : "Copy message"}
      className={`tap relative flex h-8 items-center gap-1 rounded-[6px] px-1.5 font-medium transition-colors duration-100 hover:bg-hover pointer-fine:h-6 ${copied ? "text-green" : "hover:text-ink"}`}
    >
      {copied ? <Check width={13} height={13} strokeWidth={2.2} aria-hidden /> : <Copy width={13} height={13} strokeWidth={1.8} aria-hidden />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/**
 * The quiet row under a message: copy, and for prompts the time it was sent.
 * Touch screens see it in flow and always on; with a fine pointer it sits in
 * the gap below the message (the wrapper reserves that space with matching
 * padding and negative margin) and fades in on hover or keyboard focus, so
 * revealing it never moves anything.
 */
export const MessageActions = memo(function MessageActions({ text, ts, align = "start" }: { text: string; ts?: string; align?: "start" | "end" }) {
  const [copied, setCopied] = useState(false);
  const time = ts ? clock(ts) : null;
  return (
    <div
      data-copied={copied || undefined}
      className={`flex h-8 items-center gap-1 text-[12px] text-ink-3 select-none transition-opacity duration-150 motion-reduce:transition-none pointer-fine:absolute pointer-fine:bottom-0 pointer-fine:h-6 pointer-fine:opacity-0 pointer-fine:group-hover/msg:opacity-100 pointer-fine:focus-within:opacity-100 pointer-fine:data-copied:opacity-100 ${
        align === "end" ? "flex-row-reverse self-end pointer-fine:right-0 -mr-1.5" : "self-start pointer-fine:left-0 -ml-1.5"
      }`}
    >
      {text && <CopyButton text={text} onCopied={setCopied} />}
      {time && (
        <time dateTime={ts} title={new Date(ts!).toLocaleString()} className="px-1 tabular-nums">
          {time}
        </time>
      )}
    </div>
  );
});

/*
 * Wrapper classes that make room for MessageActions without adding layout on hover.
 * ACTIONS_PAD goes on the row's containing block (positioned, so the absolute row
 * lands in its padding); ACTIONS_GAP goes on the outermost wrapper of the block,
 * which also carries content-visibility and so must enclose the row to not clip it.
 */
export const ACTIONS_PAD = "relative pointer-fine:pb-7";
export const ACTIONS_GAP = "group/msg pointer-coarse:-mb-2 pointer-fine:-mb-5";
export const ACTIONS_HOST = `${ACTIONS_GAP} ${ACTIONS_PAD} flex flex-col`;
