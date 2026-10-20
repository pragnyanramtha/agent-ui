import { describe, expect, it } from "vitest";
import { parseLines } from "@/lib/server/transcript";

/* Messages sent while Claude is mid-turn are stored as queued_command attachments. */
const queued = (prompt: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "attachment", uuid: "q1", timestamp: "2026-10-19T00:00:00Z", attachment: { type: "queued_command", prompt, ...extra } });

describe("queued messages", () => {
  it("a plain text prompt", () => {
    expect(parseLines([queued("also fix the tests")])).toEqual([{ kind: "user", id: "q1", ts: "2026-10-19T00:00:00Z", text: "also fix the tests", images: 0 }]);
  });

  it("a prompt of content blocks keeps its text and counts its images", () => {
    const prompt = [{ type: "text", text: "look at this" }, { type: "image", source: { type: "base64", data: "" } }, { type: "text", text: "and this" }, { type: "image", source: {} }];
    expect(parseLines([queued(prompt)])).toEqual([{ kind: "user", id: "q1", ts: "2026-10-19T00:00:00Z", text: "look at this\n\nand this", images: 2 }]);
  });

  it("only images", () => {
    expect(parseLines([queued([{ type: "image", source: {} }])])).toEqual([{ kind: "user", id: "q1", ts: "2026-10-19T00:00:00Z", text: "", images: 1 }]);
  });

  it("not from a person, or empty: nothing", () => {
    expect(parseLines([queued([{ type: "text", text: "hook said" }], { origin: { kind: "hook" } })])).toEqual([]);
    expect(parseLines([queued([])])).toEqual([]);
    expect(parseLines([queued({ weird: true })])).toEqual([]);
  });
});
