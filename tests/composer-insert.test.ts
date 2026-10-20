import { describe, expect, it } from "vitest";
import { appendToDraft, fenceBlock } from "@/lib/client/composer-insert";

describe("fenceBlock", () => {
  it("wraps text in a fenced block, trimming padding", () => {
    expect(fenceBlock("\n$ ls   \nfoo  bar   \n\n")).toBe("```\n$ ls\nfoo  bar\n```");
  });

  it("uses a longer fence than any backtick run inside", () => {
    expect(fenceBlock("```js\nx\n```")).toBe("````\n```js\nx\n```\n````");
    expect(fenceBlock("a `b` c")).toBe("```\na `b` c\n```");
  });

  it("takes a language", () => {
    expect(fenceBlock("ls", "console")).toBe("```console\nls\n```");
  });
});

describe("appendToDraft", () => {
  it("starts an empty draft with the text", () => {
    expect(appendToDraft("", "```\nx\n```")).toBe("```\nx\n```\n");
    expect(appendToDraft("  \n", "x")).toBe("x\n");
  });

  it("adds the text as a new paragraph", () => {
    expect(appendToDraft("Why does this fail?\n", "```\nx\n```")).toBe("Why does this fail?\n\n```\nx\n```\n");
  });
});
