import { describe, expect, it } from "vitest";
import { editorUrl, SSH_HOST } from "@/lib/editor-links";
import { parseValue, settingDef } from "@/lib/settings-schema";

describe("editor links over SSH", () => {
  it("builds VS Code and Cursor remote URLs for folders and files", () => {
    expect(editorUrl("vscode", "box", "/home/me/app")).toBe("vscode://vscode-remote/ssh-remote+box/home/me/app");
    expect(editorUrl("vscode", "me@box", "/home/me/app/src/a.ts", 12)).toBe("vscode://vscode-remote/ssh-remote+me@box/home/me/app/src/a.ts:12");
    expect(editorUrl("cursor", "box", "/srv/x.py", 3, 7)).toBe("cursor://vscode-remote/ssh-remote+box/srv/x.py:3:7");
  });

  it("builds Zed's ssh URL", () => {
    expect(editorUrl("zed", "box", "/home/me/app")).toBe("zed://ssh/box/home/me/app");
    expect(editorUrl("zed", "me@box:2222", "/home/me/app/main.rs", 40)).toBe("zed://ssh/me@box:2222/home/me/app/main.rs:40");
  });

  it("escapes path segments and tidies slashes", () => {
    expect(editorUrl("vscode", "box", "/home/me/my app/#1?.md")).toBe("vscode://vscode-remote/ssh-remote+box/home/me/my%20app/%231%3F.md");
    expect(editorUrl("vscode", "box", "/home//me/app/")).toBe("vscode://vscode-remote/ssh-remote+box/home/me/app");
    expect(editorUrl("vscode", "box", "/")).toBe("vscode://vscode-remote/ssh-remote+box/");
  });

  it("has no link without a usable host or for relative paths", () => {
    expect(editorUrl("vscode", "", "/a")).toBeNull();
    expect(editorUrl("vscode", "  ", "/a")).toBeNull();
    expect(editorUrl("vscode", "bad host", "/a")).toBeNull();
    expect(editorUrl("vscode", "box/../x", "/a")).toBeNull();
    expect(editorUrl("zed", "box", "src/a.ts")).toBeNull();
  });

  it("only stores host names the URL can carry", () => {
    expect(SSH_HOST.test("me@[::1]:22")).toBe(true);
    expect(parseValue(settingDef("editorHost"), "dev-box.local").ok).toBe(true);
    expect(parseValue(settingDef("editorHost"), "dev box").ok).toBe(false);
    expect(parseValue(settingDef("editorHost"), "x/y").ok).toBe(false);
  });
});
