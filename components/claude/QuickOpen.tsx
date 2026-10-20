"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Page, Search, Xmark } from "iconoir-react";
import { useFileSearch } from "@/lib/client/useFileSearch";
import { markRuns, matchPositions, splitQueryLine } from "@/lib/file-match";
import { composing } from "@/lib/keybindings";

/* "Go to file": the session folder's files ranked as you type (the same search as the composer's @ picker).
 * "app.ts:42" opens at line 42. */

function Marked({ text, at }: { text: string; at: number[] }) {
  return (
    <>
      {markRuns(text, at).map((r, i) =>
        r.hit ? (
          <mark key={i} className="bg-transparent font-semibold text-accent-ink">
            {r.text}
          </mark>
        ) : (
          r.text
        ),
      )}
    </>
  );
}

export function QuickOpen({ root, onPick, onClose }: { root: string; onPick: (rel: string, line?: number) => void; onClose: () => void }) {
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const uid = useId();
  const { query, line } = splitQueryLine(text);
  const { files, loading, error } = useFileSearch(root, query);

  useEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    inputRef.current?.focus();
  }, []);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const cancel = () => {
    onClose();
    const el = opener.current;
    if (el?.isConnected) requestAnimationFrame(() => el.focus({ preventScroll: true }));
  };
  const pickAt = (i: number) => {
    const f = files[i];
    if (!f) return;
    onClose();
    onPick(f, line);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (composing(e.nativeEvent)) return;
    const n = files.length;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
        e.preventDefault();
        if (n) setActive((a) => (a + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
        return;
      case "Enter":
        e.preventDefault();
        pickAt(active);
        return;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        if (text) setText("");
        else cancel();
        return;
      case "Tab": {
        const all = Array.from(panelRef.current?.querySelectorAll<HTMLElement>("input, button:not([disabled])") ?? []);
        if (!all.length) return;
        e.preventDefault();
        const at = all.indexOf(document.activeElement as HTMLElement);
        all[(at + (e.shiftKey ? -1 : 1) + all.length) % all.length].focus();
        return;
      }
    }
  };

  const opt = (i: number) => `${uid}-f${i}`;
  const status = error ? "Couldn't search this folder." : loading && !files.length ? "Searching…" : !files.length ? (query ? "No files match." : "No files here.") : null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center sm:px-4 sm:pt-[12vh]" onKeyDown={onKeyDown}>
      <div aria-hidden className="absolute inset-0 touch-none bg-black/50 motion-safe:animate-[fade-in_160ms_ease-out_both]" onClick={cancel} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Go to file"
        onMouseDown={(e) => {
          if (!(e.target as HTMLElement).closest("input, button")) e.preventDefault();
        }}
        className="safe-top relative flex max-h-[min(100dvh,560px)] w-full flex-col overflow-hidden rounded-b-[16px] bg-surface shadow-overlay motion-safe:animate-[fade-up_220ms_cubic-bezier(0.23,1,0.32,1)_both] sm:max-h-[min(70vh,520px)] sm:max-w-[560px] sm:rounded-[14px] sm:motion-safe:animate-[pop-in_180ms_cubic-bezier(0.23,1,0.32,1)_both]"
      >
        <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-line pr-2 pl-4 sm:h-[52px]">
          <Search width={17} height={17} strokeWidth={1.9} className="shrink-0 text-ink-3" aria-hidden />
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={`${uid}-list`}
            aria-autocomplete="list"
            aria-activedescendant={files.length ? opt(active) : undefined}
            aria-label="Go to file"
            placeholder="Go to file…"
            enterKeyHint="go"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="h-full min-w-0 flex-1 bg-transparent text-[16px] text-ink outline-none placeholder:text-ink-3 sm:text-base sm:pointer-coarse:text-[16px]"
          />
          <button
            type="button"
            onClick={cancel}
            aria-label="Close"
            className="tap relative flex size-10 shrink-0 items-center justify-center rounded-[9px] text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink sm:size-8"
          >
            <Xmark width={16} height={16} strokeWidth={2} />
          </button>
        </div>
        <div ref={listRef} id={`${uid}-list`} role="listbox" aria-label="Files" aria-busy={loading} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
          {files.map((f, i) => {
            const on = i === active;
            const cut = f.lastIndexOf("/");
            const base = f.slice(cut + 1);
            const dir = cut >= 0 ? f.slice(0, cut) : "";
            const at = matchPositions(f, query);
            return (
              <div
                key={f}
                id={opt(i)}
                data-i={i}
                role="option"
                aria-selected={on}
                onPointerMove={() => !on && setActive(i)}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => pickAt(i)}
                className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-[9px] px-2.5 py-1.5 select-none sm:min-h-9 ${on ? "bg-hover text-ink" : "text-ink-2"}`}
              >
                <Page width={15} height={15} strokeWidth={1.8} className="shrink-0 text-ink-3" aria-hidden />
                <span className="flex min-w-0 flex-1 items-baseline gap-2" translate="no">
                  <span className="shrink-0 truncate text-sm font-medium">
                    <Marked text={base} at={at.filter((p) => p > cut).map((p) => p - cut - 1)} />
                  </span>
                  {dir && (
                    <span className="min-w-0 truncate font-mono text-2xs text-ink-3">
                      <Marked text={dir} at={at.filter((p) => p < cut)} />
                    </span>
                  )}
                </span>
                {on && line ? <span className="shrink-0 text-xs text-ink-3">line {line}</span> : null}
              </div>
            );
          })}
          {status && (
            <p role="status" className="px-2.5 py-6 text-center text-sm text-ink-3">
              {status}
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
