"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Xmark } from "iconoir-react";

/** A dialog: a centered panel on desktop, a bottom sheet on phones. Escape and the backdrop close it. */
export function Sheet({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    /* focus must leave the page behind (the composer's Esc stops the turn) */
    (panel.current?.querySelector<HTMLElement>("input, textarea, select, button[data-autofocus]") ?? panel.current?.querySelector<HTMLElement>('button[aria-label="Close"]'))?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      requestAnimationFrame(() => opener?.isConnected && opener.focus({ preventScroll: true }));
    };
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-start sm:px-4 sm:pt-[10vh]">
      <div aria-hidden className="absolute inset-0 touch-none bg-black/40 motion-safe:animate-[fade-in_160ms_ease-out_both]" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`folder-sheet safe-bottom relative flex max-h-[86dvh] w-full flex-col overflow-hidden rounded-t-[18px] bg-surface shadow-overlay sm:max-h-[80vh] sm:rounded-[14px] ${wide ? "sm:max-w-[760px]" : "sm:max-w-[520px]"}`}
      >
        <div aria-hidden className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-line-strong sm:hidden" />
        <div className="flex h-12 shrink-0 items-center gap-2 pr-2 pl-4">
          <h2 className="min-w-0 flex-1 truncate text-[14.5px] font-semibold text-ink">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="icon-btn">
            <Xmark width={18} height={18} strokeWidth={1.8} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">{children}</div>
        {footer && <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export const fieldBase = "w-full rounded-[9px] bg-inset px-3 text-[16px] text-ink shadow-hairline outline-none placeholder:text-ink-3 focus:ring-2 focus:ring-accent/30 sm:text-[13.5px]";
export const field = `${fieldBase} h-10 sm:h-9`;
export const area = `${fieldBase} py-2 leading-relaxed`;
export const primaryBtn = "tap relative inline-flex h-9 items-center justify-center rounded-full bg-ink px-4 text-[13px] font-medium text-page transition-opacity duration-150 hover:opacity-90 disabled:opacity-50";
export const secondaryBtn = "tap relative inline-flex h-9 items-center justify-center rounded-full px-3.5 text-[13px] font-medium text-ink shadow-btn transition-colors duration-150 hover:bg-hover disabled:opacity-50";
