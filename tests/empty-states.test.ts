import { describe, expect, it } from "vitest";
import { folderErrorCopy, folderGoneCopy, folderGoneMessage, isUnreachable, launcherEmpty, noMatchCopy, sessionsErrorCopy, sidebarEmpty, sidebarEmptyCopy } from "@/lib/empty-states";

describe("sessionsErrorCopy", () => {
  it("calls fetch failures and gateway errors unreachable, in every browser's wording", () => {
    for (const m of ["Failed to fetch", "NetworkError when attempting to fetch resource.", "Load failed", "Request failed (502)", "Request failed (530)", "Request failed (524)"]) {
      expect(isUnreachable(m), m).toBe(true);
      expect(sessionsErrorCopy(m).title).toBe("Can't reach the server");
    }
  });

  it("passes the server's own reason through as a sentence", () => {
    expect(sessionsErrorCopy("Request failed (500)")).toEqual({ title: "Couldn't load sessions", body: "Request failed (500)." });
    expect(sessionsErrorCopy("No permission to read ~/.claude.").body).toBe("No permission to read ~/.claude.");
    expect(isUnreachable("Request failed (404)")).toBe(false);
  });

  it("says offline when the browser is", () => {
    expect(sessionsErrorCopy("Failed to fetch", false).title).toBe("You're offline");
  });
});

describe("sidebarEmpty", () => {
  it("tells a first run, an agent filter and an all-snoozed list apart", () => {
    expect(sidebarEmpty({ shown: 0, awake: 0, filtered: false })).toBe("none");
    expect(sidebarEmpty({ shown: 0, awake: 0, filtered: true })).toBe("agent");
    expect(sidebarEmpty({ shown: 3, awake: 0, filtered: false })).toBe("snoozed");
    expect(sidebarEmpty({ shown: 3, awake: 1, filtered: true })).toBeNull();
  });

  it("names the agent and the next step", () => {
    expect(sidebarEmptyCopy("agent", "Codex").title).toBe("No Codex sessions yet");
    expect(sidebarEmptyCopy("none").body).toMatch(/New session/);
  });
});

describe("launcherEmpty", () => {
  it("is quiet while loading or when anything can start", () => {
    expect(launcherEmpty(null)).toBeNull();
    expect(launcherEmpty([{ installed: false }, { installed: true }])).toBeNull();
  });

  it("explains no installed agents and all-hidden agents differently", () => {
    expect(launcherEmpty([{ installed: false }, { installed: false }])?.title).toBe("No agents installed");
    expect(launcherEmpty([])?.title).toBe("No agents installed");
    expect(launcherEmpty([{ installed: true, hidden: true }])?.title).toBe("Every agent is hidden");
    expect(launcherEmpty([{ installed: true, hidden: true }, { installed: false }])?.title).toBe("No agents installed");
  });
});

describe("copy", () => {
  it("names the missing folder and what to do", () => {
    expect(folderGoneCopy("/srv/app").body).toContain("/srv/app");
    expect(folderGoneMessage("/srv/app")).toMatch(/^This session's folder is gone: \/srv\/app\. .+new session/);
  });

  it("quotes the search", () => {
    expect(noMatchCopy("  git  ", "Try another word.").title).toBe("Nothing matches “git”");
  });
});

describe("folderErrorCopy", () => {
  it("separates a missing folder, a refusal and no answer", () => {
    expect(folderErrorCopy("Nothing at /srv/old.", 404)).toEqual({ title: "That folder isn't there", body: "Nothing at /srv/old. It may have been moved or deleted." });
    expect(folderErrorCopy("No permission to open /root.", 403)).toEqual({ title: "Couldn't open this folder", body: "No permission to open /root." });
    expect(folderErrorCopy("").title).toBe("Can't reach the server");
    expect(folderErrorCopy("Request failed (502)", 502).title).toBe("Can't reach the server");
  });
});
