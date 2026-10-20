import { describe, expect, it } from "vitest";
import { profileArgs } from "@/lib/server/runner";

describe("Claude profile args", () => {
  it("keeps long flags as extraArgs and passes short flags with their values through", () => {
    expect(profileArgs(["--setting-sources", "user", "-d", "api", "--verbose", "--max-turns=3", "-c"], "/usr/bin/claude")).toEqual({
      extraArgs: { "setting-sources": "user", verbose: null, "max-turns": "3" },
      executableArgs: ["-d", "api", "-c"],
    });
  });

  it("works with the SDK's own binary (no path)", () => {
    expect(profileArgs(["-d", "x"], undefined)).toEqual({ executableArgs: ["-d", "x"] });
  });

  it("can't put short flags in front of a .js CLI, which runs under node", () => {
    expect(profileArgs(["-d", "x", "--verbose"], "/opt/claude/cli.js")).toEqual({ extraArgs: { verbose: null } });
  });
});
