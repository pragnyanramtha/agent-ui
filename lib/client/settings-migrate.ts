import { encodeStored, storageKey } from "@/lib/settings-schema";

/* One-time moves of device choices stored by earlier versions into the registry's keys (lib/settings-schema.ts).
 * Each step only fills a key that's still empty, so it never overwrites a choice made since, and is safe to rerun. */

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** where the diff viewer kept layout and whitespace together, before each had its own key */
const OLD_DIFF_KEY = "agent-u:diff";

export function migrateDeviceSettings(store: Store) {
  try {
    const raw = store.getItem(OLD_DIFF_KEY);
    if (raw === null) return;
    let old: { split?: unknown; ws?: unknown } = {};
    try {
      old = (JSON.parse(raw) as typeof old) ?? {};
    } catch {}
    if (old.split === true && store.getItem(storageKey("diffLayout")) === null) store.setItem(storageKey("diffLayout"), encodeStored("diffLayout", "split"));
    if (old.ws === true && store.getItem(storageKey("diffIgnoreWhitespace")) === null) store.setItem(storageKey("diffIgnoreWhitespace"), encodeStored("diffIgnoreWhitespace", true));
    store.removeItem(OLD_DIFF_KEY);
  } catch {}
}
