/* Window events named here rather than in the screens that handle them, so firing one doesn't pull the
 * (lazily loaded) screen into the main bundle. */

/** Fired on window with `detail: { path?: string }` to open the Files tab, at that path. */
export const OPEN_FILES_EVENT = "agentu:open-files";
