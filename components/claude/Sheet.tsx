"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Xmark } from "iconoir-react";
import { inertOutside, useOverflow } from "@/lib/client/a11y";

/** A dialog: a centered panel on desktop, a bottom sheet on phones. Escape and the backdrop close it.
 * Everything else on the page is inert while it's open, and focus goes back to the opener on close. */
export function Sheet({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const scrolls = useOverflow(body, "y");
  const headingId = useId();
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const container = root.current;
    const release = container?.parentElement ? inertOutside(container, container.parentElement.children as HTMLCollectionOf<HTMLElement>) : () => {};
    /* focus must leave the page behind (the composer's Esc stops the turn) */
    (panel.current?.querySelector<HTMLElement>("input, textarea, select, button[data-autofocus]") ?? panel.current?.querySelector<HTMLElement>('button[aria-label="Close"]'))?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      release();
      requestAnimationFrame(() => opener?.isConnected && opener.focus({ preventScroll: true }));
    };
  }, []);
  return createPortal(
    <div ref={root} className="fixed inset-0 z-50 flex items-end justify-center sm:items-start sm:px-4 sm:pt-[10vh]">
      <div aria-hidden className="absolute inset-0 touch-none bg-black/40 motion-safe:animate-[fade-in_160ms_ease-out_both]" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`folder-sheet safe-bottom relative flex max-h-[86dvh] w-full flex-col overflow-hidden rounded-t-[22px] bg-surface shadow-overlay sm:max-h-[80vh] sm:rounded-[20px] ${wide ? "sm:max-w-[760px]" : "sm:max-w-[520px]"}`}
      >
        <div aria-hidden className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-line-strong sm:hidden" />
        <div className="flex h-14 shrink-0 items-center gap-2 pr-2.5 pl-5">
          <h2 id={headingId} className="min-w-0 flex-1 truncate text-base font-semibold text-ink">
            {title}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="icon-btn">
            <Xmark width={18} height={18} strokeWidth={1.8} />
          </button>
        </div>
        <div
          ref={body}
          tabIndex={scrolls ? 0 : undefined}
          role={scrolls ? "group" : undefined}
          aria-labelledby={scrolls ? headingId : undefined}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5 focus-visible:[outline-offset:-2px]"
        >
          {children}
        </div>
        {footer && <div className="flex shrink-0 items-center justify-end gap-2 px-5 pt-1 pb-4">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export const fieldBase = "w-full rounded-xl bg-transparent px-3 text-[16px] text-ink shadow-[inset_0_0_0_1px_var(--line-strong)] outline-none transition-shadow duration-150 placeholder:text-ink-3 focus:shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--ink)_40%,transparent)] sm:text-sm";
export const field = `${fieldBase} h-10 sm:h-9`;
export const area = `${fieldBase} py-2 leading-relaxed`;
export const primaryBtn = "tap relative inline-flex h-9 items-center justify-center rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground transition-[background-color,transform] duration-150 hover:bg-primary-hover active:scale-[0.98] disabled:opacity-50";
export const secondaryBtn = "tap relative inline-flex h-9 items-center justify-center rounded-full px-4 text-sm font-medium text-ink shadow-[inset_0_0_0_1px_var(--line-strong)] transition-[background-color,transform] duration-150 hover:bg-hover active:scale-[0.98] disabled:opacity-50";
export const dangerBtn = "tap relative inline-flex h-9 items-center justify-center rounded-full bg-red px-4 text-sm font-medium text-white transition-[filter,transform] duration-150 hover:brightness-110 active:scale-[0.98] disabled:opacity-50";
