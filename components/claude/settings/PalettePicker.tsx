"use client";

import { useEffect, useState, type KeyboardEvent } from "react";
import { Check } from "iconoir-react";
import { useSetting } from "@/lib/client/settings";
import { PALETTE_BASES, PALETTES, settingDef, type EnumSetting, type PaletteColors, type Settings } from "@/lib/settings-schema";
import { parseCustomTheme } from "@/lib/theme";

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

/** The custom theme's colors over its base palette, for its thumbnail; null until a valid theme is saved. */
export function useCustomColors(dark: boolean): PaletteColors | null {
  const [text] = useSetting("customTheme");
  if (!text) return null;
  const parsed = parseCustomTheme(text, PALETTE_BASES);
  if (!parsed.ok) return null;
  const base = PALETTES.find((p) => p.id === parsed.theme.base) ?? PALETTES[0];
  const own = dark ? parsed.theme.dark : parsed.theme.light;
  const b = dark ? base.dark : base.light;
  return { page: own.page ?? b.page, sidebar: own.sidebar ?? b.sidebar, surface: own.surface ?? b.surface, line: own.line ?? b.line, ink: own.ink ?? b.ink, ink3: own["ink-3"] ?? b.ink3, accent: own.primary ?? own.accent ?? b.accent };
}

/** A thumbnail of the app in a palette: sidebar, a few lines of text and an accent pill. */
export function Thumb({ c }: { c: PaletteColors }) {
  return (
    <span className="flex h-14 w-full overflow-hidden rounded-lg" style={{ background: c.page, boxShadow: `inset 0 0 0 1px ${c.line}` }} aria-hidden>
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

function CustomThumb() {
  return (
    <span
      className="flex h-14 w-full items-center justify-center rounded-lg font-mono text-xs text-ink-3 shadow-[inset_0_0_0_1px_var(--line-strong)] [background:repeating-linear-gradient(135deg,transparent_0_6px,var(--stripe)_6px_7px)]"
      aria-hidden
    >
      {"{ }"}
    </span>
  );
}

export function PalettePicker({ value, onChange }: { value: Settings["palette"]; onChange: (v: Settings["palette"]) => void }) {
  const dark = useDarkClass();
  const custom = useCustomColors(dark);
  const options = (settingDef("palette") as EnumSetting<Settings["palette"]>).options;
  const ids = options.map((o) => o.value);
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
      {options.map((o) => {
        const on = o.value === value;
        const p = PALETTES.find((x) => x.id === o.value);
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={`tap relative flex flex-col gap-1.5 rounded-xl p-1.5 text-left transition-[box-shadow,background-color] duration-150 ${on ? "bg-hover shadow-[0_0_0_1.5px_var(--ink-2)]" : "shadow-[0_0_0_1px_var(--line)] hover:bg-hover"}`}
          >
            {p ? <Thumb c={dark ? p.dark : p.light} /> : custom ? <Thumb c={custom} /> : <CustomThumb />}
            <span className="flex items-center gap-1 px-0.5 text-sm font-medium text-ink">
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {on && <Check width={13} height={13} strokeWidth={2.4} className="shrink-0 text-ink" aria-hidden />}
            </span>
          </button>
        );
      })}
    </div>
  );
}
