import { describe, expect, it } from "vitest";
import { sessionStatus } from "@/lib/client/session-status";
import type { PendingAsk, RunState, SessionSummary } from "@/lib/types";

const permission: PendingAsk = { kind: "permission", requestId: "p", toolName: "Bash", title: "x", description: null, input: {}, canAlwaysAllow: false };
const question: PendingAsk = { kind: "question", requestId: "q", questions: [] };
const web = (status: RunState["status"], pending: PendingAsk[] = []): RunState => ({
  status,
  model: null,
  permissionMode: "default",
  slashCommands: [],
  pending,
  error: status === "error" ? "boom" : null,
  costUsd: null,
  sessionId: "",
});
type Row = Pick<SessionSummary, "terminal" | "web">;
const term = (status: string): Row => ({ web: null, terminal: { pid: 2, status, multiplexer: null, name: null } });

describe("sessionStatus", () => {
  it("puts an approval above a question, a question above working", () => {
    expect(sessionStatus({ terminal: null, web: web("running", [question, permission]) }, true)).toBe("approval");
    expect(sessionStatus({ terminal: null, web: web("running", [question]) }, true)).toBe("input");
    expect(sessionStatus({ terminal: null, web: web("running") }, true)).toBe("working");
    expect(sessionStatus({ terminal: null, web: web("starting") }, false)).toBe("working");
  });

  it("puts working above failed and failed above an unseen finish", () => {
    expect(sessionStatus({ terminal: null, web: web("error") }, true)).toBe("failed");
    expect(sessionStatus({ terminal: null, web: web("idle") }, true)).toBe("unread");
    expect(sessionStatus({ terminal: null, web: null }, true)).toBe("unread");
  });

  it("reads a terminal's own status when there is no web run", () => {
    expect(sessionStatus(term("busy"), false)).toBe("working");
    expect(sessionStatus(term("idle"), false)).toBeNull();
    expect(sessionStatus(term("unknown"), true)).toBe("unread");
  });

  it("says nothing about a quiet session", () => {
    expect(sessionStatus({ terminal: null, web: null }, false)).toBeNull();
    expect(sessionStatus({ terminal: null, web: web("idle") }, false)).toBeNull();
    expect(sessionStatus({ terminal: null, web: web("closed") }, false)).toBeNull();
  });
});

describe("nativeId", async () => {
  const { nativeId } = await import("@/components/claude/SessionList");
  it("drops the agent prefix, keeps a bare Claude id", () => {
    expect(nativeId("codex:019a-thread")).toBe("019a-thread");
    expect(nativeId("0b9c3d8e-1f2a-4b5c-8d7e-6f5a4b3c2d1e")).toBe("0b9c3d8e-1f2a-4b5c-8d7e-6f5a4b3c2d1e");
  });
});
