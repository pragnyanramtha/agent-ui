"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { CommandId } from "@/lib/keybindings";

/* What the open screen offers the command palette: actions (rows under "Session") and pickers (lists the palette shows
 * in place, like the theme picker). Screens register a builder that runs when the palette reads it, so the rows
 * always reflect the latest state without re-registering on every render. */

export type PaletteIcon = "git" | "changes" | "usage" | "rename" | "pin" | "unpin" | "archive" | "download" | "handoff" | "stop" | "model" | "mode" | "effort" | "needsYou" | "file";

export type PaletteAction = {
  id: string;
  label: string;
  keywords?: string;
  hint?: string;
  icon: PaletteIcon;
  /** the command whose keys show on the row, and which runs this action from the keyboard */
  command?: CommandId;
  run: () => void;
  /** what the shortcut does when it differs from the row (a panel key toggles, the row opens) */
  onCommand?: () => void;
  /** opens this picker inside the palette instead of running */
  picker?: string;
  /** opens a dialog, so focus stays there instead of going back where the palette was opened */
  takesFocus?: boolean;
};

export type PaletteChoice = { value: string; label: string; hint?: string; current?: boolean };

export type PalettePicker = {
  id: string;
  /** the group heading over the choices */
  title: string;
  placeholder: string;
  choices: PaletteChoice[];
  pick: (value: string) => void;
};

export type PaletteSource = { actions: PaletteAction[]; pickers?: PalettePicker[] };

const sources = new Map<string, () => PaletteSource>();
const listeners = new Set<() => void>();
let version = 0;

function changed() {
  version++;
  for (const l of listeners) l();
}

/** Adds (or with null removes) the builder under `key`; the last one registered for a key wins. */
export function setPaletteSource(key: string, build: (() => PaletteSource) | null) {
  if (build) sources.set(key, build);
  else sources.delete(key);
  changed();
}

/** Everything registered right now, in registration order. */
export function paletteSources(): PaletteSource[] {
  return [...sources.values()].map((b) => b());
}

export const paletteActions = (): PaletteAction[] => paletteSources().flatMap((s) => s.actions);
export const palettePicker = (id: string): PalettePicker | null => paletteSources().flatMap((s) => s.pickers ?? []).find((p) => p.id === id) ?? null;
export const actionFor = (command: CommandId): PaletteAction | null => paletteActions().find((a) => a.command === command) ?? null;

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => void listeners.delete(cb);
};

/** Changes whenever a screen registers or leaves, so the palette knows to read again. */
export const usePaletteVersion = () =>
  useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );

/** Registers `build` under `key` while the calling component is mounted. */
export function usePaletteSource(key: string, build: () => PaletteSource) {
  const ref = useRef(build);
  ref.current = build;
  useEffect(() => {
    const read = () => ref.current();
    setPaletteSource(key, read);
    return () => {
      if (sources.get(key) === read) setPaletteSource(key, null);
    };
  }, [key]);
}

/** Fired on window with `detail: { picker }` to open the palette straight on one of the registered pickers. */
export const OPEN_PALETTE_PICKER_EVENT = "open-palette-picker";

export function openPalettePicker(id: string): boolean {
  if (!palettePicker(id)) return false;
  window.dispatchEvent(new CustomEvent(OPEN_PALETTE_PICKER_EVENT, { detail: { picker: id } }));
  return true;
}
