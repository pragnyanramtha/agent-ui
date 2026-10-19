import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type { SessionSummary } from "@/lib/types";

/* config.ts reads CLAUDE_HOME (and profiles.ts AGENT_U_HOME) when loaded, so the temp home comes first */
const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentu-list-"));
process.env.AGENT_U_HOME = home;
process.env.CLAUDE_HOME = path.join(home, "claude");

const OLD_CODEX: SessionSummary = {
  id: "codex:old",
  agent: "codex",
  title: "Old codex chat",
  cwd: "/srv/old",
  project: "old",
  mtime: 1000,
  size: 10,
  terminal: null,
  web: null,
};
vi.mock("@/lib/server/agents/bridge", () => ({ agentSummaries: async () => [OLD_CODEX] }));

const dir = path.join(home, "claude", "projects", "-srv-app");
fs.mkdirSync(dir, { recursive: true });
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T0 = Date.UTC(2026, 0, 1) / 1000;
/* 60 titled transcripts, one a minute; the 5 newest files have no title (they never show) */
for (let n = 0; n < 65; n++) {
  const titled = n >= 5;
  const title = n === 64 ? "Needle in the hay" : `Session ${n}`;
  const lines = titled ? [{ type: "custom-title", customTitle: title }, { type: "user", cwd: "/srv/app" }] : [{ type: "file-history-snapshot" }];
  const file = path.join(dir, `${uuid(n)}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  fs.utimesSync(file, T0 - n * 60, T0 - n * 60);
}

const { GET } = await import("@/app/api/sessions/route");
const { setSessionMeta } = await import("@/lib/server/profiles");

afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

type Page = { sessions: SessionSummary[]; projects?: string[]; more?: boolean };
async function get(query: string): Promise<Page> {
  const url = new URL(`http://127.0.0.1:3311/api/sessions${query}`);
  const res = await GET({ nextUrl: url, url: url.href, headers: new Headers() } as unknown as NextRequest);
  return (await res.json()) as Page;
}
const ids = (p: Page) => p.sessions.map((s) => s.id);

describe("GET /api/sessions", () => {
  it("returns the newest page and says there is more", async () => {
    const page = await get("?limit=20");
    expect(page.more).toBe(true);
    /* the 5 untitled files take part of the window, so 15 rows */
    expect(ids(page)).toEqual(Array.from({ length: 15 }, (_, i) => uuid(i + 5)));
    expect(page.projects).toEqual(["/srv/app"]);
  });

  it("counts untitled transcripts when telling whether there is more", async () => {
    expect((await get("?limit=60")).more).toBe(true);
    const all = await get("?limit=65");
    expect(all.more).toBe(false);
    expect(all.sessions).toHaveLength(61);
    expect(all.sessions.at(-1)?.id).toBe(OLD_CODEX.id);
  });

  it("keeps a page a prefix of the next one", async () => {
    const small = ids(await get("?limit=30"));
    const big = ids(await get("?limit=50"));
    expect(big.slice(0, small.length)).toEqual(small);
  });

  it("keeps pinned sessions past the page", async () => {
    setSessionMeta(OLD_CODEX.id, { pinned: true });
    try {
      const page = await get("?limit=20");
      expect(page.sessions.at(-1)).toMatchObject({ id: OLD_CODEX.id, pinned: true });
      expect(page.sessions).toHaveLength(16);
    } finally {
      setSessionMeta(OLD_CODEX.id, { pinned: false });
    }
  });

  it("falls back to the default page for a bad limit", async () => {
    expect((await get("?limit=nope")).sessions).toHaveLength(61);
    const one = await get("?limit=0");
    expect(one).toMatchObject({ sessions: [], more: true });
    expect(ids(await get("?limit=6"))).toEqual([uuid(5)]);
  });

  it("searches past the loaded pages", async () => {
    const found = await get("?q=needle");
    expect(ids(found)).toEqual([uuid(64)]);
    expect(found.more).toBeUndefined();
    expect((await get("?q=%20%20")).sessions).toEqual([]);
    expect(ids(await get("?q=codex old"))).toEqual([OLD_CODEX.id]);
  });
});
