"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GitBranch, NavArrowDown, Sparks, Xmark } from "iconoir-react";
import { api, timeAgo } from "@/lib/client/api";
import { COMMIT, needsDefaultBranchConfirm, otherActions, primaryAction, STEP_LABEL, type GitAction, type GitState, type GitStep } from "@/lib/client/git-actions";
import { confirmAsk } from "./Ask";
import { DiffView, type DiffScope } from "./DiffView";
import { isTyping, modalOpen } from "@/lib/client/shortcuts";
import { useReturnFocus } from "@/lib/client/a11y";
import { useSetting } from "@/lib/client/settings";
import { fullDateTime } from "@/lib/time-format";

type Status = {
  root: string;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: { path: string; state: string }[];
  remote: boolean;
  gh: boolean;
  defaultBranch: string | null;
  pr?: { number: number; url: string; state: string } | null;
  fetchedAt: number | null;
  fetchError: string | null;
};
type Checkpoint = { id: string; commit: string; at: number; label: string; skipped?: { count: number; bytes: number; paths: string[] } };
type FileStat = { path: string; added: number; removed: number; binary: boolean };
type Data = { repo: Status | null; cwd: string; checkpoints?: Checkpoint[]; checkpointSkip?: { at: number; reason: string } | null };

const sizeLabel = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`);

const btn = "tap relative inline-flex h-9 shrink-0 items-center justify-center rounded-full px-3.5 text-sm font-medium transition-colors duration-150 disabled:opacity-40 sm:h-8";
const primary = `${btn} bg-ink text-surface`;
const STATUS_POLL_MS = 20_000;
const NO_ANSWER = { auto: "No agent answered", claude: "Claude didn't answer", codex: "Codex didn't answer", gemini: "Gemini didn't answer", off: "No agent answered" } as const;

const STATE: Record<string, string> = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", "?": "new", U: "conflict" };
const stateOf = (s: string) => STATE[s.trim()[0] ?? ""] ?? s.trim();
const aheadBehind = (s: { ahead: number; behind: number }) =>
  [s.ahead ? `${s.ahead} ${s.ahead === 1 ? "commit" : "commits"} to push` : "", s.behind ? `${s.behind} to pull` : ""].filter(Boolean).join(", ");

/** The action the branch's state calls for, with everything else in a menu beside it. */
function ActionBar({
  state,
  step,
  working,
  hasMessage,
  menu,
  setMenu,
  run,
}: {
  state: GitState;
  step: GitStep | null;
  working: boolean;
  hasMessage: boolean;
  menu: boolean;
  setMenu: (v: boolean | ((v: boolean) => boolean)) => void;
  run: (a: GitAction) => Promise<void>;
}) {
  const main = primaryAction(state);
  const rest = otherActions(state);
  const needsMessage = main.steps.includes("commit") && !hasMessage;
  const busy = working || step !== null;
  const hint = main.disabled ?? (needsMessage ? "Write a commit message first." : undefined);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (menu) menuRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus({ preventScroll: true });
  }, [menu]);
  return (
    <div data-git-menu className="relative">
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => void run(main)}
          disabled={busy || Boolean(hint)}
          title={hint}
          className={`${primary} ${rest.length ? "rounded-r-none pr-3" : ""} min-w-0 max-w-full`}
        >
          <span className="truncate">{step ? STEP_LABEL[step] : main.label}</span>
        </button>
        {rest.length > 0 && (
          <button
            type="button"
            onClick={() => setMenu((v) => !v)}
            disabled={busy}
            aria-haspopup="menu"
            aria-expanded={menu}
            aria-label="More git actions"
            className={`${primary} rounded-l-none border-l border-surface/25 px-2.5`}
          >
            <NavArrowDown width={14} height={14} strokeWidth={2.2} />
          </button>
        )}
      </div>
      {main.disabled && <p className="mt-1.5 text-xs leading-snug text-ink-3">{main.disabled}</p>}
      {menu && (
        <div
          role="menu"
          aria-label="Git actions"
          ref={menuRef}
          onKeyDown={(e) => {
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            e.preventDefault();
            const items = [...(menuRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not(:disabled)") ?? [])];
            const i = items.indexOf(document.activeElement as HTMLElement);
            items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
          }}
          className="absolute top-10 left-0 z-30 w-72 max-w-[calc(100vw-2rem)] rounded-[12px] bg-surface p-1 shadow-overlay"
        >
          {rest.map((a) => (
            <button
              key={a.id}
              type="button"
              role="menuitem"
              disabled={Boolean(a.disabled) || (a.steps.includes("commit") && !hasMessage)}
              onClick={() => void run(a)}
              className="menu-item flex-col items-start! gap-0! py-1.5 disabled:opacity-100"
            >
              <span className={a.disabled || (a.steps.includes("commit") && !hasMessage) ? "text-ink-3" : "text-ink"}>{a.label}</span>
              {(a.disabled || (a.steps.includes("commit") && !hasMessage)) && <span className="text-[11.5px] leading-snug text-ink-3">{a.disabled ?? "Write a commit message first."}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The session folder's git: branch, commit / push / pull request, and checkpoints to rewind the files to. */
export function GitPanel({ session, busy, onClose, view: initialView = "diff" }: { session: string; busy: boolean; onClose: () => void; view?: "diff" | "commit" }) {
  const [view, setView] = useState(initialView);
  const [timeFmt] = useSetting("timeFormat");
  const [msgAgent] = useSetting("commitMessageAgent");
  const [confirmPush] = useSetting("confirmDefaultPush");
  const canGenerate = msgAgent !== "off";
  const [target, setTarget] = useState<{ scope: DiffScope; checkpoint?: string; n: number }>({ scope: "uncommitted", n: 0 });
  const [rev, setRev] = useState(0);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; href?: string } | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [showFiles, setShowFiles] = useState(false);
  const [since, setSince] = useState<{ id: string; files: FileStat[] | null } | null>(null);
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const lastText = useRef("");
  /** quiet: a background poll, which leaves the error line alone */
  const load = useCallback(
    async (quiet = false) => {
      try {
        const d = await api<Data>(`/api/git?session=${encodeURIComponent(session)}&fetch=1`);
        const text = JSON.stringify(d);
        if (text !== lastText.current) {
          lastText.current = text;
          setData(d);
        }
        if (!quiet) setError(null);
      } catch (err) {
        if (!quiet) setError(err instanceof Error ? err.message : String(err));
      }
    },
    [session],
  );

  useReturnFocus(ref);
  useEffect(() => {
    void load();
    /* Escape in the composer or another field outside the panel is that field's */
    const onKey = (e: KeyboardEvent) =>
      e.key === "Escape" && !e.defaultPrevented && !modalOpen() && !(isTyping(e.target) && !ref.current?.contains(e.target as Node)) && closeRef.current();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [load]);

  /* a turn that just ended likely changed files and added a checkpoint */
  useEffect(() => {
    if (!busy) void load();
  }, [busy, load]);

  /* each status read lets the server fetch in the background, so new commits on the remote show up */
  useEffect(() => {
    const tick = () => document.visibilityState === "visible" && void load(true);
    const t = setInterval(tick, STATUS_POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [load]);

  useEffect(() => {
    if (!menu) return;
    const away = (e: PointerEvent) => !(e.target as Element).closest?.("[data-git-menu]") && setMenu(false);
    /* capture, so Escape closes the menu before the panel's own Escape closes the panel */
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setMenu(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc, true);
    };
  }, [menu]);

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
  const gitState: GitState | null = repo && { ...repo, dirty };
  const running = useRef(false);
  const [step, setStep] = useState<GitStep | null>(null);

  const generate = async () => {
    const r = await act("suggest-message");
    if (typeof r?.message !== "string") return;
    const text = r.message;
    setMessage((cur) => (cur.trim() ? cur : text));
    if (r.source === "summary") setNote({ text: `${NO_ANSWER[msgAgent]}, so this sums up the changed files.` });
  };

  /** runs an action's steps in order, stopping at the first that fails */
  const run = async (a: GitAction) => {
    setMenu(false);
    if (!repo || !gitState || running.current) return;
    if (a.href) return void window.open(a.href, "_blank", "noopener,noreferrer");
    if (a.steps.includes("commit") && !message.trim()) return setError("Write a commit message first.");
    if (needsDefaultBranchConfirm(gitState, a, confirmPush)) {
      const ok = await confirmAsk({
        title: `Push to ${repo.branch}?`,
        body: `${repo.branch} is the default branch, so this goes to ${repo.upstream ?? "origin"} without a pull request.`,
        confirm: "Push",
      });
      if (!ok) return;
    }
    running.current = true;
    const done: string[] = [];
    let href: string | undefined;
    try {
      for (const s of a.steps) {
        setStep(s);
        const r = await act(s, s === "commit" ? { message } : {});
        if (!r) break;
        if (s === "commit") {
          setMessage("");
          done.push(`committed ${String(r.commit)}`);
        } else if (s === "push") done.push(`pushed ${String(r.branch)}`);
        else if (s === "pull") done.push(`pulled ${String(r.branch)}`);
        else if (s === "pr" && r.url) {
          href = String(r.url);
          done.push("pull request ready");
        }
      }
    } finally {
      running.current = false;
      setStep(null);
    }
    if (done.length) {
      const text = done.join(", ");
      setNote({ text: `${text[0].toUpperCase()}${text.slice(1)}.`, href });
    }
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
    if (r) setNote({ text: `Rewound: ${String(r.changed)} ${r.changed === 1 ? "file" : "files"} changed back${r.removed ? `, ${String(r.removed)} removed` : ""}.${r.kept ? ` ${String(r.kept)} large ${r.kept === 1 ? "file was" : "files were"} left as ${r.kept === 1 ? "it is" : "they are"}.` : ""}` });
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
          <span className="text-base font-semibold text-ink">Git</span>
          {repo?.branch && (
            <span className="inline-flex min-w-0 items-center gap-1 rounded-full bg-inset px-2 py-0.5 font-mono text-xs text-ink-2 shadow-hairline" translate="no">
              <GitBranch width={12} height={12} strokeWidth={2} className="shrink-0" aria-hidden />
              <span className="truncate">{repo.branch}</span>
            </span>
          )}
          {repo?.upstream && (repo.ahead > 0 || repo.behind > 0) && (
            <span className="shrink-0 font-mono text-xs text-ink-3 tabular-nums" aria-label={aheadBehind(repo)} title={aheadBehind(repo)}>
              {repo.ahead > 0 && <span>↑{repo.ahead}</span>}
              {repo.ahead > 0 && repo.behind > 0 && " "}
              {repo.behind > 0 && <span>↓{repo.behind}</span>}
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
              className={`h-8 rounded-full px-3 text-sm font-medium transition-colors duration-150 ${view === v ? "bg-inset text-ink shadow-hairline" : "text-ink-3 hover:text-ink"}`}
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
        {!data && !error && <p className="py-8 text-center text-sm text-ink-3">Loading…</p>}
        {data && !repo && <p className="py-8 text-center text-sm text-ink-3">Not a git repository: {data.cwd}</p>}

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
                {repo.fetchError && (
                  <span className="mt-0.5 block truncate" title={repo.fetchError}>
                    Couldn&apos;t check the remote: {repo.fetchError}
                  </span>
                )}
              </p>
              <div className="mb-2 flex items-center justify-between gap-2">
                <button type="button" onClick={() => setShowFiles((v) => !v)} aria-expanded={showFiles} disabled={!dirty} className="flex items-center gap-1.5 text-sm text-ink disabled:text-ink-3">
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
                <ul className="mb-3 max-h-56 overflow-y-auto rounded-[10px] bg-inset px-2.5 py-1.5 font-mono text-xs shadow-hairline">
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
                <div className="relative mb-2">
                  <textarea
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
                      e.preventDefault();
                      if (message.trim()) void run(COMMIT);
                    }}
                    rows={Math.min(8, message.split("\n").length)}
                    placeholder="Commit message"
                    aria-label="Commit message"
                    className={`block w-full resize-none bg-field px-3.5 py-[7px] text-[16px] leading-[22px] text-ink shadow-hairline outline-none placeholder:text-ink-3 focus-visible:ring-2 focus-visible:ring-accent/40 sm:py-1.5 sm:text-sm sm:leading-5 ${message.includes("\n") ? "rounded-[14px]" : "rounded-[18px]"} ${message || !canGenerate ? "" : "pr-28"}`}
                  />
                  {!message && canGenerate && (
                    <button
                      type="button"
                      onClick={() => void generate()}
                      disabled={working !== null}
                      title="Write a message from the changes"
                      className="tap absolute top-1/2 right-1 inline-flex h-7 -translate-y-1/2 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] font-medium text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-50 sm:h-6"
                    >
                      <Sparks width={13} height={13} strokeWidth={2} aria-hidden />
                      {working === "suggest-message" ? "Generating…" : "Generate"}
                    </button>
                  )}
                </div>
              )}
              {gitState && <ActionBar state={gitState} step={step} working={working !== null} hasMessage={Boolean(message.trim())} menu={menu} setMenu={setMenu} run={run} />}
            </section>

            <section aria-label="Checkpoints">
              <div className="mb-1 flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-ink">Checkpoints</h3>
                <button type="button" onClick={() => void act("checkpoint", {})} disabled={working !== null} className="text-[12.5px] font-medium text-ink-2 hover:text-ink disabled:opacity-40">
                  {working === "checkpoint" ? "Saving…" : "Save one now"}
                </button>
              </div>
              <p className="mb-2 text-xs leading-snug text-ink-3">The files as they were before each message you sent from here. Rewinding changes files only, never the conversation or your commits.</p>
              {data?.checkpointSkip && (
                <p className="mb-2 rounded-[10px] bg-inset px-3 py-2 text-xs leading-snug text-ink-2 shadow-hairline" title={fullDateTime(data.checkpointSkip.at, timeFmt)}>
                  The last checkpoint was skipped: {data.checkpointSkip.reason}. Add them to .gitignore to keep saving checkpoints.
                </p>
              )}
              {cps.length === 0 ? (
                <p className="py-4 text-center text-[12.5px] text-ink-3">None yet. One is saved before the next message.</p>
              ) : (
                <ol className="flex flex-col gap-1">
                  {cps.map((cp) => (
                    <li key={cp.id} className="rounded-[10px] px-2 py-1.5 hover:bg-hover/60">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="w-10 shrink-0 text-[11.5px] text-ink-3 tabular-nums" title={fullDateTime(cp.at, timeFmt)}>
                          {timeAgo(cp.at)}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm text-ink" title={cp.label}>
                          {cp.label}
                        </span>
                        <button type="button" onClick={() => void showSince(cp.id)} aria-expanded={since?.id === cp.id} className="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium text-ink-2 hover:bg-hover hover:text-ink">
                          Changes since
                        </button>
                        <button type="button" onClick={() => openDiff("checkpoint", cp.id)} className="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium text-ink-2 hover:bg-hover hover:text-ink">
                          Diff
                        </button>
                        <button type="button" onClick={() => void rewindTo(cp)} disabled={busy || working !== null} title={busy ? "Stop the running turn first" : undefined} className="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium text-red-ink hover:bg-red-tint disabled:opacity-40">
                          Rewind
                        </button>
                      </div>
                      {cp.skipped && (
                        <p className="mt-0.5 ml-12 truncate text-[11.5px] text-ink-3" title={cp.skipped.paths.join("\n")}>
                          Not saved in this checkpoint: {cp.skipped.count} large {cp.skipped.count === 1 ? "file" : "files"} ({sizeLabel(cp.skipped.bytes)})
                        </p>
                      )}
                      {since?.id === cp.id && (
                        <div className="mt-1 ml-12 font-mono text-xs">
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
                                  <span className="diff-tone shrink-0 tabular-nums">{f.binary ? <span className="text-ink-3">binary</span> : <><span className="text-(--add-ink)">+{f.added}</span> <span className="text-(--del-ink)">-{f.removed}</span></>}</span>
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
