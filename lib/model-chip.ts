import type { Entry } from "./types";

/* What the composer's model chip names when the session is on "Default": the model that will actually answer.
 * No React, no DOM. */

export type ChipModel = { model: string; from: "picked" | "profile" | "seen" } | { model: null; from: "agent" };

/* stand-ins agents write when they don't know: Claude's "<synthetic>" turns, Cursor's "cursor" */
const PLACEHOLDER = /^(<[^>]*>|cursor|unknown|default)$/i;

/** A model id a usage record reported, or null when it's blank or a stand-in. */
export function seenModel(model: string | null | undefined): string | null {
  const m = model?.trim();
  return m && !PLACEHOLDER.test(m) ? m : null;
}

/** The picked model, else the profile's default, else the last model the session reported using, else none (the chip
 * names the agent). Blank strings count as unset. */
export function chipModel(picked: string | null | undefined, profile: { defaultModel: string | null; models: string[] } | null | undefined, seen: string | null | undefined): ChipModel {
  const p = picked?.trim();
  if (p) return { model: p, from: "picked" };
  const d = (profile?.defaultModel || profile?.models[0])?.trim();
  if (d) return { model: d, from: "profile" };
  const s = seenModel(seen);
  if (s) return { model: s, from: "seen" };
  return { model: null, from: "agent" };
}

/** The model of the newest usage record in a thread that names one. */
export function lastSeenModel(entries: readonly Entry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const m = e.kind === "usage" ? seenModel(e.model) : null;
    if (m) return m;
  }
  return null;
}
