"use client";

import dynamic from "next/dynamic";

/* Screens, panels and dialogs that the first paint doesn't need, each in its own chunk. */

function ScreenWait({ label }: { label: string }) {
  return (
    <div role="status" className="flex min-h-0 flex-1 items-center justify-center bg-page p-6 text-sm text-ink-3">
      {label}
    </div>
  );
}

/* a side panel covers the session below lg, like the panels themselves */
function PanelWait({ label }: { label: string }) {
  return (
    <div
      role="status"
      className="absolute inset-0 z-20 flex items-center justify-center bg-page p-6 text-sm text-ink-3 lg:static lg:inset-auto lg:w-[440px] lg:shrink-0 lg:border-l lg:border-line xl:w-[520px]"
    >
      {label}
    </div>
  );
}

function PillWait({ label }: { label: string }) {
  return (
    <div role="status" className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-surface px-3.5 py-2 text-sm text-ink-2 shadow-overlay">
      {label}
    </div>
  );
}

const askCards = () => import("./AskCards");

export const FilesScreen = dynamic(() => import("./FilesScreen").then((m) => m.FilesScreen), { ssr: false, loading: () => <ScreenWait label="Loading files…" /> });
export const AgentsScreen = dynamic(() => import("./AgentsScreen").then((m) => m.AgentsScreen), { ssr: false, loading: () => <ScreenWait label="Loading agents…" /> });
export const SettingsScreen = dynamic(() => import("./SettingsScreen").then((m) => m.SettingsScreen), { ssr: false, loading: () => <ScreenWait label="Loading settings…" /> });
export const WebTerminal = dynamic(() => import("./WebTerminal").then((m) => m.WebTerminal), { ssr: false, loading: () => <PillWait label="Opening terminal…" /> });
export const ShortcutsDialog = dynamic(() => import("./ShortcutsDialog").then((m) => m.ShortcutsDialog), { ssr: false });
export const FolderPicker = dynamic(() => import("./FolderPicker").then((m) => m.FolderPicker), { ssr: false });

export { FilesPanel } from "./files-panel";
export type { FileTarget } from "./files-panel";
export const GitPanel = dynamic(() => import("./GitPanel").then((m) => m.GitPanel), { ssr: false, loading: () => <PanelWait label="Loading Git…" /> });
export const UsagePanel = dynamic(() => import("./UsagePanel").then((m) => m.UsagePanel), { ssr: false, loading: () => <PanelWait label="Loading usage…" /> });
export const QuickOpen = dynamic(() => import("./QuickOpen").then((m) => m.QuickOpen), { ssr: false });
export const HandoffDialog = dynamic(() => import("./HandoffDialog").then((m) => m.HandoffDialog), { ssr: false, loading: () => <PillWait label="Loading…" /> });
export const TerminalPeek = dynamic(() => import("./TerminalPeek").then((m) => m.TerminalPeek), { ssr: false, loading: () => <PillWait label="Loading terminal preview…" /> });
export const AskCards = dynamic(() => askCards().then((m) => m.AskCards), { ssr: false, loading: () => <p role="status" className="py-2 text-sm text-ink-3">Loading request…</p> });

/** Fetches what an open session may need at once, so an approval still shows if the network drops later. */
export const preloadSessionChunks = () => void askCards().catch(() => undefined);
