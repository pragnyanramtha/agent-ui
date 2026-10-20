"use client";

import { load, save } from "./storage";

/* Opening Settings with its search already filled in (the palette's Settings rows). The query waits in sessionStorage
 * for a Settings screen that mounts later; one that is already open hears the event. */

export const SETTINGS_SEARCH_EVENT = "agent-u:settings-search";
const KEY = "cui:settings-search";

export function searchSettingsFor(query: string) {
  save(KEY, query);
  window.dispatchEvent(new Event(SETTINGS_SEARCH_EVENT));
}

/** The query waiting for Settings, once; null when there is none. */
export function takeSettingsSearch(): string | null {
  const q = load(KEY);
  if (q !== null) save(KEY, null);
  return q;
}
