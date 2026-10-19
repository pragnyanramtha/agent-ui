"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { NavArrowDown, NavArrowUp, Xmark } from "iconoir-react";
import { isCommand, modalOpen } from "@/lib/client/shortcuts";
import { matchOffsets, nthWithin } from "@/lib/client/find";
import { EXPAND_CODE_EVENT } from "./CodeCard";
import { RELEASE_PIN_EVENT, SHOW_ALL_EVENT, SHOWN_ALL_EVENT } from "./Thread";
import { EXPAND_FOLD_EVENT } from "./TurnFold";

const MAX = 2000;

type HighlightsApi = { set(name: string, h: unknown): void; delete(name: string): void };
const highlights = (): HighlightsApi | null => (typeof CSS !== "undefined" && "highlights" in CSS ? (CSS as unknown as { highlights: HighlightsApi }).highlights : null);
const makeHighlight = (ranges: Range[]) => new (window as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight(...ranges);

/** Text ranges in `root` matching `q` (case-insensitive), in document order. */
function findRanges(root: Element, q: string): Range[] {
  const out: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest("[aria-hidden='true'], script, style") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n && out.length < MAX; n = walker.nextNode()) {
    for (const i of matchOffsets(n.nodeValue ?? "", q, MAX - out.length)) {
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + q.length);
      out.push(r);
    }
  }
  return out;
}

/**
 * Find in the loaded messages of a session (Ctrl/Cmd+F). Matches are painted with the CSS
 * Custom Highlight API, so React's DOM is never touched. Collapsed tool output isn't searched;
 * folded turns and collapsed code blocks are, and the one holding the current match opens. Opening find
 * renders the whole thread (a long one renders its newest part first) and searches once it is all there.
 */
export function FindBar({ scope }: { scope: RefObject<HTMLElement | null> }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [count, setCount] = useState(0);
  /* a long thread is still rendering its older messages; searching waits for them instead of redoing it per slice */
  const [filling, setFilling] = useState(false);
  const [index, setIndex] = useState(0);
  const ranges = useRef<Range[]>([]);
  const indexRef = useRef(index);
  indexRef.current = index;
  const qRef = useRef(q);
  qRef.current = q;
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const supported = typeof window !== "undefined" && Boolean(highlights());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isCommand(e, "find")) return;
      /* the terminal, the side panels and dialogs keep the browser's own find */
      if (e.target instanceof Element && e.target.closest(".xterm, .panel-slot")) return;
      if (modalOpen() || !scope.current?.isConnected || !highlights()) return;
      e.preventDefault();
      const at = document.activeElement;
      if (!input.current) opener.current = at instanceof HTMLElement && at !== document.body ? at : null;
      setOpen(true);
      const log = scope.current.querySelector('[role="log"]');
      if (log) {
        setFilling(true);
        log.dispatchEvent(new Event(SHOW_ALL_EVENT));
      }
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

  const show = useCallback(
    (list: Range[], i: number) => {
      ranges.current = list;
      setCount(list.length);
      setIndex(i);
      paint(list, i);
    },
    [paint],
  );

  const reveal = useCallback(
    (r: Range | undefined, tries = 0) => {
      const log = scope.current?.querySelector<HTMLElement>('[role="log"]');
      if (!r || !log) return;
      const at = r.startContainer.parentElement;
      /* a match inside a collapsed turn: open it, then scroll once it has laid out */
      const fold = at?.closest<HTMLElement>("[data-fold]:not([data-open])");
      if (fold && tries < 3) {
        fold.dispatchEvent(new Event(EXPAND_FOLD_EVENT));
        requestAnimationFrame(() => requestAnimationFrame(() => reveal(r, tries + 1)));
        return;
      }
      /* in the hidden rest of a collapsed code block: open it, then find the same match among its rendered lines */
      const card = at?.closest("[data-code-rest]")?.closest<HTMLElement>("[data-code-card]");
      if (card && tries < 3) {
        const inCard = (x: Range) => card.contains(x.startContainer);
        const nth = ranges.current.filter(inCard).indexOf(r);
        card.dispatchEvent(new Event(EXPAND_CODE_EVENT));
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const list = findRanges(log, qRef.current.trim());
            const i = nthWithin(list, inCard, nth);
            if (i === -1) return;
            show(list, i);
            reveal(list[i], tries + 1);
          }),
        );
        return;
      }
      const box = r.getBoundingClientRect();
      const view = log.getBoundingClientRect();
      if (box.top >= view.top + 60 && box.bottom <= view.bottom - 160) return;
      log.dispatchEvent(new Event(RELEASE_PIN_EVENT));
      log.scrollBy({ top: box.top - view.top - view.height / 3 });
    },
    [scope, show],
  );

  /* search again as the query changes (showing the first match) or new messages arrive (keeping the current one).
   * Painted here too: new ranges can come back with the same count and index. */
  useEffect(() => {
    if (!open) return;
    const log = scope.current?.querySelector('[role="log"]');
    if (!log) return;
    if (filling) return show([], 0);
    const run = (fresh: boolean) => {
      const list = q.trim() ? findRanges(log, q.trim()) : [];
      const i = !fresh && indexRef.current < list.length ? indexRef.current : 0;
      show(list, i);
      if (fresh) reveal(list[0]);
    };
    run(true);
    let t: ReturnType<typeof setTimeout> | undefined;
    const mo = new MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => run(false), 250);
    });
    mo.observe(log, { childList: true, subtree: true, characterData: true });
    return () => {
      mo.disconnect();
      clearTimeout(t);
    };
  }, [open, q, filling, scope, show, reveal]);

  useEffect(() => {
    const log = scope.current?.querySelector('[role="log"]');
    if (!open || !log) return;
    const done = () => setFilling(false);
    if (log.hasAttribute("data-all")) done();
    log.addEventListener(SHOWN_ALL_EVENT, done);
    /* never left waiting if the thread goes away mid-fill */
    const t = setTimeout(done, 20_000);
    return () => {
      log.removeEventListener(SHOWN_ALL_EVENT, done);
      clearTimeout(t);
    };
  }, [open, scope]);

  useEffect(() => {
    if (!open) return;
    paint(ranges.current, index);
  }, [open, index, paint]);

  useEffect(() => {
    if (open) return;
    highlights()?.delete("find");
    highlights()?.delete("find-current");
  }, [open]);

  const close = () => {
    setOpen(false);
    const back = opener.current;
    opener.current = null;
    const target = back?.isConnected ? back : scope.current?.querySelector<HTMLElement>('textarea[aria-label="Message"]');
    requestAnimationFrame(() => target?.focus({ preventScroll: true }));
  };
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
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
        placeholder="Find in session"
        aria-label="Find in session"
        autoFocus
        className="w-44 bg-transparent text-[16px] text-ink sm:text-sm outline-none placeholder:text-ink-3 sm:w-56"
      />
      <span className="min-w-12 text-right text-xs text-ink-3 tabular-nums" aria-live="polite">
        {q.trim() ? (filling ? "Searching…" : count ? `${index + 1}/${count >= MAX ? `${MAX}+` : count}` : "0/0") : ""}
      </span>
      <button type="button" onClick={() => step(-1)} aria-label="Previous match" disabled={!count} className="icon-btn size-7 disabled:opacity-40">
        <NavArrowUp width={15} height={15} strokeWidth={1.8} />
      </button>
      <button type="button" onClick={() => step(1)} aria-label="Next match" disabled={!count} className="icon-btn size-7 disabled:opacity-40">
        <NavArrowDown width={15} height={15} strokeWidth={1.8} />
      </button>
      <button type="button" onClick={close} aria-label="Close find" className="icon-btn size-7">
        <Xmark width={15} height={15} strokeWidth={1.8} />
      </button>
    </div>
  );
}
