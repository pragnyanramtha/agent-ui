"use client";

import { useEffect, useRef, useState } from "react";
import { NavArrowLeft, NavArrowRight } from "iconoir-react";
import ApprovalCard from "@/components/primitives/ApprovalCard";
import { Button } from "@/components/atoms/Button";
import { KeyCap } from "@/components/atoms/KeyCap";
import type { PendingAsk } from "@/lib/types";
import { summarizeTool } from "@/lib/client/tools";
import { approvalKey, focusSpot, keyInScope, overlayOpen } from "@/lib/client/approval-keys";
import { Boundary, EntryFallback } from "./Boundary";
import { failureText, type Answer } from "@/lib/client/send";
import { DiffBlock } from "./DiffBlock";

/** rejects when the answer didn't get through; the card then offers it again */
type Respond = (body: Answer) => Promise<unknown>;
type Permission = Extract<PendingAsk, { kind: "permission" }>;

function Preview({ toolName, input }: { toolName: string; input: Record<string, unknown> }) {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  if (toolName === "Edit") return <DiffBlock before={s("old_string")} after={s("new_string")} file={s("file_path")} />;
  const text =
    toolName === "Bash" ? s("command") : toolName === "Write" ? `${s("file_path")}\n\n${s("content").slice(0, 1200)}` : s("file_path") || s("url") || s("pattern") || JSON.stringify(input, null, 2);
  return (
    <pre className="max-h-56 overflow-auto rounded-[8px] bg-inset px-2.5 py-2 font-mono text-xs leading-[1.6] whitespace-pre-wrap text-ink shadow-hairline [overflow-wrap:anywhere]">
      {toolName === "Bash" && <span className="select-none text-ink-3">$ </span>}
      {text}
    </pre>
  );
}

/** A tool waiting for approval, in the card grammar of Beautiful UI's RecommendationCard. */
function PermissionCard({ ask, respond, keys, onNote, noting }: { ask: Permission; respond: Respond; keys: boolean; onNote?: (ask: Permission) => void; noting: boolean }) {
  const [busy, setBusy] = useState<"deny" | "allow" | "always" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const act = async (choice: "deny" | "allow" | "always") => {
    setBusy(choice);
    setError(null);
    await respond({ requestId: ask.requestId, allow: choice !== "deny", always: choice === "always" }).catch((err: unknown) => {
      setBusy(null);
      setError(failureText(err));
    });
  };
  const input = ask.input ?? {};
  const summary = summarizeTool(ask.toolName, input);

  const onKey = useRef<(e: KeyboardEvent) => void>(() => undefined);
  onKey.current = (e) => {
    if (busy || !keyInScope(e.target, rootRef.current)) return;
    const choice = approvalKey(e, { kind: "permission", focus: focusSpot(e.target), canAlwaysAllow: ask.canAlwaysAllow, overlay: overlayOpen() });
    if (!choice || (choice.type !== "allow" && choice.type !== "deny" && choice.type !== "always")) return;
    e.preventDefault();
    e.stopPropagation();
    void act(choice.type);
  };
  useEffect(() => {
    if (!keys) return;
    const fn = (e: KeyboardEvent) => onKey.current(e);
    /* capture: the message box takes Enter for itself even when it's empty, and Esc would stop the turn */
    window.addEventListener("keydown", fn, true);
    return () => window.removeEventListener("keydown", fn, true);
  }, [keys]);

  return (
    <div ref={rootRef} className="w-full overflow-hidden rounded-2xl bg-surface shadow-card" role="group" aria-label="Approval needed" style={{ animation: "fade-up 380ms cubic-bezier(0.23,1,0.32,1) both" }}>
      <div className="primitive-card-pad flex flex-col gap-2.5">
        <div>
          <p className="text-base font-medium text-ink">{ask.title}</p>
          {ask.description && <p className="mt-1 text-sm leading-relaxed text-ink-2">{ask.description}</p>}
        </div>
        <Preview toolName={ask.toolName} input={input} />
        {error && (
          <p role="alert" className="text-sm text-red-ink [overflow-wrap:anywhere]">
            {error}
          </p>
        )}
        {(keys || onNote || noting) && (
          <div className="flex min-h-6 items-center gap-2 text-xs text-ink-3">
            {noting ? (
              <span role="status">Writing a note in the message box. Esc cancels.</span>
            ) : (
              keys && <span className="hidden min-w-0 pointer-fine:inline">Enter allows and Esc denies, also from an empty message box.</span>
            )}
            {onNote && !noting && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => onNote(ask)}
                className="tap relative -mx-1 ml-auto shrink-0 rounded-md px-1 py-0.5 font-medium text-ink-2 transition-colors duration-150 hover:text-ink disabled:opacity-50"
              >
                Deny with note…
              </button>
            )}
          </div>
        )}
      </div>
      {/* Phones: the tool label sits on its own line and the three actions share the row
       * evenly at full tap height. From sm up it is one compact Beautiful UI footer. */}
      <div className="primitive-card-footer flex flex-col gap-2 border-t border-line sm:flex-row sm:items-center sm:justify-between">
        <span className="min-w-0 truncate pl-1 font-mono text-xs text-ink-3" translate="no">
          {summary.verb === ask.toolName ? ask.toolName : `${ask.toolName} · ${summary.chip}`}
        </span>
        <span className="flex items-center gap-1.5 sm:ml-auto sm:shrink-0">
          <Button variant="secondary" size="sm" className="h-10 min-w-0 flex-1 sm:h-8 sm:flex-none" disabled={busy !== null} onClick={() => act("deny")}>
            {busy === "deny" ? "Denying…" : "Deny"}
            {keys && <KeyCap>Esc</KeyCap>}
          </Button>
          {ask.canAlwaysAllow && (
            <Button variant="ghost" size="sm" className="h-10 min-w-0 flex-[1.4] whitespace-nowrap sm:h-8 sm:flex-none" disabled={busy !== null} onClick={() => act("always")}>
              {busy === "always" ? "Allowing…" : "Always allow"}
              {keys && <KeyCap>A</KeyCap>}
            </Button>
          )}
          <Button variant="accent" size="sm" className="h-10 min-w-0 flex-1 sm:h-8 sm:flex-none" disabled={busy !== null} onClick={() => act("allow")}>
            {busy === "allow" ? "Allowing…" : "Allow"}
            {keys && <KeyCap onFill>↵</KeyCap>}
          </Button>
        </span>
      </div>
    </div>
  );
}

/** AskUserQuestion, answered through Beautiful UI's ApprovalCard. */
function QuestionCard({ ask, respond, keys }: { ask: Extract<PendingAsk, { kind: "question" }>; respond: Respond; keys: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const questions = (Array.isArray(ask.questions) ? ask.questions : []).filter((q) => q && typeof q === "object");
  const options = (q: (typeof questions)[number]) => (Array.isArray(q.options) ? q.options : []);
  return (
    <div className="flex flex-col gap-1.5">
      <ApprovalCard
        className="max-w-none sm:max-w-[420px]"
        resettable={false}
        keys={keys}
        labels={{ skip: "Skip", send: "Send answers", sentMessage: "Answers sent" }}
        questions={questions.map((q) => ({ q: String(q.question ?? ""), type: q.multiSelect ? "check" : "radio", options: options(q).map((o) => String(o?.label ?? "")) }))}
        onDismiss={() => {
          setError(null);
          respond({ requestId: ask.requestId, allow: false }).catch((err: unknown) => setError(failureText(err)));
        }}
        onSubmitted={(picked, custom) => {
          setError(null);
          const answers = Object.fromEntries(
            questions.map((q, i) => {
              const chosen = (picked[i] ?? []).map((idx) => options(q)[idx]?.label).filter(Boolean);
              if (custom[i]?.trim()) chosen.push(custom[i].trim());
              return [q.question, chosen.join(", ")];
            }),
          );
          return respond({ requestId: ask.requestId, allow: true, answers }).catch((err: unknown) => {
            throw new Error(failureText(err));
          });
        }}
      />
      {error && (
        <p role="alert" className="px-1 text-sm text-red-ink [overflow-wrap:anywhere]">
          {error}
        </p>
      )}
    </div>
  );
}

const stepBtn =
  "tap relative grid size-6 place-items-center rounded-md text-ink-3 transition-colors duration-100 enabled:hover:bg-hover enabled:hover:text-ink disabled:opacity-35 pointer-coarse:size-9";

/**
 * Waiting requests, one at a time (oldest first) with a 1/N stepper when there are several.
 * Only the request on screen answers to keys, and none while its denial note is being written.
 */
export function AskCards({
  pending,
  respond,
  onNote,
  noting = null,
}: {
  pending: PendingAsk[];
  respond: Respond;
  /** "Deny with note…": the message box takes the reason; without it the link doesn't show */
  onNote?: (ask: Permission) => void;
  /** request id whose note is being written */
  noting?: string | null;
}) {
  const [shownId, setShownId] = useState<string | null>(null);
  if (!pending.length) return null;
  /* the one picked stays on screen while others come and go; once answered, the oldest left shows */
  const at = Math.max(0, pending.findIndex((a) => a.requestId === (noting ?? shownId)));
  const ask = pending[at];
  const go = (d: number) => setShownId(pending[(at + d + pending.length) % pending.length].requestId);
  return (
    <div className="flex flex-col gap-1.5" aria-live="polite">
      {pending.length > 1 && (
        <div className="flex items-center gap-1 px-1 text-xs text-ink-3" role="group" aria-label="Waiting requests">
          <span className="mr-auto font-medium text-orange-ink">{pending.length} requests waiting</span>
          <button type="button" aria-label="Previous request" disabled={noting !== null} onClick={() => go(-1)} className={stepBtn}>
            <NavArrowLeft width={14} height={14} strokeWidth={2} />
          </button>
          <span className="min-w-8 text-center font-medium tabular-nums" aria-live="polite">
            {at + 1}/{pending.length}
          </span>
          <button type="button" aria-label="Next request" disabled={noting !== null} onClick={() => go(1)} className={stepBtn}>
            <NavArrowRight width={14} height={14} strokeWidth={2} />
          </button>
        </div>
      )}
      <Boundary
        key={ask.requestId}
        resetKey={ask}
        label="approval card"
        fallback={() => (
          <EntryFallback
            entry={ask}
            message="Couldn't show this request."
            actions={
              <button
                type="button"
                onClick={() => void respond({ requestId: ask.requestId, allow: false }).catch(() => {})}
                className="tap relative h-7 rounded-[7px] px-2.5 text-xs font-medium text-ink-2 shadow-btn hover:bg-hover hover:text-ink"
              >
                {ask.kind === "permission" ? "Deny" : "Skip"}
              </button>
            }
          />
        )}
      >
        {ask.kind === "permission" ? (
          <PermissionCard ask={ask} respond={respond} keys={noting === null} onNote={onNote} noting={noting === ask.requestId} />
        ) : (
          <QuestionCard ask={ask} respond={respond} keys={noting === null} />
        )}
      </Boundary>
    </div>
  );
}
