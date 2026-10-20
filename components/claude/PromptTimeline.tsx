"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyEvent } from "react";
import type { ThreadNav } from "./Thread";
import { Sheet } from "./Sheet";
import { useSetting } from "@/lib/client/settings";
import { isCommand, isTyping, modalOpen } from "@/lib/client/shortcuts";
import { estimateHeight } from "@/lib/client/thread-window";
import { dayStamp, type TimeFormat } from "@/lib/time-format";
import { adjacentPrompt, currentPrompt, firstLine, fractions, JUMP_MARGIN, prefixSums, promptMarks, promptOffsets, type PromptMark } from "@/lib/client/prompt-timeline";

/* the space between blocks, added to each estimate; only the skipped part of a long thread uses it */
const BLOCK_GAP = 20;
const MIN_BAND = 0.02;

const flags = (m: PromptMark) => [m.failed && "Failed", m.waiting && "Waiting on you", m.changed && "Changed files"].filter(Boolean) as string[];

function describe(m: PromptMark, i: number, n: number, fmt: TimeFormat) {
  const when = m.ts ? dayStamp(m.ts, fmt) : "";
  return [`Prompt ${i + 1} of ${n}: ${firstLine(m.text) || "Image"}`, when, ...flags(m)].filter(Boolean).join(", ");
}

/** The colored dot beside a mark: failed wins over waiting, waiting over changed files. */
const dotClass = (m: PromptMark) => (m.failed ? "bg-red" : m.waiting ? "bg-orange-ink" : m.changed ? "bg-accent" : "");

/**
 * One mark per prompt along the right edge of the thread, the part on screen as a band. Positions are worked out
 * on layout changes and the band follows scrolling in an animation frame, both written to the DOM directly, so
 * scrolling never re-renders it. Alt+Up and Alt+Down move between prompts. On phones a compact strip stays visible;
 * the session menu's Jump to prompt opens the same list as a sheet.
 */
export const PromptTimeline = memo(function PromptTimeline({
  nav,
  bottomPad,
  waiting,
  failed,
  sheet,
  onSheetClose,
}: {
  nav: ThreadNav;
  bottomPad: number;
  waiting: boolean;
  failed: boolean;
  sheet: boolean;
  onSheetClose: () => void;
}) {
  const [show] = useSetting("promptTimeline");
  const [fmt] = useSetting("timeFormat");
  const { blocks, start, foldsOpen, scrollRef, contentRef, reveal } = nav;
  const marks = useMemo(() => promptMarks(blocks, { waiting, lastFailed: failed }), [blocks, waiting, failed]);
  const sums = useMemo(() => prefixSums(blocks.map((b) => estimateHeight(b, foldsOpen) + BLOCK_GAP)), [blocks, foldsOpen]);
  const geo = useRef({ offsets: [] as number[], above: 0, total: 0 });
  const ticks = useRef<(HTMLButtonElement | null)[]>([]);
  const band = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(-1);
  const [hover, setHover] = useState<number | null>(null);
  const live = useRef({ marks, sums, start, bottomPad });
  live.current = { marks, sums, start, bottomPad };

  /** Re-reads where every prompt is; cheap enough for a resize, never run per scroll frame. */
  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const { marks, sums, start } = live.current;
    const box = el.getBoundingClientRect().top - el.scrollTop;
    const tops = new Map<string, number>();
    for (const node of el.querySelectorAll<HTMLElement>("[data-prompt]")) tops.set(node.dataset.prompt!, node.getBoundingClientRect().top - box);
    const offsets = promptOffsets(marks, start, sums, (k) => tops.get(k) ?? null);
    const above = sums[Math.min(start, sums.length - 1)] ?? 0;
    const total = above + el.scrollHeight;
    geo.current = { offsets, above, total };
    fractions(offsets, total).forEach((f, i) => {
      const t = ticks.current[i];
      if (t) t.style.top = `${f * 100}%`;
    });
  }, [scrollRef]);

  const currentRef = useRef(-1);
  const paintBand = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const { above, total, offsets } = geo.current;
    if (band.current && total > 0) {
      const visible = Math.max(0, el.clientHeight - live.current.bottomPad);
      const h = Math.max(MIN_BAND, visible / total);
      const top = Math.min(1 - h, (above + el.scrollTop) / total);
      band.current.style.top = `${top * 100}%`;
      band.current.style.height = `${h * 100}%`;
    }
    const cur = currentPrompt(offsets, above + el.scrollTop + JUMP_MARGIN);
    if (cur === currentRef.current) return;
    currentRef.current = cur;
    setCurrent(cur);
    const focus = cur >= 0 ? cur : live.current.marks.length - 1;
    ticks.current.forEach((t, i) => {
      if (!t) return;
      if (i === cur) t.setAttribute("aria-current", "location");
      else t.removeAttribute("aria-current");
      t.tabIndex = i === focus ? 0 : -1;
      const bar = t.querySelector<HTMLElement>("[data-tick]");
      if (bar) {
        bar.classList.toggle("w-3", i === cur);
        bar.classList.toggle("bg-ink", i === cur);
        bar.classList.toggle("w-2", i !== cur);
        bar.classList.toggle("bg-ink-3", i !== cur);
      }
    });
  }, [scrollRef]);

  useLayoutEffect(() => {
    currentRef.current = -2;
    measure();
    paintBand();
  }, [marks, sums, start, bottomPad, show, measure, paintBand]);

  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    let raf = 0;
    let dirty = false;
    const frame = () => {
      raf = 0;
      if (dirty) measure();
      dirty = false;
      paintBand();
    };
    const schedule = (remeasure: boolean) => {
      dirty ||= remeasure;
      if (!raf) raf = requestAnimationFrame(frame);
    };
    const onScroll = () => schedule(false);
    const ro = new ResizeObserver(() => schedule(true));
    ro.observe(content);
    ro.observe(el);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [scrollRef, contentRef, measure, paintBand]);

  /* Alt+Up and Alt+Down (Settings > Keyboard), never while typing */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || isTyping(e.target) || modalOpen()) return;
      const dir = isCommand(e, "prevPrompt") ? -1 : isCommand(e, "nextPrompt") ? 1 : 0;
      if (!dir) return;
      const el = scrollRef.current;
      if (!el) return;
      e.preventDefault();
      measure();
      const { offsets, above } = geo.current;
      const i = adjacentPrompt(offsets, above + el.scrollTop + JUMP_MARGIN, dir);
      const m = i === null ? undefined : live.current.marks[i];
      if (m) reveal(m.key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scrollRef, measure, reveal]);

  const jump = (i: number) => {
    const m = marks[i];
    if (m) reveal(m.key);
  };
  const focusable = current >= 0 ? current : marks.length - 1;
  const onStripKey = (e: ReactKeyEvent<HTMLElement>) => {
    const at = ticks.current.findIndex((t) => t === document.activeElement);
    if (at === -1) return;
    const next = { ArrowUp: at - 1, ArrowDown: at + 1, Home: 0, End: marks.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    ticks.current[Math.max(0, Math.min(marks.length - 1, next))]?.focus();
  };

  const tip = hover !== null ? marks[hover] : null;
  const tipTop = hover !== null ? ticks.current[hover]?.style.top : undefined;

  return (
    <>
      {show && marks.length > 1 && (
        <nav
          aria-label="Prompt timeline"
          className="absolute top-3 right-1 z-10 w-2 sm:right-3 sm:w-5"
          style={{ bottom: bottomPad + 12 }}
          onKeyDown={onStripKey}
          onMouseLeave={() => setHover(null)}
        >
          <div aria-hidden className="absolute inset-y-0 right-[3px] w-px bg-line sm:right-[5px]" />
          <div ref={band} aria-hidden className="pointer-events-none absolute right-0 left-0 rounded-[3px] bg-ink/10 transition-none sm:left-1.5" />
          <ol className="contents">
            {marks.map((m, i) => (
              <li key={m.key} className="contents">
                <button
                  ref={(el) => {
                    ticks.current[i] = el;
                  }}
                  type="button"
                  tabIndex={i === focusable ? 0 : -1}
                  aria-current={i === current ? "location" : undefined}
                  aria-label={describe(m, i, marks.length, fmt)}
                  onClick={() => jump(i)}
                  onMouseEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover((h) => (h === i ? null : h))}
                  className="group absolute right-0 left-0 flex h-2 -translate-y-1/2 items-center justify-end rounded-[2px] outline-offset-1"
                >
                  {dotClass(m) && <span aria-hidden className={`absolute left-0 size-1 rounded-full max-sm:hidden ${dotClass(m)}`} />}
                  <span
                    data-tick
                    aria-hidden
                    className={`h-0.5 rounded-full transition-[width,background-color] duration-150 group-hover:w-2 group-hover:bg-ink sm:group-hover:w-3 ${i === current ? "w-2 bg-ink sm:w-3" : "w-1 bg-ink-3 sm:w-2"}`}
                  />
                </button>
              </li>
            ))}
          </ol>
          {tip && tipTop && (
            <div
              aria-hidden
              className="pointer-events-none absolute right-5 z-20 hidden w-max max-w-[280px] -translate-y-1/2 rounded-[10px] bg-[var(--tooltip-bg)] px-2.5 py-1.5 text-xs text-[var(--tooltip-fg)] shadow-overlay sm:right-6 sm:block"
              style={{ top: tipTop }}
            >
              <p className="truncate font-medium">{firstLine(tip.text, 70) || "Image"}</p>
              <p className="text-[var(--tooltip-muted)]">{[tip.ts ? dayStamp(tip.ts, fmt) : "", ...flags(tip)].filter(Boolean).join(" · ")}</p>
            </div>
          )}
        </nav>
      )}
      {sheet && (
        <Sheet title="Jump to prompt" onClose={onSheetClose}>
          {marks.length ? (
            <ol className="flex flex-col gap-0.5">
              {marks.map((m, i) => (
                <li key={m.key}>
                  <button
                    type="button"
                    data-autofocus={i === focusable || undefined}
                    aria-current={i === current ? "location" : undefined}
                    onClick={() => {
                      onSheetClose();
                      requestAnimationFrame(() => reveal(m.key));
                    }}
                    className="flex w-full min-w-0 items-start gap-2.5 rounded-[10px] px-2.5 py-2 text-left hover:bg-hover aria-[current=location]:bg-hover pointer-coarse:py-2.5"
                  >
                    <span className="mt-0.5 w-6 shrink-0 text-right text-xs text-ink-3 tabular-nums">{i + 1}</span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm text-ink">{firstLine(m.text) || "Image"}</span>
                      <span className="flex items-center gap-1.5 text-xs text-ink-3">
                        {m.ts ? dayStamp(m.ts, fmt) : null}
                        {flags(m).map((f) => (
                          <span key={f} className={`inline-flex items-center gap-1 ${f === "Failed" ? "text-red-ink" : f === "Waiting on you" ? "text-orange-ink" : "text-accent-ink"}`}>
                            <span aria-hidden>·</span>
                            {f}
                          </span>
                        ))}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="py-6 text-center text-sm text-ink-3">No prompts yet.</p>
          )}
        </Sheet>
      )}
    </>
  );
});
