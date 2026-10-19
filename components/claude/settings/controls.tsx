"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, NavArrowDown } from "iconoir-react";

/* The controls every settings section is built from. Each is keyboard reachable and labelled; radio groups move
 * with the arrow keys, the select opens with Enter, Space or the arrows. */

export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return matches;
}

/** A titled card of rows, hairline-divided. */
export function Card({ title, children, footer }: { title?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className="flex flex-col">
      {title && <h3 className="px-1 pb-2 text-xs font-medium text-ink-3">{title}</h3>}
      <div className="divide-y divide-line rounded-card border border-line bg-surface">{children}</div>
      {footer && <div className="px-1 pt-2 text-xs text-ink-3">{footer}</div>}
    </section>
  );
}

/** One setting: label and note on the left, the control on the right (below it when there isn't room). */
export function Row({ label, note, htmlFor, children, wide }: { label: ReactNode; note?: ReactNode; htmlFor?: string; children?: ReactNode; wide?: boolean }) {
  const Label = htmlFor ? "label" : "div";
  return (
    <div className={`flex min-h-12 flex-wrap items-center gap-x-4 gap-y-2.5 px-3.5 py-2.5 ${wide ? "flex-col items-stretch" : ""}`}>
      <div className="min-w-[min(100%,12rem)] flex-1">
        <Label htmlFor={htmlFor} className="block text-sm text-ink">
          {label}
        </Label>
        {note && <div className="mt-0.5 text-xs leading-relaxed text-ink-3">{note}</div>}
      </div>
      {children !== undefined && <div className={wide ? "min-w-0" : "ml-auto max-w-full shrink-0"}>{children}</div>}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; id?: string }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`tap relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-150 disabled:opacity-50 ${checked ? "bg-primary" : "bg-line-strong"}`}
    >
      <span className={`size-4 rounded-full bg-white shadow-sm transition-transform duration-150 ${checked ? "translate-x-[18px]" : "translate-x-0.5"}`} />
    </button>
  );
}

/** Arrow keys, Home and End for a radio group: moves the choice and the focus together. */
function radioKeys<T>(values: readonly T[], value: T, onChange: (v: T) => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    const i = values.indexOf(value);
    const n = values.length;
    const next = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: n - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const j = ((next % n) + n) % n;
    onChange(values[j]);
    e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[j]?.focus();
  };
}

export function Segmented<T extends string | number>({ value, options, onChange, label }: { value: T; options: readonly { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={radioKeys(options.map((o) => o.value), value, onChange)} className="inline-flex max-w-full flex-wrap rounded-control bg-field p-0.5">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={`tap relative h-7 rounded-[calc(var(--radius-control)-2px)] px-2.5 text-sm font-medium whitespace-nowrap transition-colors duration-150 ${on ? "bg-surface text-ink shadow-btn" : "text-ink-3 hover:text-ink-2"}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

const FIELD = "tap relative inline-flex h-8 min-w-[10rem] items-center gap-2 rounded-control bg-field pr-2 pl-3 text-left text-sm text-ink shadow-hairline hover:bg-hover-2";

/** A dropdown: the browser's own picker on touch screens, a listbox elsewhere. */
export function Select<T extends string>({ value, options, onChange, label, id }: { value: T; options: readonly { value: T; label: string }[]; onChange: (v: T) => void; label: string; id?: string }) {
  const touch = useMediaQuery("(pointer: coarse)");
  const current = options.find((o) => o.value === value) ?? options[0];
  if (touch) {
    return (
      <span className="relative inline-flex">
        <select id={id} aria-label={label} value={value} onChange={(e) => onChange(e.target.value as T)} className={`${FIELD} appearance-none pr-8`}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <NavArrowDown width={14} height={14} strokeWidth={2} className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-ink-3" aria-hidden />
      </span>
    );
  }
  return <Listbox value={value} options={options} onChange={onChange} label={label} id={id} current={current} />;
}

function Listbox<T extends string>({ value, options, onChange, label, id, current }: { value: T; options: readonly { value: T; label: string }[]; onChange: (v: T) => void; label: string; id?: string; current: { value: T; label: string } }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const uid = useId();
  const show = () => {
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  const pick = (i: number) => {
    onChange(options[i].value);
    close(true);
  };
  useEffect(() => {
    if (!open) return;
    list.current?.focus();
    const away = (e: PointerEvent) => {
      if (!list.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const n = options.length;
    if (e.key === "ArrowDown") setActive((a) => Math.min(n - 1, a + 1));
    else if (e.key === "ArrowUp") setActive((a) => Math.max(0, a - 1));
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(n - 1);
    else if (e.key === "Enter" || e.key === " ") pick(active);
    else if (e.key === "Escape") close(true);
    else if (e.key === "Tab") return close(false);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <span className="relative inline-flex">
      <button
        ref={button}
        id={id}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${current.label}`}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            show();
          }
        }}
        className={FIELD}
      >
        <span className="min-w-0 flex-1 truncate">{current.label}</span>
        <NavArrowDown width={14} height={14} strokeWidth={2} className="shrink-0 text-ink-3" aria-hidden />
      </button>
      {open && (
        <ul
          ref={list}
          role="listbox"
          tabIndex={-1}
          aria-label={label}
          aria-activedescendant={`${uid}-${active}`}
          onKeyDown={onListKey}
          className="composer-menu absolute top-full right-0 z-30 mt-1 min-w-full rounded-card bg-surface p-1 shadow-overlay outline-none"
        >
          {options.map((o, i) => (
            <li
              key={o.value}
              id={`${uid}-${i}`}
              role="option"
              aria-selected={o.value === value}
              onPointerEnter={() => setActive(i)}
              onClick={() => pick(i)}
              className={`flex h-8 cursor-pointer items-center gap-2 rounded-[calc(var(--radius-card)-4px)] pr-2 pl-2.5 text-sm whitespace-nowrap text-ink ${i === active ? "bg-hover" : ""}`}
            >
              <span className="flex-1">{o.label}</span>
              {o.value === value && <Check width={14} height={14} strokeWidth={2} className="text-accent-ink" aria-hidden />}
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}

/** A range with its value beside it. */
export function Slider({ value, min, max, step, onChange, label, format, track, id }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; label: string; format?: (v: number) => string; track?: string; id?: string }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <span className="flex w-full min-w-[11rem] items-center gap-3 sm:w-56">
      <input
        id={id}
        type="range"
        aria-label={label}
        aria-valuetext={format?.(value)}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="settings-range h-5 min-w-0 flex-1"
        style={{ "--fill": `${pct}%`, ...(track ? { "--track": track } : {}) } as React.CSSProperties}
      />
      <output className="w-12 shrink-0 text-right text-sm text-ink-2 tabular-nums">{format ? format(value) : value}</output>
    </span>
  );
}

export type Swatch<T extends string> = { value: T; label: string; color: string; ring?: string };

/** Color dots as a radio group. */
export function Swatches<T extends string>({ value, options, onChange, label }: { value: T; options: readonly Swatch<T>[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={radioKeys(options.map((o) => o.value), value, onChange)} className="flex flex-wrap items-center gap-1.5">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={o.label}
            data-tip={o.label}
            data-tip-pos="bottom"
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={`tap relative flex size-7 items-center justify-center rounded-full transition-[box-shadow] duration-150 ${on ? "shadow-[0_0_0_2px_var(--surface),0_0_0_4px_var(--ink-3)]" : "hover:shadow-[0_0_0_2px_var(--surface),0_0_0_4px_var(--line-strong)]"}`}
          >
            <span className="size-6 rounded-full shadow-[inset_0_0_0_1px_oklch(0_0_0/0.12)]" style={{ background: o.color }} />
            {on && <Check width={13} height={13} strokeWidth={2.6} className="absolute text-white mix-blend-normal drop-shadow-[0_0_1px_oklch(0_0_0/0.6)]" aria-hidden />}
          </button>
        );
      })}
    </div>
  );
}

export function SmallButton({ children, onClick, tone, disabled, type = "button" }: { children: ReactNode; onClick?: () => void; tone?: "danger" | "accent"; disabled?: boolean; type?: "button" | "submit" }) {
  const color = tone === "danger" ? "text-red-ink shadow-btn hover:bg-hover" : tone === "accent" ? "bg-primary text-primary-foreground hover:bg-primary-hover" : "text-ink shadow-btn hover:bg-hover";
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`tap relative inline-flex h-8 shrink-0 items-center gap-1.5 rounded-control px-3 text-sm font-medium whitespace-nowrap disabled:opacity-50 ${color}`}>
      {children}
    </button>
  );
}
