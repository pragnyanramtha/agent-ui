"use client";

import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { copyText } from "./CodeCard";

export const RAW_MAX = 20_000;

/** The entry as indented JSON for the fallback; never throws (cycles, BigInt) and caps what goes on screen. */
export function rawJson(entry: unknown, max = RAW_MAX): { full: string; shown: string; truncated: boolean } {
  let full: string;
  try {
    const seen = new WeakSet<object>();
    full =
      JSON.stringify(
        entry,
        (_k, v: unknown) => {
          if (typeof v === "bigint") return `${v}n`;
          if (typeof v === "object" && v !== null) {
            if (seen.has(v)) return "[Circular]";
            seen.add(v);
          }
          return v;
        },
        2,
      ) ?? String(entry);
  } catch {
    full = String(entry);
  }
  const truncated = full.length > max;
  return { full, shown: truncated ? full.slice(0, max) : full, truncated };
}

const BTN = "tap relative h-7 rounded-[7px] px-2.5 text-[12px] font-medium text-ink-2 shadow-btn hover:bg-hover hover:text-ink";

/** The compact card a crashed entry shows instead of blanking the thread. */
export function EntryFallback({ entry, message = "Couldn't show this message.", actions }: { entry?: unknown; message?: string; actions?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const raw = open ? rawJson(entry) : null;
  const copy = () =>
    void copyText(rawJson(entry, Infinity).full).then((ok) => {
      if (!ok) return;
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    });
  return (
    <div role="alert" className="flex min-w-0 flex-col gap-2 rounded-card bg-inset px-3 py-2.5 shadow-hairline">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-0 flex-1 text-[12.5px] text-ink-2">{message}</p>
        <span className="flex shrink-0 items-center gap-1.5">
          {entry !== undefined && (
            <>
              <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className={BTN}>
                {open ? "Hide raw" : "Show raw"}
              </button>
              <button type="button" onClick={copy} className={BTN}>
                {copied ? "Copied" : "Copy"}
              </button>
            </>
          )}
          {actions}
        </span>
      </div>
      {raw && (
        <pre
          tabIndex={0}
          translate="no"
          className="max-h-72 overflow-auto overscroll-contain rounded-[8px] bg-surface px-2.5 py-2 font-mono text-[11.5px] leading-[1.6] whitespace-pre-wrap text-ink-2 shadow-hairline [overflow-wrap:anywhere] focus-visible:[outline-offset:-2px]!"
        >
          {raw.shown}
          {raw.truncated && <span className="font-sans text-ink-3">{"\n"}Trimmed. Copy has all of it.</span>}
        </pre>
      )}
    </div>
  );
}

type Props = {
  children?: ReactNode;
  /** a new value clears the error and renders the children again */
  resetKey?: unknown;
  /** what the default fallback can show raw and copy */
  entry?: unknown;
  /** replaces the default card; `retry` renders the children again */
  fallback?: (retry: () => void) => ReactNode;
  /** names the failing part in the console */
  label?: string;
};

type State = { failed: boolean };

/** Keeps a render crash inside one entry or panel instead of taking the whole app down. */
export class Boundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`[agent-u] ${this.props.label ?? "entry"} failed to render`, error, info.componentStack);
  }

  componentDidUpdate(prev: Props, prevState: State) {
    if (this.state.failed && prevState.failed && !Object.is(prev.resetKey, this.props.resetKey)) this.setState({ failed: false });
  }

  retry = () => this.setState({ failed: false });

  render() {
    if (!this.state.failed) return this.props.children;
    return this.props.fallback ? this.props.fallback(this.retry) : <EntryFallback entry={this.props.entry} />;
  }
}
