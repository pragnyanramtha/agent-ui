/* Favorite and hidden models (Settings > Agents > Models): kept as comma-separated model ids so they can be typed in
 * Settings as well as starred in the model picker. */

/** the ids in a favorites or hidden list, in order, once each */
export function parseModelList(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).filter(Boolean))];
}

/** The list with `id` added (at the end) or taken out. */
export function toggleModel(text: string, id: string): string {
  const list = parseModelList(text);
  return (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]).join(", ");
}

export type ModelPrefs = { favorites: string; hidden: string };

/**
 * The picker's rows: Default first, then favorites, then the rest, each in the list's own order. Hidden models are
 * left out unless `showHidden`, a filter is typed (so they can be found and unhidden), or one is the current model.
 * `query` keeps Default and the current model and the rows whose id or name contain it.
 */
export function arrangeModels<M extends { key: string; name: string }>(models: readonly M[], prefs: ModelPrefs, opts: { current?: string | null; query?: string; showHidden?: boolean } = {}): { rows: M[]; hiddenCount: number } {
  const fav = new Set(parseModelList(prefs.favorites));
  const hidden = new Set(parseModelList(prefs.hidden));
  const q = opts.query?.trim().toLowerCase() ?? "";
  const keep = (m: M) => m.key === "" || m.key === opts.current;
  let hiddenCount = 0;
  const shown = models.filter((m) => {
    if (keep(m)) return true;
    if (q) return `${m.key} ${m.name}`.toLowerCase().includes(q);
    if (!hidden.has(m.key)) return true;
    hiddenCount++;
    return Boolean(opts.showHidden);
  });
  const rank = (m: M) => (m.key === "" ? 0 : fav.has(m.key) ? 1 : 2);
  const rows = shown.map((m, i) => [m, i] as const).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([m]) => m);
  return { rows, hiddenCount };
}
