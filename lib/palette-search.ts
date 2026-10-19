import { score } from "@/lib/session-match";
import { searchSettings, sectionInfo, settingDef, type SectionId } from "@/lib/settings-schema";

/* How the command palette reads what's typed, apart from React so it can be tested. */

export type PaletteQuery = { actionsOnly: boolean; words: string[] };

/** "> pin" asks for actions only; the words after the ">" filter them. */
export function parsePaletteQuery(raw: string): PaletteQuery {
  const t = raw.trimStart();
  const actionsOnly = t.startsWith(">");
  const words = (actionsOnly ? t.slice(1) : t).trim().toLowerCase().split(/\s+/).filter(Boolean);
  return { actionsOnly, words };
}

export type Searchable = { label: string; keywords?: string };

/** Every word lands in the label or keywords, at a word start or inside a word. */
export const actionMatches = (a: Searchable, words: readonly string[]) => words.every((w) => score(`${a.label} ${a.keywords ?? ""}`, w) >= 60);

/** 0 when the typed text starts the label, 0.5 when it starts a word in it, 1 otherwise (nothing typed: 1). */
export function actionRank(a: Searchable, typed: string): number {
  if (!typed) return 1;
  const label = a.label.toLowerCase();
  return label.startsWith(typed) ? 0 : score(label, typed) >= 80 ? 0.5 : 1;
}

/** The actions that match, best label matches first, otherwise in their own order. */
export function filterActions<T extends Searchable>(actions: readonly T[], words: readonly string[]): T[] {
  if (!words.length) return [...actions];
  const typed = words.join(" ");
  return actions
    .filter((a) => actionMatches(a, words))
    .map((a, i) => ({ a, i, r: actionRank(a, typed) }))
    .sort((x, y) => x.r - y.r || x.i - y.i)
    .map((x) => x.a);
}

export type SettingRow = { id: string; label: string; section: SectionId; sectionLabel: string; description?: string };

export const PALETTE_SETTINGS_MAX = 5;

/** Settings (and Settings rows such as an import button) the words find, labels that match first; at most `max`. */
export function settingRows(words: readonly string[], max = PALETTE_SETTINGS_MAX): SettingRow[] {
  const typed = words.join(" ");
  if (typed.length < 2) return [];
  const rows = searchSettings(typed).flatMap((h) => {
    const info = sectionInfo(h.section);
    return [
      ...h.settings.map((k) => {
        const d = settingDef(k);
        return { id: `set:${k}`, label: d.label, section: h.section, sectionLabel: info.label, description: d.description };
      }),
      ...h.items.map((id) => {
        const item = info.items!.find((i) => i.id === id)!;
        return { id: `set:${h.section}:${id}`, label: item.label, section: h.section, sectionLabel: info.label, description: item.description };
      }),
    ];
  });
  const inLabel = (r: SettingRow) => (words.every((w) => r.label.toLowerCase().includes(w)) ? 0 : 1);
  return rows
    .map((r, i) => ({ r, i, k: inLabel(r) }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .slice(0, max)
    .map((x) => x.r);
}
