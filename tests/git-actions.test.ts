import { describe, expect, it } from "vitest";
import { needsDefaultBranchConfirm, otherActions, primaryAction, type GitState } from "@/lib/client/git-actions";

const base: GitState = { branch: "feat", upstream: "origin/feat", ahead: 0, behind: 0, dirty: 0, remote: true, gh: true, defaultBranch: "main", pr: null };
const at = (s: Partial<GitState>) => ({ ...base, ...s });
const main = (s: Partial<GitState>) => primaryAction(at(s));

describe("primary git action", () => {
  it("commits when there's no remote", () => {
    expect(main({ dirty: 2, remote: false, upstream: null, gh: false })).toMatchObject({ id: "commit", label: "Commit", steps: ["commit"] });
  });

  it("commits, pushes and opens a PR when there's none yet", () => {
    expect(main({ dirty: 1 })).toMatchObject({ id: "commit-push-pr", label: "Commit, push and create PR", steps: ["commit", "push", "pr"] });
  });

  it("commits and pushes without gh, on the default branch, or when a PR exists", () => {
    expect(main({ dirty: 1, gh: false }).id).toBe("commit-push");
    expect(main({ dirty: 1, branch: "main", upstream: "origin/main" }).id).toBe("commit-push");
    expect(main({ dirty: 1, pr: { number: 3, url: "https://x/pull/3", state: "OPEN" } }).id).toBe("commit-push");
    /* gh couldn't tell (not GitHub, or not logged in): no PR step */
    expect(main({ dirty: 1, pr: undefined }).id).toBe("commit-push");
  });

  it("only commits while the remote has commits to pull", () => {
    expect(main({ dirty: 1, behind: 2 }).id).toBe("commit");
  });

  it("pushes when ahead, pulls when only behind, and won't sync a diverged branch", () => {
    expect(main({ ahead: 2 })).toMatchObject({ id: "push", label: "Push" });
    expect(main({ behind: 1 })).toMatchObject({ id: "pull", label: "Pull" });
    const sync = main({ ahead: 1, behind: 1 });
    expect(sync).toMatchObject({ id: "sync", label: "Sync" });
    expect(sync.disabled).toMatch(/both moved on/);
  });

  it("publishes a branch with no upstream", () => {
    expect(main({ upstream: null, ahead: 0 })).toMatchObject({ id: "publish", label: "Publish branch", steps: ["push"] });
  });

  it("offers a PR on a clean, pushed branch, and links to an open one", () => {
    expect(main({})).toMatchObject({ id: "pr", label: "Create PR" });
    expect(main({ pr: { number: 4, url: "https://x/pull/4", state: "OPEN" } })).toMatchObject({ id: "view-pr", href: "https://x/pull/4" });
    expect(main({ branch: "main", upstream: "origin/main" })).toMatchObject({ id: "none", label: "Up to date" });
  });

  it("disables what can't run", () => {
    expect(main({ remote: false, upstream: null }).disabled).toBe("No changes to commit.");
    expect(main({ branch: null }).disabled).toMatch(/Check out a branch/);
  });
});

describe("other git actions", () => {
  it("leave out the primary and explain what's disabled", () => {
    const rest = otherActions(at({ dirty: 1 }));
    expect(rest.map((a) => a.id)).toEqual(["commit", "commit-push", "push", "pull", "pr"]);
    expect(rest.find((a) => a.id === "push")?.disabled).toBe("Nothing to push.");
    expect(rest.find((a) => a.id === "pull")?.disabled).toBe("Already up to date.");
    expect(rest.find((a) => a.id === "pr")?.disabled).toBe("Commit the changes first.");
  });

  it("offer the PR link and no PR step on the default branch", () => {
    expect(otherActions(at({ ahead: 1, pr: { number: 9, url: "u", state: "OPEN" } })).find((a) => a.id === "view-pr")?.label).toBe("View PR #9");
    expect(otherActions(at({ branch: "main", ahead: 1 })).some((a) => a.id === "pr")).toBe(false);
  });

  it("show Publish instead of Push before the first push", () => {
    const rest = otherActions(at({ dirty: 1, upstream: null }));
    expect(rest.find((a) => a.id === "publish")?.disabled).toBeUndefined();
    expect(rest.find((a) => a.id === "pull")?.disabled).toBe("Publish the branch first.");
  });
});

describe("default branch", () => {
  it("asks before pushing to it", () => {
    expect(needsDefaultBranchConfirm(at({ branch: "main" }), primaryAction(at({ branch: "main", ahead: 1 })))).toBe(true);
    expect(needsDefaultBranchConfirm(at({ branch: "trunk", defaultBranch: "trunk" }), { id: "push", label: "Push", steps: ["push"] })).toBe(true);
    expect(needsDefaultBranchConfirm(at({ branch: "master", defaultBranch: null }), { id: "push", label: "Push", steps: ["push"] })).toBe(true);
    expect(needsDefaultBranchConfirm(at({ ahead: 1 }), primaryAction(at({ ahead: 1 })))).toBe(false);
    expect(needsDefaultBranchConfirm(at({ branch: "main" }), { id: "commit", label: "Commit", steps: ["commit"] })).toBe(false);
  });

  it("doesn't ask when the setting is off", () => {
    expect(needsDefaultBranchConfirm(at({ branch: "main" }), { id: "push", label: "Push", steps: ["push"] }, false)).toBe(false);
  });
});
