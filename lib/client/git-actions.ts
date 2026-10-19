/* Which git action the panel offers first, from the branch's state. Steps run in order; each has its own progress label. */

export type GitState = {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** changed files in the working tree */
  dirty: number;
  remote: boolean;
  gh: boolean;
  defaultBranch: string | null;
  /** undefined: gh couldn't tell */
  pr?: { url: string; number: number; state: string } | null;
};

export type GitStep = "commit" | "push" | "pull" | "pr";
export type GitActionId = "commit" | "commit-push" | "commit-push-pr" | "push" | "publish" | "pull" | "sync" | "pr" | "view-pr" | "none";
export type GitAction = {
  id: GitActionId;
  label: string;
  steps: GitStep[];
  /** why it can't run; the button shows disabled with this as its hint */
  disabled?: string;
  href?: string;
};

export const STEP_LABEL: Record<GitStep, string> = {
  commit: "Committing…",
  push: "Pushing…",
  pull: "Pulling…",
  pr: "Creating pull request…",
};

export const isDefaultBranch = (s: GitState) => Boolean(s.branch) && (s.branch === s.defaultBranch || s.branch === "main" || s.branch === "master");

/** a PR makes sense from here: gh is there, the branch isn't the default one, and none is open yet */
const canOpenPr = (s: GitState) => s.gh && s.remote && Boolean(s.branch) && !isDefaultBranch(s) && s.pr === null;
const openPr = (s: GitState) => (s.pr && s.pr.state === "OPEN" ? s.pr : null);

const A = {
  commit: { id: "commit", label: "Commit", steps: ["commit"] },
  commitPush: { id: "commit-push", label: "Commit and push", steps: ["commit", "push"] },
  commitPushPr: { id: "commit-push-pr", label: "Commit, push and create PR", steps: ["commit", "push", "pr"] },
  push: { id: "push", label: "Push", steps: ["push"] },
  publish: { id: "publish", label: "Publish branch", steps: ["push"] },
  pull: { id: "pull", label: "Pull", steps: ["pull"] },
  pr: { id: "pr", label: "Create PR", steps: ["pr"] },
} satisfies Record<string, GitAction>;

export const COMMIT: GitAction = A.commit;

const diverged = (s: GitState): GitAction => ({
  id: "sync",
  label: "Sync",
  steps: [],
  disabled: `${s.branch} and ${s.upstream} have both moved on. Merge or rebase in a terminal.`,
});

/** The one action the state calls for. */
export function primaryAction(s: GitState): GitAction {
  if (!s.branch) return s.dirty ? A.commit : { id: "none", label: "Not on a branch", steps: [], disabled: "Check out a branch to commit or push." };
  if (s.dirty) {
    if (!s.remote || s.behind > 0) return A.commit;
    return canOpenPr(s) ? A.commitPushPr : A.commitPush;
  }
  if (!s.remote) return { id: "none", label: "Commit", steps: [], disabled: "No changes to commit." };
  if (!s.upstream) return A.publish;
  if (s.ahead > 0 && s.behind > 0) return diverged(s);
  if (s.ahead > 0) return A.push;
  if (s.behind > 0) return A.pull;
  const pr = openPr(s);
  if (pr) return { id: "view-pr", label: "View PR", steps: [], href: pr.url };
  if (canOpenPr(s)) return A.pr;
  return { id: "none", label: "Up to date", steps: [], disabled: "Nothing to commit, push or pull." };
}

/** Everything else that can run now, for the menu next to the primary button. */
export function otherActions(s: GitState): GitAction[] {
  const main = primaryAction(s).id;
  const out: GitAction[] = [];
  const push = s.upstream ? A.push : A.publish;
  out.push(s.dirty ? A.commit : { ...A.commit, disabled: "No changes to commit." });
  if (s.remote && s.branch) {
    if (s.dirty && !s.behind) out.push(A.commitPush);
    out.push(
      s.ahead > 0 && s.behind > 0
        ? { ...push, disabled: "Pull first: the remote has commits this branch doesn't." }
        : s.upstream && !s.ahead
          ? { ...push, disabled: "Nothing to push." }
          : push,
    );
    out.push(!s.upstream ? { ...A.pull, disabled: "Publish the branch first." } : !s.behind ? { ...A.pull, disabled: "Already up to date." } : s.ahead ? { ...A.pull, disabled: diverged(s).disabled } : A.pull);
    const pr = openPr(s);
    if (pr) out.push({ id: "view-pr", label: `View PR #${pr.number}`, steps: [], href: pr.url });
    else if (s.gh && !isDefaultBranch(s)) out.push(s.dirty ? { ...A.pr, disabled: "Commit the changes first." } : A.pr);
  }
  return out.filter((a) => a.id !== main);
}

/** Pushing straight to the default branch asks first. */
export const needsDefaultBranchConfirm = (s: GitState, a: GitAction) => a.steps.includes("push") && isDefaultBranch(s);
