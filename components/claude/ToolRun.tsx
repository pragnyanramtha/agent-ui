"use client";

import { memo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ChatBubble, EditPencil, Globe, NavArrowDown, Page, Search, Sparks, TaskList, Terminal, Tools } from "iconoir-react";
import type { Entry, ToolResult } from "@/lib/types";
import { useSetting } from "@/lib/client/settings";
import { summarizeTool, type ToolIcon } from "@/lib/client/tools";
import { Boundary } from "./Boundary";
import { lazyComponent } from "@/lib/client/lazy";
import { failedCount, runSummary } from "@/lib/client/turns";
import { ENTER, SHIMMER, useOnScreen } from "./motion";

export type RunItem = Extract<Entry, { kind: "tool" | "thinking" }>;

const ICONS: Record<ToolIcon | "think", (p: { width: number; height: number; strokeWidth: number }) => ReactNode> = {
  read: (p) => <Page {...p} />,
  edit: (p) => <EditPencil {...p} />,
  run: (p) => <Terminal {...p} />,
  terminal: (p) => <Terminal {...p} />,
  search: (p) => <Search {...p} />,
  web: (p) => <Globe {...p} />,
  agent: (p) => <Sparks {...p} />,
  plan: (p) => <TaskList {...p} />,
  ask: (p) => <ChatBubble {...p} />,
  tool: (p) => <Tools {...p} />,
  think: (p) => <Sparks {...p} />,
};

const ease = "cubic-bezier(0.23, 1, 0.32, 1)";

/* Focus rings sit inside the control: rows live in overflow-clipped containers where an outset ring gets cut off. */
const FOCUS_INSET = "focus-visible:[outline-offset:-2px]! focus-visible:rounded-control!";

/* continuous animations inherit this play state from the run, which pauses them off screen */
const PLAY = "[animation-play-state:var(--run-play,running)]";

function Collapse({ open, children, className = "" }: { open: boolean; children: ReactNode; className?: string }) {
  return (
    <div
      className={`grid grid-cols-[minmax(0,1fr)] transition-[grid-template-rows,opacity] duration-300 ${className}`}
      style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0, transitionTimingFunction: ease }}
    >
      <div className="min-h-0 min-w-0 overflow-hidden">{open ? children : null}</div>
    </div>
  );
}

/* Rows start collapsed, so what they show when opened loads on its own; fetched once the page is idle. */
const Detail = lazyComponent(
  () => import("./ToolDetail").then((m) => m.Detail),
  () => <p role="status" className="text-xs text-ink-3">Loading…</p>,
);
if (typeof window !== "undefined") {
  const preload = () => void Detail.preload().catch(() => undefined);
  if (typeof requestIdleCallback === "function") requestIdleCallback(preload, { timeout: 6000 });
  else setTimeout(preload, 3000);
}

const Row = memo(function Row({ item, result, active }: { item: RunItem; result?: ToolResult; active: boolean }) {
  const [toolCalls] = useSetting("toolCalls");
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? toolCalls === "details";
  const summary = item.kind === "thinking" ? { verb: "Thought", chip: item.text.split("\n")[0], mono: false, icon: "think" as const } : summarizeTool(item.name, item.input ?? {});
  const failed = result?.isError;
  const waiting = item.kind === "tool" && !result && active;
  const iconProps = { width: 16, height: 16, strokeWidth: 1.6 };

  return (
    <div style={ENTER}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setManual(!open)}
        className={`group/row -mx-1 flex min-h-10 w-[calc(100%+8px)] min-w-0 items-center gap-1.5 rounded-control px-1 py-0.5 text-left leading-relaxed transition-colors duration-100 hover:bg-hover-2 pointer-fine:min-h-7 ${FOCUS_INSET}`}
      >
        <span className="relative flex h-4 w-5 shrink-0 items-center justify-center text-ink-3">
          <span className={`flex transition-opacity duration-100 group-hover/row:opacity-0 group-focus-visible/row:opacity-0 ${open ? "opacity-0" : ""}`}>{ICONS[summary.icon](iconProps)}</span>
          <span
            className={`absolute flex transition-[opacity,transform] duration-150 group-hover/row:opacity-100 group-focus-visible/row:opacity-100 ${open ? "opacity-100" : "opacity-0"}`}
            style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }}
          >
            <NavArrowDown width={13} height={13} strokeWidth={2.2} />
          </span>
        </span>
        <span className="max-w-[45%] shrink-0 truncate text-[13px] text-ink-2">{summary.verb}</span>
        {summary.chip && (
          <span className={`min-w-0 truncate text-ink-3 ${summary.mono ? "font-mono text-[12px]" : "text-[12.5px]"}`} title={item.kind === "tool" && typeof item.input?.file_path === "string" ? item.input.file_path : undefined}>
            {summary.chip}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center pl-1">
          {waiting && (
            <span
              role="img"
              aria-label="Running"
              className={`size-3 rounded-full border-[1.5px] border-line-strong border-t-ink-2 animate-[spin_700ms_linear_infinite] motion-reduce:animate-none ${PLAY}`}
            />
          )}
          {failed && <span className="text-[11.5px] font-medium text-red">Failed</span>}
        </span>
      </button>
      <Collapse open={open}>
        <div className="mt-0.5 mb-2 ml-2.5 min-w-0 border-l border-line-soft py-1 pl-3">
          <Boundary resetKey={result ?? item} entry={result ? { item, result } : item}>
            <Detail item={item} result={result} active={active} />
          </Boundary>
        </div>
      </Collapse>
    </div>
  );
});

/** Live reasoning while the model thinks: the newest ~3 lines, tap to read it all. */
function LiveThinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 220 || text.split("\n").length > 3;
  return (
    <div style={ENTER}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? "Collapse thinking" : "Expand thinking"}
        onClick={() => setOpen((v) => !v)}
        className={`-mx-1 flex w-[calc(100%+8px)] min-w-0 gap-2 rounded-control px-1 py-1.5 text-left transition-colors duration-100 hover:bg-hover-2 ${FOCUS_INSET}`}
      >
        <span className="flex h-5 w-4 shrink-0 items-center justify-center text-ink-3 sm:h-[18px]">
          <Sparks width={14} height={14} strokeWidth={1.8} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={`w-fit text-[13px] font-medium sm:text-[12.5px] ${SHIMMER} ${PLAY}`}>Thinking…</span>
          {/* collapsed, the box pins to the bottom so the newest reasoning stays in view */}
          <span
            className={`flex flex-col text-[12.5px] leading-[1.6] text-ink-2 ${open ? "" : "max-h-[4.8em] justify-end overflow-hidden"}`}
            style={!open && long ? { maskImage: "linear-gradient(to bottom, transparent, black 1.6em)", WebkitMaskImage: "linear-gradient(to bottom, transparent, black 1.6em)" } : undefined}
          >
            <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</span>
          </span>
        </span>
      </button>
    </div>
  );
}

/**
 * A run of tool calls and thinking between two pieces of prose, styled after Beautiful UI's ToolChips.
 * `results` holds only this run's results so memo skips runs whose results did not change.
 * `thinking` is live reasoning streaming in for the next step.
 */
export const ToolRun = memo(function ToolRun({
  items,
  results,
  active,
  thinking,
}: {
  items: RunItem[];
  results: Record<string, ToolResult>;
  active: boolean;
  thinking?: string;
}) {
  const [manual, setManual] = useState<boolean | null>(null);
  const [toolCalls] = useSetting("toolCalls");
  const rootRef = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(rootRef, active);
  const open = manual ?? (active || toolCalls !== "collapsed");
  const last = items[items.length - 1];
  const lastSummary = last?.kind === "tool" ? summarizeTool(last.name, last.input ?? {}) : null;
  const live = thinking?.trim() ? thinking : undefined;
  /* an open run's live thinking row carries the shimmer itself, so the header stays quiet while it streams */
  const shimmer = active && !(live && open);
  const failed = failedCount(items, results);

  if (!items.length) {
    return (
      <div ref={rootRef} className="w-full min-w-0" style={active && !onScreen ? ({ "--run-play": "paused" } as CSSProperties) : undefined}>
        {live && <LiveThinking text={live} />}
      </div>
    );
  }

  return (
    <div ref={rootRef} className="w-full min-w-0" style={active && !onScreen ? ({ "--run-play": "paused" } as CSSProperties) : undefined}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setManual(!open)}
        className={`-mx-1.5 flex h-10 max-w-[calc(100%+12px)] min-w-0 items-center gap-1.5 rounded-control px-1.5 text-[13px] text-ink-2 transition-colors duration-100 hover:bg-hover-2 pointer-fine:h-7 sm:text-[12.5px] ${FOCUS_INSET}`}
      >
        <span className="flex shrink-0 transition-transform duration-200" style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }}>
          <NavArrowDown width={12} height={12} strokeWidth={2.2} />
        </span>
        {shimmer ? (
          <span className={`shrink-0 font-medium ${SHIMMER} ${PLAY}`}>{live || !lastSummary ? "Thinking…" : lastSummary.verb}</span>
        ) : (
          <span className="min-w-0 truncate tabular-nums">{runSummary(items)}</span>
        )}
        {!shimmer && failed > 0 && <span className="shrink-0 text-red">· {failed} failed</span>}
      </button>
      {/* the collapse clips overflow; widen it by the rows' hover bleed so their backgrounds and focus rings aren't cut */}
      <Collapse open={open} className="-mx-1">
        <div className="mt-1 flex min-w-0 flex-col gap-0.5 px-1 pb-1">
          {items.map((item) => (
            <Row key={item.id} item={item} result={item.kind === "tool" ? results[item.toolUseId] : undefined} active={active} />
          ))}
          {live && <LiveThinking text={live} />}
        </div>
      </Collapse>
    </div>
  );
});
