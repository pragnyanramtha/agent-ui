/* The desktop sidebar's width: its bounds, and how a drag or an arrow key moves it. No React, no DOM. */

export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 420;
export const SIDEBAR_DEFAULT = 260;
/** the conversation keeps at least this much room next to the sidebar */
export const SIDEBAR_MAIN_MIN = 600;
/** an arrow key's step; with Shift, three of them */
export const SIDEBAR_STEP = 16;

/** The widest the sidebar may get in a window this wide: SIDEBAR_MAX, less when the window is narrow, never under SIDEBAR_MIN. */
export const sidebarMax = (viewport = Infinity) => Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.floor(viewport) - SIDEBAR_MAIN_MIN));

/** A width inside the bounds, in whole pixels; anything unreadable is the default. */
export function clampSidebarWidth(width: number, viewport = Infinity): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT;
  return Math.round(Math.max(SIDEBAR_MIN, Math.min(sidebarMax(viewport), width)));
}

/** Where a key moves the width, or null for keys the handle doesn't take. */
export function sidebarKeyWidth(key: string, width: number, shift: boolean, viewport = Infinity): number | null {
  const step = shift ? SIDEBAR_STEP * 3 : SIDEBAR_STEP;
  switch (key) {
    case "ArrowLeft":
      return clampSidebarWidth(width - step, viewport);
    case "ArrowRight":
      return clampSidebarWidth(width + step, viewport);
    case "Home":
      return SIDEBAR_MIN;
    case "End":
      return sidebarMax(viewport);
    case "Enter":
      return SIDEBAR_DEFAULT;
    default:
      return null;
  }
}
