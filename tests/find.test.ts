import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { matchOffsets, nthWithin } from "@/lib/client/find";
import { CodeCard } from "@/components/claude/CodeCard";

describe("find in session", () => {
  it("matches case-insensitively without overlaps", () => {
    expect(matchOffsets("Foo foo FOO", "foo")).toEqual([0, 4, 8]);
    expect(matchOffsets("aaaa", "aa")).toEqual([0, 2]);
    expect(matchOffsets("abc", "")).toEqual([]);
    expect(matchOffsets("x x x x", "x", 2)).toEqual([0, 2]);
  });

  it("finds the same match again after its block re-renders", () => {
    /* before: matches 0-1 elsewhere, 2-4 in the card; after the card opens, its matches sit at 3-5 */
    const after = ["a", "b", "x", "c1", "c2", "c3"];
    const inCard = (s: string) => s.startsWith("c");
    expect(nthWithin(after, inCard, 0)).toBe(3);
    expect(nthWithin(after, inCard, 2)).toBe(5);
    expect(nthWithin(after, inCard, 7)).toBe(5);
    expect(nthWithin(after, () => false, 0)).toBe(-1);
  });

  it("keeps a collapsed code block's hidden lines in the page for find, without painting them", () => {
    const code = Array.from({ length: 100 }, (_, i) => `line ${i + 1} needle${i + 1}`).join("\n");
    const html = renderToStaticMarkup(createElement(CodeCard, { code, label: "txt", collapsible: true }));
    expect(html).toContain("data-code-card");
    const rest = /<div hidden="" data-code-rest="true">([\s\S]*?)<\/div>/.exec(html);
    expect(rest?.[1]).toContain("needle31");
    expect(rest?.[1]).toContain("needle100");
    expect(rest?.[1]).not.toContain("needle30\n");
    expect(matchOffsets(rest?.[1] ?? "", "needle45")).toHaveLength(1);
  });
});
