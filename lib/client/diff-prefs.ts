/* The diff viewer's per-device choices, one localStorage key each. */

export const DIFF_PREF_KEYS = { layout: "agent-u:diff-layout", whitespace: "agent-u:diff-whitespace", wrap: "agent-u:diff-wrap" } as const;
/** where layout and whitespace lived together before */
const OLD_KEY = "agent-u:diff";

export type DiffPrefs = { ws: boolean; split: boolean; wrap: boolean };
export const DEFAULT_DIFF_PREFS: DiffPrefs = { ws: false, split: false, wrap: false };

type Store = Pick<Storage, "getItem" | "setItem">;

export function readDiffPrefs(store: Store): DiffPrefs {
  try {
    let old: Partial<DiffPrefs> = {};
    try {
      old = (JSON.parse(store.getItem(OLD_KEY) ?? "{}") as Partial<DiffPrefs>) ?? {};
    } catch {}
    const layout = store.getItem(DIFF_PREF_KEYS.layout);
    const ws = store.getItem(DIFF_PREF_KEYS.whitespace);
    return {
      split: layout ? layout === "split" : old.split === true,
      ws: ws ? ws === "hide" : old.ws === true,
      wrap: store.getItem(DIFF_PREF_KEYS.wrap) === "on",
    };
  } catch {
    return DEFAULT_DIFF_PREFS;
  }
}

export function writeDiffPrefs(store: Store, p: DiffPrefs) {
  try {
    store.setItem(DIFF_PREF_KEYS.layout, p.split ? "split" : "unified");
    store.setItem(DIFF_PREF_KEYS.whitespace, p.ws ? "hide" : "show");
    store.setItem(DIFF_PREF_KEYS.wrap, p.wrap ? "on" : "off");
  } catch {}
}
