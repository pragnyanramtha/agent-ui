/* Window events named here rather than in the screens that handle them, so firing one doesn't pull the
 * (lazily loaded) screen into the main bundle. */

/** Fired on window with `detail: { path?: string }` to open the Files tab, at that path. */
export const OPEN_FILES_EVENT = "agentu:open-files";

/** Fired on window to open the palette from anywhere: `window.dispatchEvent(new Event("open-palette"))`; a CustomEvent
 * with `{ query }` opens it with that search typed in. */
export const OPEN_PALETTE_EVENT = "open-palette";

/** Fired on window to fold or unfold the sidebar (the drawer on a phone). */
export const TOGGLE_SIDEBAR_EVENT = "toggle-sidebar";

/** Fired on window to open the keyboard shortcuts sheet. */
export const OPEN_SHORTCUTS_EVENT = "open-shortcuts";

/** Fired on window with `detail: TerminalTarget` to open the web terminal. */
export const OPEN_TERMINAL_EVENT = "open-terminal";

/** Fired on window with `detail: { path, line?, endLine? }` (absolute path) to show a file in the open session's
 * Files panel. */
export const OPEN_FILE_PANEL_EVENT = "agentu:open-file-panel";
export type OpenFilePanel = { path: string; line?: number; endLine?: number };
