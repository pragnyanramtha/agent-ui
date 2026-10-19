"use client";

import { useState } from "react";
import ApprovalCard from "@/components/primitives/ApprovalCard";
import { Button } from "@/components/atoms/Button";
import type { PendingAsk } from "@/lib/types";
import { summarizeTool } from "@/lib/client/tools";
import { Boundary, EntryFallback } from "./Boundary";
import { failureText, type Answer } from "@/lib/client/send";
import { DiffBlock } from "./DiffBlock";

/** rejects when the answer didn't get through; the card then offers it again */
type Respond = (body: Answer) => Promise<unknown>;

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
function PermissionCard({ ask, respond }: { ask: Extract<PendingAsk, { kind: "permission" }>; respond: Respond }) {
  const [busy, setBusy] = useState<"deny" | "allow" | "always" | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  return (
    <div className="w-full overflow-hidden rounded-card bg-surface shadow-card" role="group" aria-label="Approval needed" style={{ animation: "fade-up 380ms cubic-bezier(0.23,1,0.32,1) both" }}>
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
      </div>
      {/* Phones: the tool label sits on its own line and the three actions share the row
       * evenly at full tap height. From sm up it is one compact Beautiful UI footer. */}
      <div className="primitive-card-footer flex flex-col gap-2 border-t border-line sm:flex-row sm:items-center sm:justify-between">
        <span className="min-w-0 truncate pl-1 font-mono text-xs text-ink-3" translate="no">
          {summary.verb === ask.toolName ? ask.toolName : `${ask.toolName} · ${summary.chip}`}
        </span>
        <span className="flex items-center gap-1.5 sm:ml-auto sm:shrink-0">
          <Button variant="secondary" size="sm" className="h-10 min-w-0 flex-1 sm:h-[27px] sm:flex-none" disabled={busy !== null} onClick={() => act("deny")}>
            {busy === "deny" ? "Denying…" : "Deny"}
          </Button>
          {ask.canAlwaysAllow && (
            <Button variant="ghost" size="sm" className="h-10 min-w-0 flex-[1.4] whitespace-nowrap sm:h-[27px] sm:flex-none" disabled={busy !== null} onClick={() => act("always")}>
              {busy === "always" ? "Allowing…" : "Always allow"}
            </Button>
          )}
          <Button variant="accent" size="sm" className="h-10 min-w-0 flex-1 sm:h-[27px] sm:flex-none" disabled={busy !== null} onClick={() => act("allow")}>
            {busy === "allow" ? "Allowing…" : "Allow"}
          </Button>
        </span>
      </div>
    </div>
  );
}

/** AskUserQuestion, answered through Beautiful UI's ApprovalCard. */
function QuestionCard({ ask, respond }: { ask: Extract<PendingAsk, { kind: "question" }>; respond: Respond }) {
  const [error, setError] = useState<string | null>(null);
  const questions = (Array.isArray(ask.questions) ? ask.questions : []).filter((q) => q && typeof q === "object");
  const options = (q: (typeof questions)[number]) => (Array.isArray(q.options) ? q.options : []);
  return (
    <div className="flex flex-col gap-1.5">
      <ApprovalCard
        className="max-w-none sm:max-w-[420px]"
        resettable={false}
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

export function AskCards({ pending, respond }: { pending: PendingAsk[]; respond: Respond }) {
  if (!pending.length) return null;
  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      {pending.map((ask) => (
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
          {ask.kind === "permission" ? <PermissionCard ask={ask} respond={respond} /> : <QuestionCard ask={ask} respond={respond} />}
        </Boundary>
      ))}
    </div>
  );
}
