"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useSetting } from "@/lib/client/settings";
import { parseColor, readableOn, toHex } from "@/lib/color";
import { PALETTE_BASES, PALETTES, parseValue, settingDef } from "@/lib/settings-schema";
import { MAX_THEME_LENGTH, parseCustomTheme, themeTemplate } from "@/lib/theme";
import { SmallButton } from "./controls";

const FIELD = "field-ring rounded-lg border border-transparent bg-field text-ink outline-none";

/** The label color a custom accent gets on filled buttons (white or near-black, whichever reads). */
export function labelOn(color: string): string {
  const c = parseColor(color);
  return c ? toHex(readableOn(c.rgb)) : "#ffffff";
}

/** A color setting: the browser's picker, the hex code, and a sample button in that color. */
export function ColorField({ k, id }: { k: "accentColor"; id?: string }) {
  const [value, set] = useSetting(k);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const def = settingDef(k);
  const bad = !parseValue(def, draft).ok;
  return (
    <span className="flex flex-wrap items-center gap-2">
      <input type="color" aria-label={`${def.label} picker`} value={value} onChange={(e) => set(e.target.value)} className="tap relative h-8 w-10 cursor-pointer rounded-lg border border-transparent bg-field p-0.5" />
      <input
        id={id}
        type="text"
        value={draft}
        maxLength={7}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={bad || undefined}
        onChange={(e) => {
          setDraft(e.target.value);
          const parsed = parseValue(def, e.target.value);
          if (parsed.ok) set(parsed.value as string);
        }}
        onBlur={() => setDraft(value)}
        className={`${FIELD} h-8 w-24 px-2.5 font-mono text-sm uppercase aria-invalid:border-red`}
      />
      <span className="inline-flex h-7 items-center rounded-full px-3 text-xs font-medium" style={{ background: value, color: labelOn(value) }} aria-hidden>
        Send
      </span>
    </span>
  );
}

/** The custom theme: pasted JSON, checked as you type, applied on demand. */
export function CustomThemeField({ id }: { id?: string }) {
  const [saved, save] = useSetting("customTheme");
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);
  const noteId = useId();
  const result = useMemo(() => (draft.trim() ? parseCustomTheme(draft, PALETTE_BASES) : null), [draft]);
  const dirty = draft !== saved;
  const apply = () => {
    if (result?.ok || !draft.trim()) save(draft.trim() ? draft : "");
  };
  const template = () => {
    const base = PALETTES[0];
    setDraft(themeTemplate(base.id, { light: base.light, dark: base.dark }));
  };
  return (
    <div className="flex flex-col gap-2">
      <textarea
        id={id}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            apply();
          }
        }}
        rows={9}
        maxLength={MAX_THEME_LENGTH}
        spellCheck={false}
        autoComplete="off"
        aria-describedby={noteId}
        aria-invalid={result?.ok === false || undefined}
        placeholder={'{\n  "base": "graphite",\n  "accent": "#ff7a59",\n  "dark": { "page": "#0b0b0c" }\n}'}
        className={`${FIELD} min-h-40 w-full resize-y px-3 py-2 font-mono text-xs leading-relaxed placeholder:text-ink-3 aria-invalid:border-red`}
      />
      <div id={noteId} aria-live="polite" className="flex flex-col gap-1 text-xs leading-relaxed">
        {result?.ok === false && result.errors.map((e) => <p key={e} className="text-red-ink">{e}</p>)}
        {result?.ok && result.warnings.map((w) => <p key={w} className="text-orange-ink">{w}</p>)}
        {result?.ok && !result.warnings.length && <p className="text-ink-3">{dirty ? "Looks good. Apply to use it." : "In use."}</p>}
        {!result && <p className="text-ink-3">Tokens: page, sidebar, surface, field, line, ink, ink-2, ink-3, accent, primary, green, red and more. Top-level tokens apply to both modes; &quot;light&quot; and &quot;dark&quot; override one.</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SmallButton tone="accent" onClick={apply} disabled={!dirty || result?.ok === false}>
          Apply
        </SmallButton>
        <SmallButton onClick={template}>Start from Default</SmallButton>
        {dirty && saved && <SmallButton onClick={() => setDraft(saved)}>Discard changes</SmallButton>}
      </div>
    </div>
  );
}
