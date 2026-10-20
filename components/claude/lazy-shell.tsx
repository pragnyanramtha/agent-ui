"use client";

import { lazyComponent } from "@/lib/client/lazy";

/* App-level pieces the first paint doesn't need, each in its own chunk: the session and new-session screens
 * (the main area stays empty until the open tabs are restored), the terminal (xterm and the Files screen it
 * links to) and the command palette with its pickers. */

/* while a screen's code arrives the main area is just the page; usually it is already there */
const ScreenBlank = () => (
  <div role="status" className="min-h-0 flex-1 bg-page">
    <span className="sr-only">Loading…</span>
  </div>
);

export const SessionScreen = lazyComponent(() => import("./SessionScreen").then((m) => m.SessionScreen), ScreenBlank);
export const NewSession = lazyComponent(() => import("./NewSession").then((m) => m.NewSession), ScreenBlank);

/** Starts downloading both screens while the shell hydrates, instead of after the tabs are restored. */
export function preloadScreens() {
  void SessionScreen.preload().catch(() => undefined);
  void NewSession.preload().catch(() => undefined);
}

export const TerminalDrawer = lazyComponent(
  () => import("./TerminalDrawer").then((m) => m.TerminalDrawer),
  () => (
    <div role="status" className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-surface px-3.5 py-2 text-xs text-ink-2 shadow-overlay">
      Opening terminal…
    </div>
  ),
);

export const CommandPalette = lazyComponent(() => import("./CommandPalette").then((m) => m.CommandPalette));

/** Fetches the terminal chunk ahead of the first Mod+J, once the page is idle. */
export function preloadTerminalWhenIdle(): () => void {
  const load = () => void TerminalDrawer.preload().catch(() => undefined);
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(load, { timeout: 8000 });
    return () => cancelIdleCallback(id);
  }
  const t = setTimeout(load, 4000);
  return () => clearTimeout(t);
}
