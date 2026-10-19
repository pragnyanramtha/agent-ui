/* Terminal tabs: when an open request is an existing tab, and what each tab is called. */

type Target = { term?: string; tmux?: string; session?: string; pid?: number; cwd?: string };

/** Same server-side terminal. A plain shell request (just a folder) always means a new shell. */
export function sameTarget(a: Target, b: Target): boolean {
  if (a.term || b.term) return a.term === b.term;
  if (a.tmux || b.tmux) return a.tmux === b.tmux;
  if (a.session || b.session) return a.session === b.session;
  if (a.pid || b.pid) return a.pid === b.pid;
  return false;
}

/** Short tab names: a shell's folder name, numbered when several tabs share one */
export function tabNames(labels: string[]): string[] {
  const seen = new Map<string, number>();
  return labels.map((label) => {
    const shell = /^Shell(?::\s*(.*))?$/.exec(label);
    const base = shell ? (shell[1]?.replace(/\/+$/, "").split("/").pop() || shell[1] || "Shell") : label;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n > 1 ? `${base} ${n}` : base;
  });
}
