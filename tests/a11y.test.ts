import { describe, expect, it } from "vitest";
import { inertOutside, overflows } from "@/lib/client/a11y";

const el = (inert = false) => ({ inert });

describe("inertOutside", () => {
  it("makes every sibling but the dialog inert and restores them", () => {
    const app = el();
    const toast = el();
    const sheet = el();
    const release = inertOutside(sheet, [app, toast, sheet]);
    expect([app.inert, toast.inert, sheet.inert]).toEqual([true, true, false]);
    release();
    expect([app.inert, toast.inert, sheet.inert]).toEqual([false, false, false]);
  });

  it("leaves elements that were already inert alone", () => {
    const app = el();
    const hidden = el(true);
    const sheet = el();
    inertOutside(sheet, [app, hidden, sheet])();
    expect(hidden.inert).toBe(true);
    expect(app.inert).toBe(false);
  });

  it("stacks nested dialogs: the inner one disables the outer, closing it brings the outer back", () => {
    const app = el();
    const outer = el();
    const inner = el();
    const releaseOuter = inertOutside(outer, [app, outer]);
    const releaseInner = inertOutside(inner, [app, outer, inner]);
    expect([app.inert, outer.inert, inner.inert]).toEqual([true, true, false]);
    releaseInner();
    expect([app.inert, outer.inert]).toEqual([true, false]);
    releaseOuter();
    expect(app.inert).toBe(false);
  });

  it("keeps the page inert while any dialog is still open, whatever the closing order", () => {
    const app = el();
    const outer = el();
    const inner = el();
    const releaseOuter = inertOutside(outer, [app, outer]);
    const releaseInner = inertOutside(inner, [app, outer, inner]);
    releaseOuter();
    expect(app.inert).toBe(true);
    releaseInner();
    expect(app.inert).toBe(false);
  });
});

describe("overflows", () => {
  const box = (scrollWidth: number, clientWidth: number, scrollHeight: number, clientHeight: number) => ({ scrollWidth, clientWidth, scrollHeight, clientHeight });
  it("reads each axis, ignoring subpixel rounding", () => {
    expect(overflows(box(300, 300, 900, 400), "y")).toBe(true);
    expect(overflows(box(300, 300, 900, 400), "x")).toBe(false);
    expect(overflows(box(301, 300, 401, 400), "both")).toBe(false);
    expect(overflows(box(640, 300, 200, 200), "both")).toBe(true);
  });
});
