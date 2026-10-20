import { describe, expect, it } from "vitest";
import { mentionToken, refFromCode, refFromHref, refLines } from "@/lib/client/file-refs";

describe("path:line parsing", () => {
  it("reads hrefs and inline code", () => {
    expect(refFromHref("src/a.ts#L12-L20")).toEqual({ path: "src/a.ts", line: 12, endLine: 20 });
    expect(refFromCode("lib/app.ts:42")).toEqual({ path: "lib/app.ts", line: 42 });
    expect(refFromCode("https://example.com/x.ts")).toBeNull();
  });

  it("formats mention tokens and line labels", () => {
    expect(mentionToken("src/a.ts", 12, 20)).toBe("@src/a.ts:12-20");
    expect(mentionToken("my notes.md")).toBe("`@my notes.md`");
    expect(refLines({ path: "a.ts", line: 3, endLine: 5 })).toBe("3-5");
  });
});
