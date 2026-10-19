"use client";

import { useEffect } from "react";

type Viewport = { innerHeight: number; height: number; offsetTop: number; scale: number };

/** How much of the layout viewport the on-screen keyboard covers, in px. Only a focused field brings up a
 * keyboard; a pinch-zoomed viewport is small because of the zoom, not a keyboard. */
export function keyboardInset(v: Viewport, editing: boolean): number {
  /* scale drifts a hair off 1 on some browsers at rest */
  if (!editing || v.scale > 1.01) return 0;
  const covered = Math.max(0, Math.round(v.innerHeight - v.height - v.offsetTop));
  /* small differences are toolbars sliding, not a keyboard */
  return covered > 80 ? covered : 0;
}

const NOT_TYPED = new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]);

const isEditable = (el: Element | null): boolean =>
  el instanceof HTMLElement && (el.isContentEditable || el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !NOT_TYPED.has((el as HTMLInputElement).type)));

/* iOS Safari ignores `interactive-widget=resizes-content`: the on-screen keyboard covers the bottom of the page
 * instead of shrinking it. This keeps `--kb` on <html> at the height it covers (0 where the browser resizes the
 * page itself), so the shell and sheets can end above it. */
export function useKeyboardInset() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const kb = keyboardInset({ innerHeight: window.innerHeight, height: vv.height, offsetTop: vv.offsetTop, scale: vv.scale }, isEditable(document.activeElement));
        document.documentElement.style.setProperty("--kb", `${kb}px`);
      });
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    return () => {
      cancelAnimationFrame(frame);
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
      document.documentElement.style.removeProperty("--kb");
    };
  }, []);
}
