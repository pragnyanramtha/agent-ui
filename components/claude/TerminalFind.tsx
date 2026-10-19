"use client";

import { useEffect, useRef, useState } from "react";
import type { ISearchResultChangeEvent, SearchAddon } from "@xterm/addon-search";
import { NavArrowDown, NavArrowUp, Xmark } from "iconoir-react";
import { findDecorations, findLabel } from "@/lib/client/terminal-find";

/** A small find bar over the terminal: Enter for the next match, Shift+Enter for the previous one, Esc closes */
export function TerminalFind({ search, dark, focusKey, onClose }: { search: SearchAddon; dark: boolean; focusKey: number; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<ISearchResultChangeEvent | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const opts = { decorations: findDecorations(dark) };

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusKey]);
  useEffect(() => {
    const sub = search.onDidChangeResults(setResult);
    return () => {
      sub.dispose();
      search.clearDecorations();
    };
  }, [search]);
  useEffect(() => {
    if (!query) {
      search.clearDecorations();
      setResult(null);
      return;
    }
    search.findNext(query, { ...opts, incremental: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, search, dark]);

  const step = (back: boolean) => {
    if (!query) return;
    if (back) search.findPrevious(query, opts);
    else search.findNext(query, opts);
  };
  const label = findLabel(query, result);
  const btn = "tap relative flex size-7 shrink-0 items-center justify-center rounded-[7px] text-ink-3 hover:bg-hover hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent";
  return (
    <div role="search" className="absolute top-2 right-3 z-20 flex items-center gap-0.5 rounded-[10px] bg-surface p-1 shadow-overlay" style={{ animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both" }}>
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        placeholder="Find"
        aria-label="Find in terminal"
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        className="h-7 w-36 min-w-0 bg-transparent px-2 text-[12.5px] text-ink outline-none placeholder:text-ink-3 sm:w-48"
      />
      <span aria-live="polite" className={`shrink-0 px-1 text-[11.5px] tabular-nums ${result?.resultCount === 0 ? "text-red-ink" : "text-ink-3"}`}>
        {label}
      </span>
      <button type="button" onClick={() => step(true)} disabled={!result?.resultCount} aria-label="Previous match" className={btn}>
        <NavArrowUp width={15} height={15} strokeWidth={1.9} />
      </button>
      <button type="button" onClick={() => step(false)} disabled={!result?.resultCount} aria-label="Next match" className={btn}>
        <NavArrowDown width={15} height={15} strokeWidth={1.9} />
      </button>
      <button type="button" onClick={onClose} aria-label="Close find" className={btn}>
        <Xmark width={14} height={14} strokeWidth={2} />
      </button>
    </div>
  );
}
