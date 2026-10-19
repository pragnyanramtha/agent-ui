"use client";

import { useEffect, useState, type KeyboardEvent } from "react";
import { Check } from "iconoir-react";
import { PALETTES, type PaletteColors, type Settings } from "@/lib/settings-schema";

/** True while <html> has the dark class (follows System too). */
export function useDarkClass() {
  const [dark, setDark] = useState(true);
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setDark(root.classList.contains("dark"));
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);
  return dark;
}

/** A thumbnail of the app in a palette: sidebar, a few lines of text and an accent pill. */
function Thumb({ c }: { c: PaletteColors }) {
  return (
    <span className="flex h-14 w-full overflow-hidden rounded-[calc(var(--radius-card)-3px)]" style={{ background: c.page, boxShadow: `inset 0 0 0 1px ${c.line}` }} aria-hidden>
      <span className="flex w-1/4 flex-col gap-1 p-1.5" style={{ background: c.sidebar }}>
        <span className="h-1 w-3/4 rounded-full" style={{ background: c.ink3, opacity: 0.6 }} />
        <span className="h-1 w-1/2 rounded-full" style={{ background: c.ink3, opacity: 0.6 }} />
        <span className="h-1 w-2/3 rounded-full" style={{ background: c.ink3, opacity: 0.6 }} />
      </span>
      <span className="flex flex-1 flex-col justify-between p-1.5">
        <span className="ml-auto h-2.5 w-1/2 rounded-[3px]" style={{ background: c.surface, boxShadow: `0 0 0 1px ${c.line}` }} />
        <span className="flex flex-col gap-1">
          <span className="h-1 w-5/6 rounded-full" style={{ background: c.ink }} />
          <span className="h-1 w-2/3 rounded-full" style={{ background: c.ink3 }} />
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-6 rounded-full" style={{ background: c.accent }} />
          <span className="h-1 w-1/3 rounded-full" style={{ background: c.ink3, opacity: 0.6 }} />
        </span>
      </span>
    </span>
  );
}

export function PalettePicker({ value, onChange }: { value: Settings["palette"]; onChange: (v: Settings["palette"]) => void }) {
  const dark = useDarkClass();
  const ids = PALETTES.map((p) => p.id);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = ids.indexOf(value);
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const j = (i + step + ids.length) % ids.length;
    onChange(ids[j]);
    e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[j]?.focus();
  };
  return (
    <div role="radiogroup" aria-label="Palette" onKeyDown={onKey} className="grid grid-cols-2 gap-2 min-[480px]:grid-cols-3 sm:grid-cols-4">
      {PALETTES.map((p) => {
        const on = p.id === value;
        return (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(p.id)}
            className={`tap relative flex flex-col gap-1.5 rounded-card p-1.5 text-left transition-[box-shadow,background-color] duration-150 ${on ? "bg-accent-tint shadow-[0_0_0_1.5px_var(--accent)]" : "shadow-hairline hover:bg-hover"}`}
          >
            <Thumb c={dark ? p.dark : p.light} />
            <span className="flex items-center gap-1 px-0.5 text-[12.5px] font-medium text-ink">
              <span className="min-w-0 flex-1 truncate">{p.label}</span>
              {on && <Check width={13} height={13} strokeWidth={2.4} className="shrink-0 text-accent-ink" aria-hidden />}
            </span>
          </button>
        );
      })}
    </div>
  );
}
