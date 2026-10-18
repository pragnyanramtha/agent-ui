"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GitBranch, NavArrowDown, Xmark } from "iconoir-react";
import { api, timeAgo } from "@/lib/client/api";
import { confirmAsk } from "./Ask";
import { DiffView, type DiffScope } from "./DiffView";

type Status = {
  root: string;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: { path: string; state: string }[];
  remote: boolean;
  gh: boolean;
};
type Checkpoint = { id: string; commit: string; at: number; label: string };
type FileStat = { path: string; added: number; removed: number; binary: boolean };
type Data = { repo: Status | null; cwd: string; checkpoints?: Checkpoint[] };

const btn = "tap relative inline-flex h-9 shrink-0 items-center justify-center rounded-full px-3.5 text-[13px] font-medium transition-colors duration-150 disabled:opacity-40 sm:h-8";
const primary = `${btn} bg-ink text-surface`;
const quiet = `${btn} text-ink-2 shadow-btn hover:bg-hover hover:text-ink`;

const STATE: Record<string, string> = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", "?": "new", U: "conflict" };
const stateOf = (s: string) => STATE[s.trim()[0] ?? ""] ?? s.trim();

/** The session folder's git: branch, commit / push / pull request, and checkpoints to rewind the files to. */
export function GitPanel({ session, busy, onClose, view: initialView = "diff" }: { session: string; busy: boolean; onClose: () => void; view?: "diff" | "commit" }) {
  const [view, setView] = useState(initialView);
  const [target, setTarget] = useState<{ scope: DiffScope; checkpoint?: string; n: number }>({ scope: "uncommitted", n: 0 });
  const [rev, setRev] = useState(0);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; href?: string } | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [showFiles, setShowFiles] = useState(false);
  const [since, setSince] = useState<{ id: string; files: FileStat[] | null } | null>(null);
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const load = useCallback(async () => {
    try {
      setData(await api<Data>(`/api/git?session=${encodeURIComponent(session)}`));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [session]);

  useEffect(() => {
    void load();
    ref.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [load]);

  /* a turn that just ended likely changed files and added a checkpoint */
  useEffect(() => {
    if (!busy) void load();
  }, [busy, load]);

  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    setWorking(action);
    setNote(null);
    setError(null);
    try {
      return await api<Record<string, unknown>>("/api/git", { session, action, ...extra });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setWorking(null);
      setRev((n) => n + 1);
      void load();
    }
  };
  const openDiff = (scope: DiffScope, checkpoint?: string) => {
    setTarget((t) => ({ scope, checkpoint, n: t.n + 1 }));
    setView("diff");
  };

  const repo = data?.repo ?? null;
  const cps = data?.checkpoints ?? [];
  const dirty = repo?.files.length ?? 0;
  const mainline = repo?.branch === "main" || repo?.branch === "master";

  const commit = async () => {
    const r = await act("commit", { message });
    if (r?.commit) {
      setMessage("");
      setNote({ text: `Committed ${String(r.commit)}.` });
    }
  };
  const pushNow = async () => {
    const r = await act("push");
    if (r?.branch) setNote({ text: `Pushed ${String(r.branch)}.` });
  };
  const pr = async () => {
    const r = await act("pr");
    if (r?.url) setNote({ text: "Pull request ready.", href: String(r.url) });
  };
  const showSince = async (id: string) => {
    if (since?.id === id) return setSince(null);
    setSince({ id, files: null });
    const r = await act("since", { id });
    setSince(r ? { id, files: (r.files as FileStat[]) ?? [] } : null);
  };
  const rewindTo = async (cp: Checkpoint) => {
    const ok = await confirmAsk({
      title: "Rewind the files?",
      body: `Files in ${repo?.root ?? "the folder"} go back to how they were ${timeAgo(cp.at)} ago, before "${cp.label}". Files made since are removed. The conversation stays as it is, and the current state is saved as a checkpoint first, so you can rewind back.`,
      confirm: "Rewind files",
      danger: true,
    });
    if (!ok) return;
    const r = await act("rewind", { id: cp.id });
    if (r) setNote({ text: `Rewound: ${String(r.changed)} ${r.changed === 1 ? "file" : "files"} changed back${r.removed ? `, ${String(r.removed)} removed` : ""}.` });
  };

  return (
    <aside
      ref={ref}
      tabIndex={-1}
      aria-label="Git"
      className="absolute inset-0 z-20 flex flex-col bg-page outline-none lg:static lg:inset-auto lg:w-[440px] lg:shrink-0 lg:border-l lg:border-line xl:w-[520px]"
      style={{ animation: "fade-up 220ms cubic-bezier(0.23,1,0.32,1) both" }}
    >
      <div className="safe-top flex shrink-0 items-center gap-2 border-b border-line px-3 sm:px-4">
        <div className="flex h-14 min-w-0 flex-1 items-center gap-2">
          <span className="text-[14px] font-semibold text-ink">Git</span>
          {repo?.branch && (
            <span className="inline-flex min-w-0 items-center gap-1 rounded-full bg-inset px-2 py-0.5 font-mono text-[12px] text-ink-2 shadow-hairline" translate="no">
              <GitBranch width={12} height={12} strokeWidth={2} className="shrink-0" aria-hidden />
              <span className="truncate">{repo.branch}</span>
            </span>
          )}
          <button type="button" onClick={onClose} aria-label="Close git" className="tap relative ml-auto flex size-9 items-center justify-center rounded-[9px] text-ink-3 hover:bg-hover hover:text-ink">
            <Xmark width={16} height={16} strokeWidth={2} />
          </button>
        </div>
      </div>
      {repo && (
        <div role="tablist" aria-label="Git views" className="flex shrink-0 gap-1 border-b border-line px-3 py-2 sm:px-4">
          {(
            [
              ["diff", "Diff"],
              ["commit", "Commit & checkpoints"],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
              className={`h-8 rounded-full px-3 text-[13px] font-medium transition-colors duration-150 ${view === v ? "bg-inset text-ink shadow-hairline" : "text-ink-3 hover:text-ink"}`}
            >
              {label}
              {v === "diff" && dirty > 0 && <span className="ml-1.5 text-[11.5px] text-ink-3 tabular-nums">{dirty}</span>}
            </button>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3 sm:px-4">
        {error && <p className="mb-3 rounded-[10px] bg-red-tint px-3 py-2 text-[12.5px] text-red-ink">{error}</p>}
        {note && (
          <p role="status" className="mb-3 rounded-[10px] bg-inset px-3 py-2 text-[12.5px] text-ink-2 shadow-hairline">
            {note.text}{" "}
            {note.href && (
              <a href={note.href} target="_blank" rel="noreferrer" className="font-medium text-accent-ink underline-offset-2 hover:underline">
                Open it
              </a>
            )}
          </p>
        )}
        {!data && !error && <p className="py-8 text-center text-[13px] text-ink-3">Loading…</p>}
        {data && !repo && <p className="py-8 text-center text-[13px] text-ink-3">Not a git repository: {data.cwd}</p>}

        {repo && view === "diff" && <DiffView key={target.n} session={session} busy={busy} checkpoints={cps} scope={target.scope} checkpoint={target.checkpoint} refreshKey={rev} />}

        {repo && view === "commit" && (
          <>
            <section aria-label="Branch" className="mb-5">
              <p className="mb-2 text-[12.5px] text-ink-3">
                {repo.upstream ? (
                  <>
                    Tracks <span className="font-mono text-ink-2">{repo.upstream}</span>
                    {repo.ahead ? `, ${repo.ahead} ahead` : ""}
                    {repo.behind ? `, ${repo.behind} behind` : ""}
                    {!repo.ahead && !repo.behind ? ", up to date" : ""}.
                  </>
                ) : repo.remote ? (
                  "Not pushed yet."
                ) : (
                  "No remote."
                )}
              </p>
              <div className="mb-2 flex items-center justify-between gap-2">
                <button type="button" onClick={() => setShowFiles((v) => !v)} aria-expanded={showFiles} disabled={!dirty} className="flex items-center gap-1.5 text-[13px] text-ink disabled:text-ink-3">
                  {dirty ? <NavArrowDown width={12} height={12} strokeWidth={2.4} className={`text-ink-3 transition-transform duration-200 ${showFiles ? "" : "-rotate-90"}`} /> : null}
                  {dirty ? `${dirty} changed ${dirty === 1 ? "file" : "files"}` : "No uncommitted changes"}
                </button>
                {dirty > 0 && (
                  <button type="button" onClick={() => openDiff("uncommitted")} className="shrink-0 text-[12.5px] font-medium text-ink-2 hover:text-ink">
                    View diff
                  </button>
                )}
              </div>
              {showFiles && (
                <ul className="mb-3 max-h-56 overflow-y-auto rounded-[10px] bg-inset px-2.5 py-1.5 font-mono text-[12px] shadow-hairline">
                  {repo.files.slice(0, 300).map((f) => (
                    <li key={f.path} className="flex min-w-0 gap-2 py-0.5">
                      <span className="w-16 shrink-0 text-ink-3">{stateOf(f.state)}</span>
                      <span className="min-w-0 truncate text-ink-2" title={f.path}>
                        {f.path}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {dirty > 0 && (
                <div className="mb-2 flex gap-2">
                  <input
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && message.trim() && void commit()}
                    placeholder="Commit message"
                    aria-label="Commit message"
                    className="h-9 min-w-0 flex-1 rounded-full bg-field px-3.5 text-[16px] text-ink shadow-hairline outline-none placeholder:text-ink-3 focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-8 sm:text-[13px]"
                  />
                  <button type="button" onClick={() => void commit()} disabled={!message.trim() || working !== null} className={primary}>
                    {working === "commit" ? "Committing…" : "Commit all"}
                  </button>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {repo.remote && repo.branch && (repo.ahead > 0 || !repo.upstream) && (
                  <button type="button" onClick={() => void pushNow()} disabled={working !== null} className={quiet}>
                    {working === "push" ? "Pushing…" : "Push"}
                  </button>
                )}
                {repo.remote && repo.gh && repo.branch && !mainline && (
                  <button type="button" onClick={() => void pr()} disabled={working !== null || dirty > 0} title={dirty ? "Commit the changes first" : undefined} className={quiet}>
                    {working === "pr" ? "Opening pull request…" : "Create pull request"}
                  </button>
                )}
              </div>
            </section>

            <section aria-label="Checkpoints">
              <div className="mb-1 flex items-center justify-between gap-2">
                <h3 className="text-[13px] font-semibold text-ink">Checkpoints</h3>
                <button type="button" onClick={() => void act("checkpoint", {})} disabled={working !== null} className="text-[12.5px] font-medium text-ink-2 hover:text-ink disabled:opacity-40">
                  {working === "checkpoint" ? "Saving…" : "Save one now"}
                </button>
              </div>
              <p className="mb-2 text-[12px] leading-snug text-ink-3">The files as they were before each message you sent from here. Rewinding changes files only, never the conversation or your commits.</p>
              {cps.length === 0 ? (
                <p className="py-4 text-center text-[12.5px] text-ink-3">None yet. One is saved before the next message.</p>
              ) : (
                <ol className="flex flex-col gap-1">
                  {cps.map((cp) => (
                    <li key={cp.id} className="rounded-[10px] px-2 py-1.5 hover:bg-hover/60">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="w-10 shrink-0 text-[11.5px] text-ink-3 tabular-nums" title={new Date(cp.at).toLocaleString()}>
                          {timeAgo(cp.at)}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[13px] text-ink" title={cp.label}>
                          {cp.label}
                        </span>
                        <button type="button" onClick={() => void showSince(cp.id)} aria-expanded={since?.id === cp.id} className="shrink-0 rounded-full px-2 py-0.5 text-[12px] font-medium text-ink-2 hover:bg-hover hover:text-ink">
                          Changes since
                        </button>
                        <button type="button" onClick={() => openDiff("checkpoint", cp.id)} className="shrink-0 rounded-full px-2 py-0.5 text-[12px] font-medium text-ink-2 hover:bg-hover hover:text-ink">
                          Diff
                        </button>
                        <button type="button" onClick={() => void rewindTo(cp)} disabled={busy || working !== null} title={busy ? "Stop the running turn first" : undefined} className="shrink-0 rounded-full px-2 py-0.5 text-[12px] font-medium text-red-ink hover:bg-red-tint disabled:opacity-40">
                          Rewind
                        </button>
                      </div>
                      {since?.id === cp.id && (
                        <div className="mt-1 ml-12 font-mono text-[12px]">
                          {since.files === null ? (
                            <p className="text-ink-3">Comparing…</p>
                          ) : since.files.length === 0 ? (
                            <p className="text-ink-3">No changes since.</p>
                          ) : (
                            <ul>
                              {since.files.slice(0, 200).map((f) => (
                                <li key={f.path} className="flex min-w-0 gap-2">
                                  <span className="min-w-0 flex-1 truncate text-ink-2" title={f.path}>
                                    {f.path}
                                  </span>
                                  <span className="shrink-0 tabular-nums">{f.binary ? <span className="text-ink-3">binary</span> : <><span className="text-green">+{f.added}</span> <span className="text-red">-{f.removed}</span></>}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </>
        )}
      </div>
    </aside>
  );
}
