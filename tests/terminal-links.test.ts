import { describe, expect, it } from "vitest";
import { findPathLinks, resolveTerminalPath } from "@/lib/client/terminal-links";

const paths = (s: string) => findPathLinks(s).map((m) => m.text);

describe("findPathLinks", () => {
  it("finds relative paths with line and column", () => {
    const [m] = findPathLinks("error in src/foo.ts:12:5: unexpected token");
    expect(m).toMatchObject({ text: "src/foo.ts:12:5", path: "src/foo.ts", line: 12, col: 5 });
    expect("error in src/foo.ts:12:5: unexpected token".slice(m.start, m.end)).toBe("src/foo.ts:12:5");
  });

  it("finds absolute, home and dot paths", () => {
    expect(paths("see /etc/hosts.conf and ~/notes/todo.md, or ./run.sh.")).toEqual(["/etc/hosts.conf", "~/notes/todo.md", "./run.sh"]);
    expect(findPathLinks("../lib/a.py:3")[0]).toMatchObject({ path: "../lib/a.py", line: 3 });
  });

  it("takes a bare file name only with a line number", () => {
    expect(paths("app.ts:40 failed")).toEqual(["app.ts:40"]);
    expect(paths("and README.md:3, see")).toEqual(["README.md:3"]);
    expect(paths("open app.ts now")).toEqual([]);
  });

  it("skips URLs and the paths inside them", () => {
    expect(paths("visit https://example.com/docs/index.html and lib/x.ts")).toEqual(["lib/x.ts"]);
  });

  it("skips folders and prose with slashes", () => {
    expect(paths("cd /usr/local/bin and/or src/components")).toEqual([]);
  });

  it("drops wrapping punctuation", () => {
    expect(paths("(at src/a.tsx:9)")).toEqual(["src/a.tsx:9"]);
    expect(paths('"lib/b.ts"')).toEqual(["lib/b.ts"]);
  });
});

describe("resolveTerminalPath", () => {
  it("resolves against the folder and home", () => {
    expect(resolveTerminalPath("src/a.ts", "/home/me/app", "/home/me")).toBe("/home/me/app/src/a.ts");
    expect(resolveTerminalPath("../b.ts", "/home/me/app/", null)).toBe("/home/me/b.ts");
    expect(resolveTerminalPath("./c.ts", "/w", null)).toBe("/w/c.ts");
    expect(resolveTerminalPath("~/d.md", null, "/home/me")).toBe("/home/me/d.md");
    expect(resolveTerminalPath("/etc//hosts", null, null)).toBe("/etc/hosts");
  });

  it("gives up on relative paths without a folder", () => {
    expect(resolveTerminalPath("src/a.ts", "", "/home/me")).toBeNull();
    expect(resolveTerminalPath("~/a.ts", "/w", null)).toBeNull();
  });
});
