import { describe, expect, it } from "vitest";
import { shareRows } from "@/lib/client/useSessions";
import type { SessionSummary } from "@/lib/types";

const row = (id: string, patch: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  agent: "claude",
  title: `t ${id}`,
  cwd: "/w",
  project: "w",
  mtime: 1,
  size: 10,
  terminal: null,
  web: null,
  ...patch,
});
/* a fresh poll answer: equal values, new objects */
const copy = (rows: SessionSummary[]) => JSON.parse(JSON.stringify(rows)) as SessionSummary[];

describe("shareRows", () => {
  it("keeps the previous list when nothing changed", () => {
    const prev = [row("a"), row("b", { terminal: { pid: 3, status: "busy", name: null, multiplexer: "tmux" } })];
    expect(shareRows(prev, copy(prev))).toBe(prev);
  });

  it("reuses unchanged rows and replaces only the one that changed", () => {
    const prev = [row("a"), row("b"), row("c")];
    const next = copy(prev);
    next[1].mtime = 2;
    const out = shareRows(prev, next);
    expect(out).not.toBe(prev);
    expect(out[0]).toBe(prev[0]);
    expect(out[1]).toBe(next[1]);
    expect(out[2]).toBe(prev[2]);
  });

  it("follows the new order and new rows, reusing objects by id", () => {
    const prev = [row("a"), row("b")];
    const next = copy([prev[1], row("c"), prev[0]]);
    const out = shareRows(prev, next);
    expect(out.map((s) => s.id)).toEqual(["b", "c", "a"]);
    expect(out[0]).toBe(prev[1]);
    expect(out[2]).toBe(prev[0]);
  });

  it("notices nested changes and added or removed fields", () => {
    const prev = [row("a", { web: null }), row("b")];
    const next = copy(prev);
    next[0].pinned = true;
    next[1].terminal = { pid: 9, status: "idle", name: null, multiplexer: null };
    const out = shareRows(prev, next);
    expect(out[0]).toBe(next[0]);
    expect(out[1]).toBe(next[1]);
    expect(shareRows(undefined, next)).toBe(next);
  });
});
