"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { NavArrowDown, NavArrowUp, Xmark } from "iconoir-react";

const MAX = 2000;

type HighlightsApi = { set(name: string, h: unknown): void; delete(name: string): void };
const highlights = (): HighlightsApi | null => (typeof CSS !== "undefined" && "highlights" in CSS ? (CSS as unknown as { highlights: HighlightsApi }).highlights : null);
const makeHighlight = (ranges: Range[]) => new (window as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight(...ranges);

/** Text ranges in `root` matching `q` (case-insensitive), in document order. */
function findRanges(root: Element, q: string): Range[] {
  const needle = q.toLowerCase();
  const out: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest("[aria-hidden='true'], script, style") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n && out.length < MAX; n = walker.nextNode()) {
    const text = (n.nodeValue ?? "").toLowerCase();
    for (let i = text.indexOf(needle); i !== -1 && out.length < MAX; i = text.indexOf(needle, i + needle.length)) {
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + needle.length);
      out.push(r);
    }
  }
  return out;
}

/**
 * Find in the loaded messages of a session (Ctrl/Cmd+F). Matches are painted with the CSS
 * Custom Highlight API, so React's DOM is never touched. Collapsed tool output isn't searched.
 */
export function FindBar({ scope }: { scope: RefObject<HTMLElement | null> }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [count, setCount] = useState(0);
  const [index, setIndex] = useState(0);
  const ranges = useRef<Range[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const supported = typeof window !== "undefined" && Boolean(highlights());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.code !== "KeyF") return;
      if (e.target instanceof Element && e.target.closest(".xterm")) return;
      if (!scope.current?.isConnected || !highlights()) return;
      e.preventDefault();
      setOpen(true);
      requestAnimationFrame(() => input.current?.select());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scope]);

  const paint = useCallback((list: Range[], current: number) => {
    const h = highlights();
    if (!h) return;
    h.set("find", makeHighlight(list));
    if (list[current]) h.set("find-current", makeHighlight([list[current]]));
    else h.delete("find-current");
  }, []);

  const reveal = (r: Range | undefined) => {
    const log = scope.current?.querySelector<HTMLElement>('[role="log"]');
    if (!r || !log) return;
    const box = r.getBoundingClientRect();
    const view = log.getBoundingClientRect();
    if (box.top < view.top + 60 || box.bottom > view.bottom - 160) log.scrollBy({ top: box.top - view.top - view.height / 3 });
  };

  /* search again as the query changes or new messages arrive */
  useEffect(() => {
    if (!open) return;
    const log = scope.current?.querySelector('[role="log"]');
    if (!log) return;
    const run = () => {
      const list = q.trim() ? findRanges(log, q.trim()) : [];
      ranges.current = list;
      setCount(list.length);
      setIndex((i) => (i < list.length ? i : 0));
    };
    run();
    let t: ReturnType<typeof setTimeout> | undefined;
    const mo = new MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(run, 250);
    });
    mo.observe(log, { childList: true, subtree: true, characterData: true });
    return () => {
      mo.disconnect();
      clearTimeout(t);
    };
  }, [open, q, scope]);

  useEffect(() => {
    if (!open) return;
    paint(ranges.current, index);
  }, [open, index, count, paint]);

  useEffect(() => {
    if (open) return;
    highlights()?.delete("find");
    highlights()?.delete("find-current");
  }, [open]);
  useEffect(
    () => () => {
      highlights()?.delete("find");
      highlights()?.delete("find-current");
    },
    [],
  );

  const step = (d: number) => {
    const n = ranges.current.length;
    if (!n) return;
    const next = (index + d + n) % n;
    setIndex(next);
    reveal(ranges.current[next]);
  };

  if (!open || !supported) return null;
  return (
    <div
      role="search"
      className="absolute top-full right-3 z-30 mt-1 flex h-10 items-center gap-1 rounded-[10px] border border-line bg-surface pr-1 pl-3 shadow-overlay sm:right-4"
      style={{ animation: "pop-in 140ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "top right" }}
    >
      <input
        ref={input}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setIndex(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            setOpen(false);
          }
        }}
        placeholder="Find in session"
        aria-label="Find in session"
        autoFocus
        className="w-44 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3 sm:w-56"
      />
      <span className="min-w-12 text-right text-[12px] text-ink-3 tabular-nums" aria-live="polite">
        {q.trim() ? (count ? `${index + 1}/${count >= MAX ? `${MAX}+` : count}` : "0/0") : ""}
      </span>
      <button type="button" onClick={() => step(-1)} aria-label="Previous match" disabled={!count} className="icon-btn size-7 disabled:opacity-40">
        <NavArrowUp width={15} height={15} strokeWidth={1.8} />
      </button>
      <button type="button" onClick={() => step(1)} aria-label="Next match" disabled={!count} className="icon-btn size-7 disabled:opacity-40">
        <NavArrowDown width={15} height={15} strokeWidth={1.8} />
      </button>
      <button type="button" onClick={() => setOpen(false)} aria-label="Close find" className="icon-btn size-7">
        <Xmark width={15} height={15} strokeWidth={1.8} />
      </button>
    </div>
  );
}
