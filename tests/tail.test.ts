import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { tailFile, type Gap } from "@/lib/server/tail";
import { initial, reducer } from "@/lib/client/useSession";
import type { Entry } from "@/lib/types";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentu-tail-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

let n = 0;
const line = (text: string) =>
  `${JSON.stringify({ type: "user", uuid: `u${++n}`, timestamp: new Date().toISOString(), message: { role: "user", content: text } })}\n`;
const texts = (got: Entry[]) => got.filter((e) => e.kind === "user").map((e) => (e as { text: string }).text);

describe("transcript tail", () => {
  it("streams appended lines to a viewer from where its history ended", async () => {
    const f = path.join(dir, "a.jsonl");
    fs.writeFileSync(f, line("old"));
    const got: Entry[] = [];
    const off = tailFile(f, fs.statSync(f).size, (e) => got.push(...e));
    fs.appendFileSync(f, line("new one"));
    fs.appendFileSync(f, line("new two"));
    await vi.waitFor(() => expect(texts(got)).toEqual(["new one", "new two"]), { timeout: 4000 });
    off();
  });

  it("a half-written line waits until it's complete", async () => {
    const f = path.join(dir, "b.jsonl");
    fs.writeFileSync(f, "");
    const got: Entry[] = [];
    const off = tailFile(f, 0, (e) => got.push(...e));
    const l = line("split write");
    fs.appendFileSync(f, l.slice(0, 20));
    await new Promise((r) => setTimeout(r, 300));
    expect(got).toEqual([]);
    fs.appendFileSync(f, l.slice(20));
    await vi.waitFor(() => expect(texts(got)).toEqual(["split write"]), { timeout: 4000 });
    off();
  });

  it("a resume offset past the end doesn't replay the whole file", async () => {
    const f = path.join(dir, "c.jsonl");
    fs.writeFileSync(f, line("one") + line("two"));
    const got: Entry[] = [];
    const off = tailFile(f, 10_000_000, (e) => got.push(...e));
    await new Promise((r) => setTimeout(r, 2000));
    expect(got).toEqual([]);
    fs.appendFileSync(f, line("three"));
    await vi.waitFor(() => expect(texts(got)).toEqual(["three"]), { timeout: 4000 });
    off();
  });

  it("a viewer far behind gets the recent part, not the whole gap", async () => {
    const f = path.join(dir, "d.jsonl");
    const filler = line("x".repeat(100_000));
    fs.writeFileSync(f, line("very first") + filler.repeat(100));
    const live: Entry[] = [];
    const offLive = tailFile(f, fs.statSync(f).size, (e) => live.push(...e));
    const late: Entry[] = [];
    const offLate = tailFile(f, 0, (e) => late.push(...e));
    await vi.waitFor(() => expect(late.length).toBeGreaterThan(0), { timeout: 4000 });
    expect(texts(late)).not.toContain("very first");
    expect(late.length).toBeLessThanOrEqual(85);
    offLive();
    offLate();
  });

  it("a viewer far behind is told which bytes it missed, before the entries after them", async () => {
    const f = path.join(dir, "e.jsonl");
    const filler = line("x".repeat(100_000));
    fs.writeFileSync(f, line("very first") + filler.repeat(100));
    const size = fs.statSync(f).size;
    const offLive = tailFile(f, size, () => undefined);
    const order: string[] = [];
    const gaps: Gap[] = [];
    const offLate = tailFile(
      f,
      0,
      (e, end) => order.push(`entries:${e.length}:${end}`),
      (g) => (gaps.push(g), order.push("gap")),
    );
    await vi.waitFor(() => expect(order.length).toBe(2), { timeout: 4000 });
    expect(order[0]).toBe("gap");
    expect(gaps[0].from).toBe(0);
    expect(gaps[0].to).toBeGreaterThan(size - 8 * 1024 * 1024);
    /* the gap ends on a line boundary: what follows is the first entry the viewer got */
    expect(fs.readFileSync(f).subarray(gaps[0].to - 1, gaps[0].to).toString()).toBe("\n");
    /* a viewer close enough isn't told anything */
    const near: Gap[] = [];
    const offNear = tailFile(f, size - filler.length, () => undefined, (g) => near.push(g));
    await new Promise((r) => setTimeout(r, 300));
    expect(near).toEqual([]);
    offLive();
    offLate();
    offNear();
  });

  it("today's client ignores the gap event", () => {
    const s = initial();
    expect(reducer(s, { type: "event", event: { type: "gap", from: 0, to: 10 } })).toBe(s);
  });
});
