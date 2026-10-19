"use client";

import { useId, type ReactNode } from "react";
import { useSetting, useSettings } from "@/lib/client/settings";
import { ACCENTS, PALETTES, settingDef, type EnumSetting, type NumberSetting, type SettingKey, type Settings } from "@/lib/settings-schema";
import { Row, Segmented, Select, Slider, Swatches, Switch } from "./controls";
import { PalettePicker, useCustomColors, useDarkClass } from "./PalettePicker";
import { ColorField, CustomThemeField } from "./ThemeFields";

const fmt = (d: NumberSetting) => (v: number) => `${v}${d.unit ?? ""}`;

/** The control for one registry setting, picked from its type (or its `control` hint). */
export function SettingControl<K extends SettingKey>({ k, id }: { k: K; id?: string }) {
  const def = settingDef(k);
  const [value, set] = useSetting(k);
  const setAny = set as (v: unknown) => void;
  switch (def.type) {
    case "boolean":
      return <Switch id={id} checked={value as boolean} onChange={setAny} label={def.label} />;
    case "enum": {
      const d = def as EnumSetting;
      if (d.control === "select" || (!d.control && d.options.length > 4)) return <Select id={id} value={value as string} options={d.options} onChange={setAny} label={def.label} />;
      if (d.control === "swatches") return <AccentSwatches value={value as Settings["accent"]} onChange={setAny} />;
      if (d.control === "palette") return <PalettePicker value={value as Settings["palette"]} onChange={setAny} />;
      return <Segmented value={value as string} options={d.options} onChange={setAny} label={def.label} />;
    }
    case "number": {
      const d = def as NumberSetting;
      if (d.control === "segmented") {
        const steps = Array.from({ length: Math.round((d.max - d.min) / d.step) + 1 }, (_, i) => d.min + i * d.step);
        return <Segmented value={value as number} options={steps.map((v) => ({ value: v, label: fmt(d)(v) }))} onChange={setAny} label={def.label} />;
      }
      const track = d.control === "hue" ? "linear-gradient(to right in oklch longer hue, oklch(0.62 0.17 0), oklch(0.62 0.17 359.9))" : undefined;
      return <Slider id={id} value={value as number} min={d.min} max={d.max} step={d.step} onChange={setAny} label={def.label} format={fmt(d)} track={track} />;
    }
    case "string":
      if (def.control === "theme-json") return <CustomThemeField id={id} />;
      return <input id={id} type="text" value={value as string} maxLength={def.maxLength} placeholder={def.placeholder} onChange={(e) => setAny(e.target.value)} className="field-ring h-8 w-56 rounded-control border border-line bg-field px-2.5 text-sm text-ink outline-none" />;
    case "color":
      return <ColorField k={k as "accentColor"} id={id} />;
  }
}

/** A registry setting as a row: its label, description and control. Hidden while its `showIf` doesn't hold. */
export function SettingField({ k, note }: { k: SettingKey; note?: ReactNode }) {
  const def = settingDef(k);
  const values = useSettings();
  const id = useId();
  if (def.showIf && values[def.showIf[0] as SettingKey] !== def.showIf[1]) return null;
  const wide = (def.type === "enum" && (def.control === "palette" || def.control === "swatches")) || (def.type === "string" && def.control === "theme-json");
  /* switches and native fields take a <label>; groups name themselves with aria-label */
  const labelled = def.type === "boolean" || def.type === "string" || def.type === "color" || (def.type === "enum" && def.control === "select") || (def.type === "number" && def.control !== "segmented");
  return (
    <Row label={def.label} note={note ?? def.description} htmlFor={labelled ? id : undefined} wide={wide}>
      <SettingControl k={k} id={id} />
    </Row>
  );
}

export const accentColor = (value: string, dark: boolean) => {
  if (value === "neutral") return dark ? "oklch(0.82 0 0)" : "oklch(0.35 0 0)";
  const a = ACCENTS.find((x) => x.value === value);
  return `oklch(${dark ? 0.7 : 0.58} ${0.17 * (a?.chroma ?? 1)} ${a?.hue ?? 256})`;
};

const RAINBOW = "conic-gradient(from 0deg, oklch(0.65 0.17 0), oklch(0.65 0.17 60), oklch(0.65 0.17 120), oklch(0.65 0.17 180), oklch(0.65 0.17 240), oklch(0.65 0.17 300), oklch(0.65 0.17 360))";

function AccentSwatches({ value, onChange }: { value: Settings["accent"]; onChange: (v: Settings["accent"]) => void }) {
  const [palette] = useSetting("palette");
  const [lightPalette] = useSetting("lightPalette");
  const [custom] = useSetting("accentColor");
  const dark = useDarkClass();
  const customColors = useCustomColors(dark);
  const id = !dark && lightPalette !== "same" ? lightPalette : palette;
  const pal = PALETTES.find((p) => p.id === id) ?? PALETTES[0];
  const own = id === "custom" && customColors ? customColors.accent : null;
  const def = settingDef("accent") as EnumSetting;
  const options = def.options.map((o) => ({
    value: o.value as Settings["accent"],
    label: o.value === "auto" ? (id === "custom" ? "Custom theme" : `${pal.label} palette`) : o.label,
    color:
      o.value === "auto"
        ? (own ?? (dark ? pal.dark : pal.light).accent)
        : o.value === "custom"
          ? `radial-gradient(circle, ${custom} 0 42%, transparent 46%), ${RAINBOW}`
          : accentColor(o.value, dark),
  }));
  return <Swatches value={value} options={options} onChange={onChange} label="Accent color" />;
}
