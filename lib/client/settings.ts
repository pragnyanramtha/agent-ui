"use client";

import { useCallback, useSyncExternalStore } from "react";

/** Device preferences, kept in localStorage and shared across tabs. */
export type Settings = {
  /** desktop only: Enter sends and Shift+Enter makes a newline (phones always use the send button) */
  sendWithEnter: boolean;
  /** desktop terminals open in a panel under the page instead of a sheet over it */
  terminalDocked: boolean;
  /** "system" follows the OS */
  theme: "dark" | "light" | "system";
};

const DEFAULTS: Settings = { sendWithEnter: false, terminalDocked: true, theme: "dark" };
const KEYS: Record<keyof Settings, string> = { sendWithEnter: "cui:send-enter", terminalDocked: "cui:term-docked", theme: "bui-theme" };
const CHANGE = "agent-u:settings";

function read<K extends keyof Settings>(key: K): Settings[K] {
  try {
    const raw = localStorage.getItem(KEYS[key]);
    if (raw === null) return DEFAULTS[key];
    if (key === "terminalDocked") return (raw !== "sheet") as Settings[K];
    if (key === "sendWithEnter") return (raw === "1") as Settings[K];
    if (key === "theme") return (raw === "light" || raw === "system" ? raw : "dark") as Settings[K];
  } catch {}
  return DEFAULTS[key];
}

function write<K extends keyof Settings>(key: K, value: Settings[K]) {
  const raw = key === "terminalDocked" ? (value ? "dock" : "sheet") : key === "sendWithEnter" ? (value ? "1" : "0") : String(value);
  try {
    localStorage.setItem(KEYS[key], raw);
  } catch {}
  window.dispatchEvent(new Event(CHANGE));
}

function subscribe(cb: () => void) {
  const onStorage = (e: StorageEvent) => (!e.key || Object.values(KEYS).includes(e.key)) && cb();
  window.addEventListener(CHANGE, cb);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE, cb);
    window.removeEventListener("storage", onStorage);
  };
}

export function useSetting<K extends keyof Settings>(key: K): [Settings[K], (value: Settings[K]) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => DEFAULTS[key],
  );
  const set = useCallback((v: Settings[K]) => write(key, v), [key]);
  return [value, set];
}

export const getSetting = read;
export const setSetting = write;

/* Browser chrome color for each theme, matched to --page. Keep in sync with app/layout.tsx. */
export const THEME_COLOR = { dark: "#151619", light: "#fcfcfd" } as const;

export const prefersDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

/** Applies a theme choice to the page at once (one repaint, no color fades) and stores it. */
export function applyTheme(theme: Settings["theme"]) {
  const dark = theme === "system" ? prefersDark() : theme === "dark";
  const root = document.documentElement;
  root.classList.add("theme-switching");
  root.classList.toggle("dark", dark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? THEME_COLOR.dark : THEME_COLOR.light);
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
  write("theme", theme);
}
