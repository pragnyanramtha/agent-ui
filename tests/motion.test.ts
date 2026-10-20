import { afterEach, describe, expect, it } from "vitest";
import { reducedMotion, scrollBehavior } from "@/lib/client/motion";

const g = globalThis as Record<string, unknown>;

function page(motion: string | null, osReduces: boolean) {
  g.window = { matchMedia: (q: string) => ({ matches: osReduces && q.includes("reduce") }) };
  g.document = { documentElement: { getAttribute: (k: string) => (k === "data-motion" ? motion : null) } };
}

afterEach(() => {
  delete g.window;
  delete g.document;
});

describe("reducedMotion", () => {
  it("follows the device on System", () => {
    page("system", true);
    expect(reducedMotion()).toBe(true);
    page("system", false);
    expect(reducedMotion()).toBe(false);
  });

  it("lets On and Off win over the device", () => {
    page("on", false);
    expect(reducedMotion()).toBe(true);
    expect(scrollBehavior()).toBe("auto");
    page("off", true);
    expect(reducedMotion()).toBe(false);
    expect(scrollBehavior()).toBe("smooth");
  });

  it("is false on the server", () => {
    expect(reducedMotion()).toBe(false);
  });
});
