import { beforeEach, describe, expect, it, vi } from "vitest";
import { dropStash, loadStash, pushStash, STASH_MAX, stashTitle } from "@/lib/client/stash";

const mem = new Map<string, string>();
let full = false;
beforeEach(() => {
  mem.clear();
  full = false;
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (full) throw new DOMException("quota", "QuotaExceededError");
      mem.set(k, v);
    },
    removeItem: (k: string) => void mem.delete(k),
  });
});

describe("prompt stash", () => {
  it("keeps prompts per folder, newest first", () => {
    pushStash("/a", "first", [], 1000);
    pushStash("/a", "second", [{ name: "x.png", size: 3, path: "/tmp/x.png" }], 2000);
    pushStash("/b", "other", [], 3000);
    const a = loadStash("/a");
    expect(a.map((s) => s.text)).toEqual(["second", "first"]);
    expect(a[0].files).toEqual([{ name: "x.png", size: 3, path: "/tmp/x.png" }]);
    expect(loadStash("/b").map((s) => s.text)).toEqual(["other"]);
    expect(loadStash(undefined)).toEqual([]);
  });

  it("caps each folder at the newest 20", () => {
    for (let i = 0; i < STASH_MAX + 5; i++) pushStash("/a", `p${i}`, [], i);
    const list = loadStash("/a");
    expect(list).toHaveLength(STASH_MAX);
    expect(list[0].text).toBe(`p${STASH_MAX + 4}`);
    expect(list.at(-1)!.text).toBe("p5");
  });

  it("deletes one, and clears the key when the last goes", () => {
    const [b, a] = (pushStash("/a", "a"), pushStash("/a", "b"))!;
    expect(dropStash("/a", b.id).map((s) => s.id)).toEqual([a.id]);
    dropStash("/a", a.id);
    expect(mem.has("cui:stash:/a")).toBe(false);
  });

  it("says so when storage refuses, and survives junk", () => {
    full = true;
    expect(pushStash("/a", "x")).toBeNull();
    full = false;
    mem.set("cui:stash:/a", "{not json");
    expect(loadStash("/a")).toEqual([]);
    mem.set("cui:stash:/a", JSON.stringify([{ id: 1 }, { id: "ok", text: "t", files: [], at: 1 }]));
    expect(loadStash("/a").map((s) => s.id)).toEqual(["ok"]);
  });

  it("titles rows by the first line, or the files", () => {
    expect(stashTitle({ id: "1", text: "\n  fix the login bug  \nmore", files: [], at: 0 })).toBe("fix the login bug");
    expect(stashTitle({ id: "1", text: "", files: [{ name: "a.png", size: 1, path: "/a.png" }], at: 0 })).toBe("a.png");
    expect(stashTitle({ id: "1", text: " ", files: [{ name: "a", size: 1, path: "/a" }, { name: "b", size: 1, path: "/b" }], at: 0 })).toBe("2 files");
  });
});
