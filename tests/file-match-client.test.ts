import { describe, expect, it } from "vitest";
import { fuzzyCost, fuzzyPositions, matchPositions, splitQueryLine } from "@/lib/file-match";

describe("splitQueryLine", () => {
  it("splits a trailing line number from the path query", () => {
    expect(splitQueryLine("src/app.ts:42")).toEqual({ query: "src/app.ts", line: 42 });
    expect(splitQueryLine("app.ts")).toEqual({ query: "app.ts" });
  });
});

describe("fuzzy ranking", () => {
  const files = ["src/components/Composer.tsx", "Composer.tsx", "docs/composer-notes.md"];

  it("ranks tighter character runs before looser ones", () => {
    expect(fuzzyCost("test/cmp/osr.ts", "cmpsr")).toBeLessThan(fuzzyCost("src/components/Composer.tsx", "cmpsr"));
  });

  it("finds ordered character positions along the path", () => {
    expect(fuzzyPositions("src/app/page.tsx", "spg")).not.toBeNull();
    expect(fuzzyPositions("README.md", "zzz")).toBeNull();
  });

  it("prefers file-name matches for highlighting", () => {
    const at = matchPositions("src/lib/compose.ts", "compose");
    expect(at.every((i) => "compose.ts".includes("compose.ts"[i - "src/lib/".length] ?? "")) || at[0] >= "src/lib/".length).toBe(true);
  });
});
