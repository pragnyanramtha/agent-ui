"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Check, Copy, QuoteMessage } from "iconoir-react";
import { sendToComposer } from "@/lib/client/composer-insert";
import { askText, selectionBlock } from "@/lib/client/quote";
import { comboFor, isCommand, isTyping, modalOpen } from "@/lib/client/shortcuts";
import { toast } from "@/lib/client/toast";
import { copyText } from "./CodeCard";

type Picked = { range: Range; text: string; block: string; touch: boolean };

/* mouse: as soon as the button comes up; touch: once the handles stop moving, after the system menu has shown */
const SETTLE_MS = { mouse: 30, keys: 200, touch: 450 } as const;
const GAP = 8;
/* room for the selection handles a phone draws under the last line */
const HANDLES = 30;

const elementOf = (n: Node | null) => (n instanceof Element ? n : (n?.parentElement ?? null));

/** The selection, when it sits inside one reply of this thread. */
function pick(root: HTMLElement | null, touch: boolean): Picked | null {
  const sel = typeof window === "undefined" ? null : window.getSelection();
  if (!root || !sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const start = elementOf(range.startContainer);
  const end = elementOf(range.endContainer);
  const reply = start?.closest("[data-reply]");
  if (!reply || !root.contains(reply) || end?.closest("[data-reply]") !== reply) return null;
  const text = sel.toString();
  const card = start?.closest("[data-code-card]");
  const block = selectionBlock(text, card && card === end?.closest("[data-code-card]") ? { lang: card.getAttribute("data-lang") } : null);
  return block ? { range: range.cloneRange(), text, block, touch } : null;
}

/**
 * Selecting text in a reply shows a small bar by it: Ask about this (the selection goes into the composer as a quote,
 * or a fenced block when it's code) and Copy. With a mouse it sits above the selection; on touch it waits for the
 * selection to settle and sits below it, clear of the system's own menu. Mod+Shift+L does the same from the keyboard.
 */
export function SelectionAsk({ scroller }: { scroller: RefObject<HTMLElement | null> }) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [copied, setCopied] = useState(false);
  const bar = useRef<HTMLDivElement>(null);
  const pickedRef = useRef(picked);
  pickedRef.current = picked;

  const place = useCallback(() => {
    const el = bar.current;
    const p = pickedRef.current;
    const box = scroller.current?.getBoundingClientRect();
    if (!el || !p || !box) return;
    const rects = [...p.range.getClientRects()].filter((r) => r.width || r.height);
    const first = rects[0];
    const last = rects[rects.length - 1];
    if (!first || last.bottom < box.top || first.top > box.bottom) {
      el.style.visibility = "hidden";
      return;
    }
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const above = first.top - GAP - h;
    const below = last.bottom + GAP + (p.touch ? HANDLES : 0);
    const top = p.touch ? (below + h <= box.bottom - GAP ? below : Math.max(box.top + GAP, above - HANDLES * 2)) : above >= box.top + GAP ? above : Math.min(below, box.bottom - h - GAP);
    const anchor = p.touch ? last.left + last.width / 2 : first.left + first.width / 2;
    const left = Math.min(Math.max(anchor - w / 2, box.left + GAP), box.right - w - GAP);
    el.style.visibility = "visible";
    el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }, [scroller]);

  useLayoutEffect(() => {
    if (picked) place();
  }, [picked, place]);

  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let mouseDown = false;
    let lastTouch = false;
    const read = (delay: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (mouseDown) return;
        const next = pick(root, lastTouch);
        setPicked((cur) => (next && cur && next.block === cur.block ? { ...cur, range: next.range } : next));
        setCopied(false);
      }, delay);
    };
    const onDown = (e: PointerEvent) => {
      if (bar.current?.contains(e.target as Node)) return;
      lastTouch = e.pointerType !== "mouse";
      mouseDown = e.pointerType === "mouse";
      if (mouseDown) setPicked(null);
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || !mouseDown) return;
      mouseDown = false;
      read(SETTLE_MS.mouse);
    };
    const onChange = () => {
      if (mouseDown) return;
      read(lastTouch ? SETTLE_MS.touch : SETTLE_MS.keys);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Shift" || e.key.startsWith("Arrow")) lastTouch = false;
      if (e.key === "Escape" && pickedRef.current && !e.defaultPrevented && !modalOpen()) setPicked(null);
    };
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(place);
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("selectionchange", onChange);
    window.addEventListener("keydown", onKey);
    root.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("selectionchange", onChange);
      window.removeEventListener("keydown", onKey);
      root.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [scroller, place]);

  const ask = useCallback((p: Picked) => {
    if (!sendToComposer(askText(p.block))) {
      toast({ title: "There's no message box to add it to.", tone: "warning", key: "ask-selection" });
      return;
    }
    window.getSelection()?.removeAllRanges();
    setPicked(null);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || isTyping(e.target) || modalOpen() || !isCommand(e, "askSelection")) return;
      const p = pick(scroller.current, false);
      if (!p) return;
      e.preventDefault();
      ask(p);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scroller, ask]);

  if (!picked) return null;
  const combo = comboFor("askSelection");
  /* a press on the bar mustn't take the selection away with it */
  const keep = (e: React.PointerEvent) => e.pointerType === "mouse" && e.preventDefault();
  const btn =
    "tap relative flex h-8 items-center gap-1.5 rounded-[8px] px-2.5 text-sm font-medium transition-colors duration-100 hover:bg-hover pointer-coarse:h-10 pointer-coarse:px-3";
  return (
    <div
      ref={bar}
      role="toolbar"
      aria-label="Selected text"
      className="fixed top-0 left-0 z-30 flex items-center gap-0.5 rounded-[11px] bg-surface p-0.5 text-ink shadow-overlay"
      style={{ visibility: "hidden" }}
    >
      <div className="flex items-center gap-0.5" style={{ animation: "pop-in 140ms cubic-bezier(0.23,1,0.32,1) both" }}>
        <button type="button" onPointerDown={keep} onClick={() => ask(picked)} data-tip={combo ? `Ask about this (${combo})` : undefined} className={btn}>
          <QuoteMessage width={15} height={15} strokeWidth={1.8} className="text-ink-3" aria-hidden />
          Ask about this
        </button>
        <button
          type="button"
          onPointerDown={keep}
          onClick={() =>
            void copyText(picked.text).then((ok) => {
              if (!ok) return toast({ title: "Couldn't copy.", tone: "error", key: "copy-selection" });
              setCopied(true);
              setTimeout(() => setPicked(null), 900);
            })
          }
          className={`${btn} ${copied ? "text-green" : ""}`}
        >
          {copied ? <Check width={15} height={15} strokeWidth={2} aria-hidden /> : <Copy width={15} height={15} strokeWidth={1.8} className="text-ink-3" aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
