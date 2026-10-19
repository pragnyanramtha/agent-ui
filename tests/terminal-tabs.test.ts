import { describe, expect, it } from "vitest";
import { sameTarget, tabNames } from "@/lib/client/terminal-tabs";

describe("terminal tabs", () => {
  it("matches kept terminals, multiplexer sessions and CLI sessions", () => {
    expect(sameTarget({ term: "t1" }, { term: "t1" })).toBe(true);
    expect(sameTarget({ term: "t1" }, { term: "t2" })).toBe(false);
    expect(sameTarget({ tmux: "agentu-a" }, { tmux: "agentu-a" })).toBe(true);
    expect(sameTarget({ session: "s", pid: 3 }, { session: "s" })).toBe(true);
    expect(sameTarget({ pid: 3 }, { pid: 4 })).toBe(false);
  });

  it("treats every plain shell request as a new terminal", () => {
    expect(sameTarget({ cwd: "/w" }, { cwd: "/w" })).toBe(false);
    expect(sameTarget({ cwd: "/w" }, { term: "t1" })).toBe(false);
  });

  it("names tabs by folder and numbers repeats", () => {
    expect(tabNames(["Shell: ~/demo-app", "Shell: ~/demo-app", "Claude Code", "Shell: /", "Shell", "Shell: ~/demo-app/"])).toEqual([
      "demo-app",
      "demo-app 2",
      "Claude Code",
      "/",
      "Shell",
      "demo-app 3",
    ]);
  });
});
