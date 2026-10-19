"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ChatPlusIn, ClipboardCheck, Copy, Erase, Search, SelectWindow } from "iconoir-react";

export type TerminalAction = "copy" | "paste" | "select-all" | "clear" | "bottom" | "chat" | "find";

/** The terminal's right-click (or long-press) menu, at the pointer */
export function TerminalMenu({
  at,
  hasSelection,
  findKey,
  onAction,
  onClose,
}: {
  at: { x: number; y: number };
  hasSelection: boolean;
  /** shown next to Find */
  findKey?: string;
  onAction: (action: TerminalAction) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    const w = ref.current?.offsetWidth ?? 220;
    const h = ref.current?.offsetHeight ?? 280;
    const y = at.y + h <= window.innerHeight - 8 ? at.y : at.y - h;
    setPlace({
      position: "fixed",
      left: Math.max(8, Math.min(at.x, window.innerWidth - w - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - h - 8)),
    });
  }, [at]);
  const placed = Boolean(place.position);
  useEffect(() => {
    if (placed) ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
  }, [placed]);
  useEffect(() => {
    const inside = (t: EventTarget | null) => t instanceof Node && Boolean(ref.current?.contains(t));
    const onDown = (e: PointerEvent) => !inside(e.target) && onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" && e.key !== "Tab") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    const onResize = () => onClose();
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("blur", onResize);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("blur", onResize);
    };
  }, [onClose]);
  const icon = { width: 15, height: 15, strokeWidth: 1.9, "aria-hidden": true } as const;
  const item = (action: TerminalAction, label: string, glyph: ReactNode, opts: { disabled?: boolean; hint?: string } = {}) => (
    <button type="button" role="menuitem" disabled={opts.disabled} onClick={() => onAction(action)} className="menu-item disabled:pointer-events-none disabled:opacity-40">
      <span className="flex size-4 shrink-0 items-center justify-center text-ink-3">{glyph}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {opts.hint && <span className="shrink-0 text-[11.5px] text-ink-3 pointer-coarse:hidden">{opts.hint}</span>}
    </button>
  );
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Terminal"
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
        e.preventDefault();
        const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
        const i = items.indexOf(document.activeElement as HTMLElement);
        const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }}
      className="z-[60] w-56 rounded-[12px] bg-surface p-1 shadow-overlay"
      style={{ animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both", ...place, visibility: placed ? "visible" : "hidden" }}
    >
      {item("chat", "Send selection to chat", <ChatPlusIn {...icon} />, { disabled: !hasSelection })}
      {item("copy", "Copy", <Copy {...icon} />, { disabled: !hasSelection })}
      {item("paste", "Paste", <ClipboardCheck {...icon} />)}
      {item("select-all", "Select all", <SelectWindow {...icon} />)}
      <div className="mx-2 my-1 h-px bg-line" />
      {item("find", "Find", <Search {...icon} />, { hint: findKey })}
      {item("bottom", "Scroll to bottom", <ArrowDown {...icon} />)}
      {item("clear", "Clear", <Erase {...icon} />)}
    </div>,
    document.body,
  );
}
