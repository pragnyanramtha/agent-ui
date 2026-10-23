"use client";

import { useState, type ReactNode } from "react";
import { MailOpen, Menu } from "iconoir-react";
import { timeAgo } from "@/lib/client/api";
import { useSetting } from "@/lib/client/settings";
import { fullDateTime } from "@/lib/time-format";
import { answerAsk, failureText } from "@/lib/client/send";
import { AGENT_LABEL, type PendingAsk, type SessionSummary } from "@/lib/types";
import type { Finished } from "@/lib/client/useFinished";
import { runFailed } from "@/lib/status";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";

const btn = "tap relative inline-flex h-8 shrink-0 items-center justify-center rounded-full px-3.5 text-sm font-medium transition-colors duration-150 disabled:opacity-40 pointer-coarse:h-10";
const outline = `${btn} border border-line-strong text-ink hover:bg-hover`;
const ghost = `${btn} px-3 text-ink-2 hover:bg-hover hover:text-ink`;

export const inboxCount = (sessions: SessionSummary[] | null, finished: Finished) =>
  (sessions ?? []).filter((s) => s.web?.pending.length || runFailed(s.web)).length + Object.keys(finished).length;

/** sessions waiting on an answer, ones whose last turn failed, and ones that finished while you were elsewhere */
export function inboxGroups(sessions: SessionSummary[], finished: Finished) {
  const needs = sessions.filter((s) => s.web?.pending.length);
  const failed = sessions.filter((s) => runFailed(s.web) && !s.web?.pending.length);
  const done = sessions.filter((s) => finished[s.id] && !s.web?.pending.length && !runFailed(s.web)).sort((a, b) => finished[b.id] - finished[a.id]);
  return { needs, failed, done };
}

/** Everything waiting on you across sessions: approvals to answer right here, failed turns, and turns that finished. */
export function InboxScreen({
  sessions,
  finished,
  onDismiss,
  onOpen,
  onRefresh,
  onMenu,
  extra,
}: {
  sessions: SessionSummary[] | null;
  finished: Finished;
  onDismiss: (id: string | null) => void;
  onOpen: (id: string) => void;
  onRefresh: () => void;
  onMenu: () => void;
  extra?: ReactNode;
}) {
  const { needs, failed, done } = inboxGroups(sessions ?? [], finished);
  const empty = sessions !== null && !needs.length && !failed.length && !done.length;

  return (
    <section className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="on-page safe-top safe-x flex shrink-0 items-center bg-page">
        <div className="flex h-14 w-full min-w-0 items-center gap-1 px-1.5 sm:px-3 lg:h-[52px]">
          <button type="button" onClick={onMenu} aria-label="Open sessions" aria-haspopup="dialog" data-drawer-opener className="icon-btn lg:hidden">
            <Menu width={19} height={19} strokeWidth={1.8} />
          </button>
          <h1 className="min-w-0 flex-1 truncate px-1.5 text-md font-medium tracking-[-0.01em] text-ink sm:text-base">Inbox</h1>
          {extra}
        </div>
      </header>
      <div className="safe-x safe-bottom min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className={`mx-auto flex w-full max-w-[760px] flex-col gap-10 px-4 pt-2 pb-20 sm:px-6 md:pt-6 ${empty ? "min-h-full" : ""}`}>
          {sessions === null && (
            <div role="status" aria-label="Loading the inbox…" className="flex flex-col gap-5 pt-2">
              <Skeleton className="h-4 w-24" />
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex flex-col gap-2">
                  <Skeleton className="h-4 w-64 max-w-full" />
                  <Skeleton className="h-3 w-40" />
                </div>
              ))}
            </div>
          )}
          {empty && (
            <Empty className="pb-[12vh]" style={{ animation: "fade-in 200ms ease both" }}>
              <EmptyHeader>
                <EmptyMedia variant="icon" className="size-10 rounded-xl bg-field text-ink-2">
                  <MailOpen width={18} height={18} strokeWidth={1.8} />
                </EmptyMedia>
                <EmptyTitle className="text-md text-ink">Nothing needs you</EmptyTitle>
                <EmptyDescription className="text-ink-3">Approvals, failed turns and turns that finish while you&apos;re away show up here.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}

          {needs.length > 0 && (
            <Group title="Needs you" count={needs.length}>
              {needs.map((s) => (
                <Item key={s.id} s={s} onOpen={onOpen}>
                  {s.web!.pending.map((ask) => (
                    <Ask key={ask.requestId} session={s.id} ask={ask} onOpen={() => onOpen(s.id)} onDone={onRefresh} />
                  ))}
                </Item>
              ))}
            </Group>
          )}

          {failed.length > 0 && (
            <Group title="Failed" count={failed.length}>
              {failed.map((s) => (
                <Item key={s.id} s={s} onOpen={onOpen}>
                  <p className="text-sm leading-snug text-red-ink [overflow-wrap:anywhere]">{s.web?.error ?? "The turn failed."}</p>
                </Item>
              ))}
            </Group>
          )}

          {done.length > 0 && (
            <Group
              title="Finished"
              count={done.length}
              aside={
                <button type="button" onClick={() => onDismiss(null)} className={`${ghost} -mr-3`}>
                  Clear all
                </button>
              }
            >
              {done.map((s) => (
                <Item key={s.id} s={s} onOpen={onOpen} when={finished[s.id]} onDismiss={() => onDismiss(s.id)} />
              ))}
            </Group>
          )}
        </div>
      </div>
    </section>
  );
}

function Group({ title, count, aside, children }: { title: string; count: number; aside?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <div className="flex min-h-8 items-center gap-2 pb-2">
        <h2 className="text-md font-semibold tracking-[-0.01em] text-ink">{title}</h2>
        <span className="text-sm text-ink-3 tabular-nums">{count}</span>
        <span className="ml-auto">{aside}</span>
      </div>
      <ul className="flex flex-col divide-y divide-line border-y border-line">{children}</ul>
    </section>
  );
}

function Item({ s, onOpen, when, onDismiss, children }: { s: SessionSummary; onOpen: (id: string) => void; when?: number; onDismiss?: () => void; children?: ReactNode }) {
  const [fmt] = useSetting("timeFormat");
  return (
    <li className="py-3">
      <div className="flex min-w-0 items-center gap-2">
        <button type="button" onClick={() => onOpen(s.id)} className="group min-w-0 flex-1 text-left">
          <span className="block truncate text-base font-medium text-ink group-hover:underline group-hover:decoration-ink-3 group-hover:underline-offset-4">{s.title || "Session"}</span>
          <span className="mt-0.5 block truncate text-sm text-ink-3">
            {AGENT_LABEL[s.agent]} · {s.project || "No folder"}
            {when ? <span title={fullDateTime(when, fmt)}> · {timeAgo(when)}</span> : ""}
          </span>
        </button>
        {onDismiss && (
          <button type="button" onClick={onDismiss} className={ghost}>
            Dismiss
          </button>
        )}
        <button type="button" onClick={() => onOpen(s.id)} className={outline}>
          Open
        </button>
      </div>
      {children && <div className="mt-3 flex flex-col gap-2">{children}</div>}
    </li>
  );
}

function Ask({ session, ask, onOpen, onDone }: { session: string; ask: PendingAsk; onOpen: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (ask.kind === "question") {
    return (
      <div className="rounded-xl bg-field/60 px-3.5 py-3">
        <p className="text-base text-ink">{ask.questions[0]?.question ?? "Question"}</p>
        <button type="button" onClick={onOpen} className={`${outline} mt-2.5`}>
          Answer in the session
        </button>
      </div>
    );
  }
  const command = typeof ask.input.command === "string" ? ask.input.command : null;
  const answer = async (choice: "allow" | "always" | "deny") => {
    setBusy(choice);
    setError(null);
    try {
      await answerAsk(session, { requestId: ask.requestId, allow: choice !== "deny", always: choice === "always" });
      onDone();
    } catch (err) {
      setError(failureText(err));
      setBusy(null);
    }
  };
  return (
    <div className="rounded-xl bg-field/60 px-3.5 py-3">
      <p className="text-base font-medium text-ink [overflow-wrap:anywhere]">{ask.title || ask.toolName}</p>
      {ask.description && <p className="mt-0.5 text-sm text-ink-2 [overflow-wrap:anywhere]">{ask.description}</p>}
      {command && !ask.title.includes(command) && (
        <pre className="mt-2 max-h-32 overflow-auto rounded-lg bg-page px-3 py-2 font-mono text-xs whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere]">{command}</pre>
      )}
      {error && <p className="mt-2 text-sm text-red-ink">{error}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" disabled={busy !== null} onClick={() => void answer("allow")} className={`${btn} bg-primary text-primary-foreground hover:bg-primary-hover`}>
          {busy === "allow" ? "Allowing…" : "Allow"}
        </button>
        {ask.canAlwaysAllow && (
          <button type="button" disabled={busy !== null} onClick={() => void answer("always")} className={outline}>
            {busy === "always" ? "Allowing…" : "Always allow"}
          </button>
        )}
        <button type="button" disabled={busy !== null} onClick={() => void answer("deny")} className={`${btn} px-3 text-red-ink hover:bg-red-tint`}>
          {busy === "deny" ? "Denying…" : "Deny"}
        </button>
      </div>
    </div>
  );
}
