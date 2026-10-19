import { beforeEach, describe, expect, it } from "vitest";

/* a browser history: a stack of states with a cursor */
let stack: unknown[] = [];
let at = 0;
const history = {
  get state() {
    return stack[at] ?? null;
  },
  pushState(s: unknown) {
    stack = [...stack.slice(0, at + 1), s];
    at = stack.length - 1;
  },
  replaceState(s: unknown) {
    stack[at] = s;
  },
  back() {
    at = Math.max(0, at - 1);
  },
};
(globalThis as Record<string, unknown>).window = { history };

const { canGoBack, pushTab, replaceTab } = await import("@/lib/client/tab-history");

beforeEach(() => {
  stack = [{ __NA: true }];
  at = 0;
});

describe("tab history", () => {
  it("only lets Back step through tabs the app pushed", () => {
    expect(canGoBack()).toBe(false);
    replaceTab("/?s=a");
    expect(canGoBack()).toBe(false);
    expect(history.state).toMatchObject({ __NA: true });
    pushTab("/?s=b");
    pushTab("/?s=c");
    expect(canGoBack()).toBe(true);
    history.back();
    expect(canGoBack()).toBe(true);
    history.back();
    expect(canGoBack()).toBe(false);
  });

  it("keeps the depth when a tab replaces the current entry", () => {
    pushTab("/?s=b");
    replaceTab("/?s=c");
    expect(canGoBack()).toBe(true);
  });
});
