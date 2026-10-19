import { describe, expect, it } from "vitest";
import { parseUnifiedPatch } from "@/lib/client/diff";

describe("parseUnifiedPatch edge cases", () => {
  it("unquotes names with emoji next to escapes", () => {
    /* what git prints with core.quotePath=false: the quote forces quoting, the emoji stays raw */
    const [f] = parseUnifiedPatch(
      ['diff --git "a/🎉\\"quote.txt" "b/🎉\\"quote.txt"', "new file mode 100644", "--- /dev/null", '+++ "b/🎉\\"quote.txt"', "@@ -0,0 +1 @@", "+x", ""].join("\n"),
    );
    expect(f).toMatchObject({ path: '🎉"quote.txt', status: "added", additions: 1 });
    const [g] = parseUnifiedPatch(['diff --git "a/caf\\303\\251 \\360\\237\\216\\211.txt" "b/caf\\303\\251 \\360\\237\\216\\211.txt"', '--- "a/caf\\303\\251 \\360\\237\\216\\211.txt"', '+++ "b/caf\\303\\251 \\360\\237\\216\\211.txt"'].join("\n"));
    expect(g.path).toBe("café 🎉.txt");
  });

  it("doesn't read the final newline of a cut-off patch as an empty line", () => {
    const [f] = parseUnifiedPatch("diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1,5 +1,5 @@\n a\n-b\n+B\n");
    expect(f.hunks[0].lines.map((l) => [l.type, l.text])).toEqual([
      ["ctx", "a"],
      ["del", "b"],
      ["add", "B"],
    ]);
    /* an empty context line inside the hunk is still one */
    const [g] = parseUnifiedPatch("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n\n-b\n+B\n");
    expect(g.hunks[0].lines.map((l) => l.type)).toEqual(["ctx", "ctx", "del", "add"]);
  });
});

describe("binary files", () => {
  it("keeps added and deleted status and flags them as binary", () => {
    const files = parseUnifiedPatch(
      [
        "diff --git a/pic.png b/pic.png",
        "new file mode 100644",
        "index 0000000..1111111",
        "Binary files /dev/null and b/pic.png differ",
        "diff --git a/old.bin b/old.bin",
        "deleted file mode 100644",
        "index 2222222..0000000",
        "Binary files a/old.bin and /dev/null differ",
        "diff --git a/img.png b/img.png",
        "index 3..4 100644",
        "Binary files a/img.png and b/img.png differ",
      ].join("\n"),
    );
    expect(files.map((f) => [f.path, f.status, f.binary])).toEqual([
      ["pic.png", "added", true],
      ["old.bin", "deleted", true],
      ["img.png", "binary", true],
    ]);
  });
});
