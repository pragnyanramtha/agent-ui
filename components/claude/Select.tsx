"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Check, NavArrowDown } from "iconoir-react";
import { field } from "./Sheet";

export type SelectOption = { value: string; label: string; hint?: string; disabled?: boolean };

/** A field-styled trigger with the app's menu, in place of the OS <select> (which ignores the theme). */
export function Select({
  value,
  options,
  onChange,
  disabled,
  label,
  className = "",
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  /** accessible name when no <label> wraps it */
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const items = [...(list.current?.querySelectorAll<HTMLElement>('[role="option"]:not([aria-disabled="true"])') ?? [])];
    (items.find((el) => el.getAttribute("aria-selected") === "true") ?? items[0])?.focus({ preventScroll: true });
    const outside = (t: EventTarget | null) => !(t instanceof Node && root.current?.contains(t));
    const close = (e: Event) => outside(e.target) && setOpen(false);
    document.addEventListener("pointerdown", close);
    document.addEventListener("focusin", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("focusin", close);
    };
  }, [open]);

  const pick = (o: SelectOption) => {
    if (o.disabled) return;
    onChange(o.value);
    setOpen(false);
    button.current?.focus();
  };

  const onListKey = (e: ReactKeyboardEvent) => {
    const items = [...(list.current?.querySelectorAll<HTMLElement>('[role="option"]:not([aria-disabled="true"])') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const to = (n: number) => items[(n + items.length) % items.length]?.focus();
    if (e.key === "ArrowDown") to(i + 1);
    else if (e.key === "ArrowUp") to(i - 1);
    else if (e.key === "Home") to(0);
    else if (e.key === "End") to(items.length - 1);
    else if (e.key === "Escape" || e.key === "Tab") {
      setOpen(false);
      if (e.key === "Escape") button.current?.focus();
      return;
    } else return;
    e.preventDefault();
  };

  return (
    <div ref={root} className={`relative min-w-0 ${className}`}>
      <button
        ref={button}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={label ? `${label}: ${current?.label ?? value}` : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={`${field} flex items-center gap-2 text-left disabled:opacity-60`}
      >
        <span className="min-w-0 flex-1 truncate">{current?.label ?? value}</span>
        <NavArrowDown width={14} height={14} strokeWidth={1.8} className="shrink-0 text-ink-3" aria-hidden />
      </button>
      {open && (
        <div
          ref={list}
          id={id}
          role="listbox"
          aria-label={label}
          onKeyDown={onListKey}
          /* inside a <label>, a click would otherwise be forwarded to the trigger and reopen the list */
          onClick={(e) => e.preventDefault()}
          className="absolute top-full right-0 left-0 z-30 mt-1 max-h-72 min-w-max overflow-y-auto overscroll-contain rounded-[12px] bg-surface p-1 shadow-overlay"
          style={{ animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "top left" }}
        >
          {options.map((o) => (
            <div
              key={o.value}
              role="option"
              tabIndex={-1}
              aria-selected={o.value === value}
              aria-disabled={o.disabled || undefined}
              onClick={() => pick(o)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  pick(o);
                }
              }}
              className={`menu-item cursor-default ${o.disabled ? "opacity-50" : ""}`}
            >
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {o.hint && <span className="shrink-0 text-xs text-ink-3">{o.hint}</span>}
              <Check width={14} height={14} strokeWidth={2} className={`shrink-0 ${o.value === value ? "text-ink-2" : "invisible"}`} aria-hidden />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
