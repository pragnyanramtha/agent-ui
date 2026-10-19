import { describe, expect, it } from "vitest";
import { newestFirst } from "@/lib/server/order";

describe("newestFirst", () => {
  it("puts the newest first", () => {
    const rows = [{ id: "a", mtime: 1 }, { id: "b", mtime: 3 }, { id: "c", mtime: 2 }];
    expect(rows.sort(newestFirst).map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("orders equal times by id, whatever order they arrive in", () => {
    const rows = ["d", "b", "a", "c"].map((id) => ({ id, mtime: 5 }));
    expect([...rows].sort(newestFirst).map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
    expect([...rows].reverse().sort(newestFirst).map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
  });
});
