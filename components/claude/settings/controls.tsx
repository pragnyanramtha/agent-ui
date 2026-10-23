"use client";

import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, NavArrowDown } from "iconoir-react";
import { Switch as UiSwitch } from "@/components/ui/switch";
import { Select as UiSelect, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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

/** A titled group of rows: a quiet heading, then rows split by hairlines. No box around it. */
export function Card({ title, children, footer }: { title?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className="flex flex-col">
      {title && <h3 className="pb-1 text-sm font-medium text-ink-2">{title}</h3>}
      <div className="flex flex-col divide-y divide-line">{children}</div>
      {footer && <div className="pt-1 text-xs leading-relaxed text-ink-3">{footer}</div>}
    </section>
  );
}

/** One setting: label and note on the left, the control on the right (below it when there isn't room). */
export function Row({ label, note, htmlFor, children, wide }: { label: ReactNode; note?: ReactNode; htmlFor?: string; children?: ReactNode; wide?: boolean }) {
  const Label = htmlFor ? "label" : "div";
  return (
    <div className={cn("flex min-h-14 flex-wrap items-center gap-x-6 gap-y-3 py-3", wide && "flex-col items-stretch")}>
      <div className="min-w-[min(100%,14rem)] flex-1">
        <Label htmlFor={htmlFor} className="block text-base text-ink">
          {label}
        </Label>
        {note && <div className="mt-0.5 text-sm leading-snug text-ink-3">{note}</div>}
      </div>
      {children !== undefined && <div className={wide ? "min-w-0" : "ml-auto max-w-full shrink-0"}>{children}</div>}
    </div>
  );
}

/** An on/off switch (Radix): role="switch", Space toggles, a 44px hit area on touch. */
export function Switch({ checked, onChange, label, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; id?: string }) {
  return <UiSwitch id={id} checked={checked} onCheckedChange={onChange} aria-label={label} disabled={disabled} className="pointer-coarse:after:-inset-3.5" />;
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

/** A segmented control: a soft track with the chosen option raised. */
export function Segmented<T extends string | number>({ value, options, onChange, label }: { value: T; options: readonly { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={radioKeys(options.map((o) => o.value), value, onChange)} className="seg inline-flex max-w-full flex-wrap gap-0.5 rounded-lg bg-field p-0.5">
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
            className={cn(
              "tap relative h-7 rounded-md px-3 text-sm whitespace-nowrap transition-colors duration-150 pointer-coarse:h-8",
              on ? "seg-on font-medium text-ink" : "text-ink-2 hover:text-ink",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

const FIELD = "relative inline-flex h-8 min-w-[10rem] items-center gap-2 rounded-lg bg-field pr-2 pl-3 text-left text-sm text-ink hover:bg-hover-2 pointer-coarse:h-10";

/* Radix Select can't hold an empty value; "" (a "none" choice) travels under this name */
const EMPTY = "__none__";
const enc = (v: string) => (v === "" ? EMPTY : v);
const dec = (v: string) => (v === EMPTY ? "" : v);

/** A dropdown: the browser's own picker on touch screens, a Radix listbox elsewhere. */
export function Select<T extends string>({ value, options, onChange, label, id }: { value: T; options: readonly { value: T; label: string }[]; onChange: (v: T) => void; label: string; id?: string }) {
  const touch = useMediaQuery("(pointer: coarse)");
  const current = options.find((o) => o.value === value) ?? options[0];
  if (touch) {
    return (
      <span className="relative inline-flex">
        <select id={id} aria-label={label} value={value} onChange={(e) => onChange(e.target.value as T)} className={cn(FIELD, "appearance-none pr-8 text-[16px]")}>
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
  return (
    <UiSelect value={enc(current?.value ?? value)} onValueChange={(v) => onChange(dec(v) as T)}>
      <SelectTrigger id={id} aria-label={`${label}: ${current?.label ?? ""}`} className="h-8! min-w-[10rem] rounded-lg border-0 bg-field pr-2 pl-3 text-ink hover:bg-hover-2 dark:bg-field dark:hover:bg-hover-2 [&>svg]:text-ink-3">
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" align="end" sideOffset={4} className="min-w-(--radix-select-trigger-width) rounded-xl p-1 shadow-overlay ring-line">
        {options.map((o) => (
          <SelectItem key={o.value} value={enc(o.value)} className="h-8 rounded-lg pl-2.5 text-sm">
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </UiSelect>
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
        style={{ "--fill": `${pct}%`, "--track": track ?? `linear-gradient(to right, var(--primary) ${pct}%, var(--line-strong) ${pct}%)` } as React.CSSProperties}
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
            className={`tap relative flex size-7 items-center justify-center rounded-full transition-[box-shadow] duration-150 ${on ? "shadow-[0_0_0_2px_var(--page),0_0_0_4px_var(--ink-2)]" : "hover:shadow-[0_0_0_2px_var(--page),0_0_0_4px_var(--line-strong)]"}`}
          >
            <span className="size-6 rounded-full shadow-[inset_0_0_0_1px_oklch(0_0_0/0.12)]" style={{ background: o.color }} />
            {on && <Check width={13} height={13} strokeWidth={2.6} className="absolute text-white mix-blend-normal drop-shadow-[0_0_1px_oklch(0_0_0/0.6)]" aria-hidden />}
          </button>
        );
      })}
    </div>
  );
}

/** A small pill button: outlined by default, red text for destructive, ink-filled for the one action that applies. */
export function SmallButton({ children, onClick, tone, disabled, type = "button" }: { children: ReactNode; onClick?: () => void; tone?: "danger" | "accent"; disabled?: boolean; type?: "button" | "submit" }) {
  return (
    <Button
      type={type}
      onClick={onClick}
      disabled={disabled}
      variant={tone === "accent" ? "default" : "outline"}
      className={cn(
        "tap relative h-8 rounded-full px-3.5 pointer-coarse:h-9 [&_svg]:size-3.5!",
        tone === "accent" ? "hover:bg-primary-hover" : "border-line-strong bg-transparent hover:bg-hover dark:border-line-strong dark:bg-transparent dark:hover:bg-hover",
        tone === "danger" && "text-red-ink hover:text-red-ink",
      )}
    >
      {children}
    </Button>
  );
}
