import { describe, expect, it } from "vitest";
import { drawerProgress, EDGE_PX, isEdgeStart, lockAxis, rubberBand, SLOP_PX, swipeCommit } from "@/lib/client/gestures";
import { COLLAPSE_AFTER_PX, collapseStep, NEAR_END_PX, type CollapseState } from "@/lib/client/useComposerCollapse";

describe("swipe recognizer", () => {
  it("waits for the slop, then picks sideways only when it's clearly sideways", () => {
    expect(lockAxis(SLOP_PX - 1, 0)).toBeNull();
    expect(lockAxis(3, -4)).toBeNull();
    expect(lockAxis(20, 2)).toBe("x");
    expect(lockAxis(-20, 5)).toBe("x");
    expect(lockAxis(2, 20)).toBe("y");
    /* a diagonal is a scroll */
    expect(lockAxis(15, 12)).toBe("y");
    expect(lockAxis(15, 10)).toBe("y");
    expect(lockAxis(16, 10)).toBe("x");
  });

  it("commits past the distance, or on a quick flick, in the drag's direction", () => {
    expect(swipeCommit(-80, 600, 80)).toBe(-1);
    expect(swipeCommit(120, 900, 80)).toBe(1);
    expect(swipeCommit(60, 600, 80)).toBe(0);
    /* 40px in 50ms is a flick; 20px isn't, however fast */
    expect(swipeCommit(40, 50, 80)).toBe(1);
    expect(swipeCommit(-40, 50, 80)).toBe(-1);
    expect(swipeCommit(20, 5, 80)).toBe(0);
    expect(swipeCommit(40, 0, 80)).toBe(1);
  });

  it("starts edge swipes only at the very edge", () => {
    expect(isEdgeStart(0)).toBe(true);
    expect(isEdgeStart(EDGE_PX)).toBe(true);
    expect(isEdgeStart(EDGE_PX + 1)).toBe(false);
    expect(isEdgeStart(-3)).toBe(false);
  });

  it("follows the finger up to the limit, then holds back", () => {
    expect(rubberBand(50, 96)).toBe(50);
    expect(rubberBand(-96, 96)).toBe(-96);
    expect(rubberBand(126, 96)).toBe(106);
    expect(rubberBand(-126, 96)).toBe(-106);
  });

  it("opens the drawer as far as it was dragged", () => {
    expect(drawerProgress(-10, 300)).toBe(0);
    expect(drawerProgress(150, 300)).toBe(0.5);
    expect(drawerProgress(400, 300)).toBe(1);
    expect(drawerProgress(10, 0)).toBe(0);
  });
});

describe("composer collapse", () => {
  const open: CollapseState = { collapsed: false, travel: 0 };
  const far = NEAR_END_PX + 500;

  it("folds after scrolling up far enough, not on small jiggles", () => {
    let s = collapseStep(open, -20, far, false);
    expect(s).toEqual({ collapsed: false, travel: 20 });
    s = collapseStep(s, -(COLLAPSE_AFTER_PX - 20), far, false);
    expect(s.collapsed).toBe(true);
    /* a scroll back down in between starts the count over */
    let j = collapseStep(open, -30, far, false);
    j = collapseStep(j, 5, far, false);
    j = collapseStep(j, -30, far, false);
    expect(j.collapsed).toBe(false);
  });

  it("stays folded while reading downward, and opens near the end", () => {
    const folded: CollapseState = { collapsed: true, travel: 0 };
    expect(collapseStep(folded, 200, far, false).collapsed).toBe(true);
    expect(collapseStep(folded, 200, NEAR_END_PX, false).collapsed).toBe(false);
  });

  it("never folds near the end or while held open", () => {
    expect(collapseStep(open, -500, NEAR_END_PX - 1, false).collapsed).toBe(false);
    expect(collapseStep({ collapsed: true, travel: 0 }, -500, far, true)).toEqual(open);
  });
});
