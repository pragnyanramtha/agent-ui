/* How many app entries sit behind the current one in the browser history, so Back never leaves the app. */

const KEY = "agentUDepth";

const depth = (): number => {
  const st = window.history.state as Record<string, unknown> | null;
  const n = Number(st?.[KEY]);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const withDepth = (n: number) => ({ ...((window.history.state as Record<string, unknown> | null) ?? {}), [KEY]: n });

export function pushTab(url: string) {
  window.history.pushState({ [KEY]: depth() + 1 }, "", url);
}

export function replaceTab(url: string) {
  window.history.replaceState(withDepth(depth()), "", url);
}

/** True when Back would land on an earlier tab, not the page before the app. */
export const canGoBack = () => depth() > 0;
