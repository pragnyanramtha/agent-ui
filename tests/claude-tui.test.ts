import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedProfile } from "@/lib/server/profiles";

/* Web-started Claude sessions in a kept tmux TUI (lib/server/claude-tui.ts): the launch argv, the folder trust
 * dialog, and a TUI that exits before it starts. The pane, the transcript and the terminal service are fakes. */

const screen = { text: "" };
const keys: string[] = [];
const launches: Record<string, unknown>[] = [];
const state = { transcript: false, exited: false };

vi.mock("@/lib/server/input", () => ({
  paneScreen: async () => screen.text,
  pressKey: async (_t: unknown, key: string) => {
    keys.push(key);
    /* answering the dialog clears it */
    if (key === "Enter") screen.text = "";
  },
}));
vi.mock("@/lib/server/sessions", () => ({
  findSessionFile: async () => (state.transcript ? "/x/session.jsonl" : null),
  liveTerminals: async () => new Map(),
}));
vi.mock("@/lib/server/terminals", () => ({
  launchAgent: async (l: Record<string, unknown>) => (launches.push(l), { id: "agentu-abcd", backing: "tmux" }),
  listTerminals: async () => ({ tmux: true, terminals: [{ id: "agentu-abcd", exited: state.exited ? 1 : null }] }),
}));

const { startClaudeTui, TuiStartError } = await import("@/lib/server/claude-tui");
const { interactiveArgs } = await vi.importActual<typeof import("@/lib/server/terminals")>("@/lib/server/terminals");

const profile = { id: "claude", label: "Claude", agent: "claude", bin: "", args: [], env: {}, models: [], fallback: [], builtin: true } as unknown as ResolvedProfile;

beforeEach(() => {
  screen.text = "";
  keys.length = 0;
  launches.length = 0;
  state.transcript = false;
  state.exited = false;
});

describe("Claude's TUI argv", () => {
  it("starts a new session under a given id with model, effort and approval mode", () => {
    expect(interactiveArgs("claude", { newSession: "u1", model: "claude-opus-5-5", effort: "high", permissionMode: "plan", cwd: "/w" })).toEqual([
      "--session-id", "u1", "--model", "claude-opus-5-5", "--effort", "high", "--permission-mode", "plan",
    ]);
  });

  it("Bypass skips the one-time confirmation screen; resume wins over a new id; Ask adds nothing", () => {
    const a = interactiveArgs("claude", { session: "s1", newSession: "u1", permissionMode: "bypassPermissions", cwd: "/w" });
    expect(a.slice(0, 4)).toEqual(["--resume", "s1", "--permission-mode", "bypassPermissions"]);
    expect(JSON.parse(a[a.indexOf("--settings") + 1])).toEqual({ skipDangerousModePermissionPrompt: true });
    expect(interactiveArgs("claude", { permissionMode: "default", cwd: "/w" })).toEqual([]);
  });
});

describe("starting a Claude session in tmux", () => {
  it("moves off 'No, exit' onto 'Yes, I trust', then returns once the transcript exists", async () => {
    screen.text = "Do you trust the files in this folder?\n  1. Yes, I trust this folder\n❯ 2. No, exit\n";
    setTimeout(() => (screen.text = screen.text.replace("  1. Yes", "❯ 1. Yes").replace("❯ 2. No", "  2. No")), 700);
    setTimeout(() => (state.transcript = true), 1600);
    const r = await startClaudeTui({ profile, cwd: "/w", text: "hi", effort: "low", permissionMode: "acceptEdits" });
    expect(keys).toEqual(["Down", "Enter"]);
    expect(r.terminal).toBe("agentu-abcd");
    expect(launches[0]).toMatchObject({ newSession: r.id, sessionKey: r.id, session: null, prompt: "hi", effort: "low", permissionMode: "acceptEdits", backing: "tmux" });
  });

  it("reports a TUI that exits before it starts, naming its terminal", async () => {
    screen.text = "Error: not logged in\n";
    state.exited = true;
    const err = await startClaudeTui({ profile, cwd: "/w", text: "hi", permissionMode: "default" }).catch((e) => e);
    expect(err).toBeInstanceOf(TuiStartError);
    expect(err.message).toContain("not logged in");
    expect(err.terminal).toBe("agentu-abcd");
  });
});
