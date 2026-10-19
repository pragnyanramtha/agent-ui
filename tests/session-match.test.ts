import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@/lib/types";
import { matchSession, queryWords, score } from "@/lib/session-match";
import { mergeFound } from "@/components/claude/CommandPalette";

const row = (id: string, title: string, cwd = "/srv/agent-u"): SessionSummary => ({
  id,
  agent: "claude",
  title,
  cwd,
  project: cwd.split("/").pop() ?? "",
  mtime: 1,
  size: 1,
  terminal: null,
  web: null,
});

describe("session matching", () => {
  it("ranks prefix over word start over substring over loose characters", () => {
    expect(score("Fix login", "fix")).toBe(100);
    expect(score("Quick fix", "fix")).toBe(80);
    expect(score("Prefix", "fix")).toBe(60);
    expect(score("agent-u", "agu")).toBe(20);
    expect(score("agent-u", "z")).toBe(0);
  });

  it("needs every word to land", () => {
    expect(matchSession(row("a", "Fix login"), ["fix", "agent"])).toBeGreaterThan(0);
    expect(matchSession(row("a", "Fix login"), ["fix", "zebra"])).toBe(0);
  });

  it("splits a query into lowercase words", () => {
    expect(queryWords("  Fix   Login ")).toEqual(["fix", "login"]);
    expect(queryWords("   ")).toEqual([]);
  });
});

describe("mergeFound", () => {
  const listed = [row("a", "One"), row("b", "Two")];

  it("adds what the list doesn't have after it", () => {
    expect(mergeFound(listed, [row("b", "Two (stale)"), row("c", "Three")])?.map((s) => s.title)).toEqual(["One", "Two", "Three"]);
  });

  it("keeps the list itself when nothing is new", () => {
    expect(mergeFound(listed, [row("a", "One")])).toBe(listed);
    expect(mergeFound(listed, null)).toBe(listed);
    expect(mergeFound(null, [row("c", "Three")])).toBeNull();
  });
});
