"use client";

import { parseHandoff } from "@/lib/handoff-text";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, MediaImage } from "iconoir-react";
import { splitAttachments } from "@/lib/attachments";
import { SentFiles } from "./Attachments";
import LoadingState from "@/components/primitives/LoadingState";
import type { Entry, ToolResult } from "@/lib/types";
import type { SessionView } from "@/lib/client/useSession";
import { useSetting } from "@/lib/client/settings";
import { Markdown } from "./Markdown";
import { ACTIONS_GAP, ACTIONS_HOST, ACTIONS_PAD, MessageActions } from "./MessageActions";
import { ENTER } from "./motion";
import { ToolRun, type RunItem } from "./ToolRun";

/** Dispatched on the thread's scroll box to stop following new content before jumping to an earlier spot. */
export const RELEASE_PIN_EVENT = "cui:release-pin";

type Block =
  | { type: "user"; key: string; entry: Extract<Entry, { kind: "user" }> }
  | { type: "text"; key: string; entry: Extract<Entry, { kind: "text" }> }
  | { type: "notice"; key: string; entry: Extract<Entry, { kind: "notice" }> }
  | { type: "run"; key: string; items: RunItem[] };

const GAP_MS = 30 * 60_000;

/** "Today 14:02", "Yesterday 09:10", "Mon, Oct 6 · 14:02" */
function stamp(ms: number) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(d)) / 86_400_000);
  if (diff === 0) return `Today ${time}`;
  if (diff === 1) return `Yesterday ${time}`;
  return `${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} · ${time}`;
}

/** A time divider before a user turn that starts a new day or comes after a long pause. */
function separators(blocks: Block[]) {
  const out = new Map<string, string>();
  let last = 0;
  for (const b of blocks) {
    if (b.type !== "user") continue;
    const t = Date.parse(b.entry.ts);
    if (!Number.isFinite(t)) continue;
    if (!last || t - last > GAP_MS || new Date(t).toDateString() !== new Date(last).toDateString()) out.set(b.key, stamp(t));
    last = t;
  }
  return out;
}

function toBlocks(entries: Entry[]): Block[] {
  const blocks: Block[] = [];
  for (const e of entries) {
    /* models that keep reasoning private still log an empty thinking block; it carries nothing to show */
    if (e.kind === "thinking" && !e.text.trim()) continue;
    if (e.kind === "tool" || e.kind === "thinking") {
      const last = blocks[blocks.length - 1];
      if (last?.type === "run") last.items.push(e);
      else blocks.push({ type: "run", key: e.id, items: [e] });
    } else if (e.kind === "user" || e.kind === "text" || e.kind === "notice") {
      blocks.push({ type: e.kind, key: e.id, entry: e } as Block);
    }
  }
  return blocks;
}

type RunProps = { items: RunItem[]; results: Record<string, ToolResult> };
const EMPTY_RESULTS: Record<string, ToolResult> = {};
const NO_ITEMS: RunItem[] = [];

const sameItems = (a: RunItem[], b: RunItem[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * toBlocks rebuilds every run's item array on each new entry, and the results
 * map changes whenever any tool finishes. Hand each run the previous arrays
 * back when its own items and results are unchanged, so ToolRun's memo holds
 * and only the run that actually changed re-renders.
 */
function useStableRuns(blocks: Block[], results: Record<string, ToolResult>) {
  const cache = useRef(new Map<string, RunProps>());
  return useMemo(() => {
    const prev = cache.current;
    const next = new Map<string, RunProps>();
    for (const b of blocks) {
      if (b.type !== "run") continue;
      const old = prev.get(b.key);
      const items = old && sameItems(old.items, b.items) ? old.items : b.items;
      const ids = items.flatMap((it) => (it.kind === "tool" ? [it.toolUseId] : []));
      let runResults: Record<string, ToolResult>;
      if (old && ids.every((id) => old.results[id] === results[id])) runResults = old.results;
      else {
        const picked: Record<string, ToolResult> = {};
        for (const id of ids) if (results[id]) picked[id] = results[id];
        runResults = ids.some((id) => results[id]) ? picked : EMPTY_RESULTS;
      }
      next.set(b.key, old && old.items === items && old.results === runResults ? old : { items, results: runResults });
    }
    cache.current = next;
    return next;
  }, [blocks, results]);
}

const TURN_MAX_MS = 24 * 60 * 60_000;

/**
 * When the current turn started: the latest user message's timestamp, so the
 * timer survives reloads and remounts. A prompt older than a day is not this
 * turn's (a stale busy flag, say), so the timer falls back to counting from mount.
 */
function turnStart(entries: Entry[]): number | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind !== "user") continue;
    const t = Date.parse(e.ts);
    return Number.isFinite(t) && Date.now() - t < TURN_MAX_MS ? t : undefined;
  }
  return undefined;
}

const enter = ENTER;

/** Splits a user message on ``` fences so pasted code renders as code, not prose. */
function segments(text: string): { code: boolean; text: string; lang?: string }[] {
  const out: { code: boolean; text: string; lang?: string }[] = [];
  const re = /```([\w+-]*)\n([\s\S]*?)(?:\n```|$)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ code: false, text: text.slice(last, idx).replace(/\n+$/, "") });
    out.push({ code: true, text: m[2], lang: m[1] || undefined });
    last = idx + m[0].length;
  }
  if (last < text.length) out.push({ code: false, text: text.slice(last).replace(/^\n+/, "") });
  return out.filter((s) => s.code || s.text.trim());
}

function UserText({ text }: { text: string }) {
  /* slash commands and ! shell escapes: the command reads as the subject, arguments follow quieter */
  const command = /^(\/[\w:-]+|!)(\s[\s\S]*)?$/.exec(text);
  if (command) {
    return (
      <p translate="no" className="font-mono text-[13px] whitespace-pre-wrap [overflow-wrap:anywhere] sm:text-[12.5px]">
        <span className={command[1] === "!" ? "text-ink-3" : "font-medium text-ink"}>{command[1]}</span>
        <span className="text-ink-2">{command[2]}</span>
      </p>
    );
  }
  const parts = segments(text);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {parts.map((p, i) =>
        p.code ? (
          <pre
            key={i}
            translate="no"
            tabIndex={0}
            aria-label={p.lang ? `${p.lang} code` : "Code"}
            className="max-h-72 overflow-auto overscroll-contain rounded-[8px] bg-inset px-2.5 py-2 font-mono text-[12px] leading-[1.6] whitespace-pre text-ink-2 shadow-hairline focus-visible:[outline-offset:-2px]!"
          >
            {p.text}
          </pre>
        ) : (
          <p key={i} className="whitespace-pre-wrap [overflow-wrap:anywhere]">
            {p.text}
          </p>
        ),
      )}
    </div>
  );
}

const UserBubble = memo(function UserBubble({ text: full, images, pending, ts }: { text: string; images?: number; pending?: boolean; ts?: string }) {
  const [expanded, setExpanded] = useState(false);
  const { text, paths } = useMemo(() => splitAttachments(full), [full]);
  const handoff = parseHandoff(text);
  const long = text.length > 700 || text.split("\n").length > 14;
  const clamp = long && !expanded;
  /* a message still being sent has nothing settled to copy or time yet. The caller's wrapper carries ACTIONS_GAP. */
  const actions = !pending && Boolean(text || ts);
  return (
    <div className={`flex flex-col items-end pl-8 sm:pl-20 ${actions ? ACTIONS_PAD : ""}`} style={enter}>
      <SentFiles paths={paths} />
      <div
        className={`flex max-w-full min-w-0 flex-col gap-1.5 rounded-window bg-field px-3.5 py-2.5 text-[15px] leading-relaxed text-ink shadow-hairline sm:py-2 sm:text-[13.5px] ${pending ? "opacity-60" : ""}`}
        aria-busy={pending || undefined}
      >
        {images ? (
          <span className="inline-flex w-fit items-center gap-1.5 text-[12px] font-medium text-ink-3">
            <MediaImage width={13} height={13} strokeWidth={1.8} aria-hidden />
            {images === 1 ? "1 image" : `${images} images`}
          </span>
        ) : null}
        {handoff && (
          <span className="text-[12px] font-medium text-ink-3">
            Continued from {handoff.from}
            {handoff.title ? `: ${handoff.title}` : ""}
          </span>
        )}
        {handoff && !expanded && handoff.next && <UserText text={handoff.next} />}
        {text && (!handoff || expanded) && (
          <div
            className={`relative min-w-0 ${clamp ? "max-h-[17.5em] overflow-hidden" : ""}`}
            style={clamp ? { maskImage: "linear-gradient(to bottom, black 75%, transparent)", WebkitMaskImage: "linear-gradient(to bottom, black 75%, transparent)" } : undefined}
          >
            <UserText text={text} />
          </div>
        )}
        {long && (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className="-mx-1 -mb-0.5 w-fit rounded-[6px] px-1 text-[12.5px] font-medium text-ink-2 hover:text-ink"
          >
            {expanded ? "Show less" : "Show all"}
          </button>
        )}
      </div>
      {actions && <MessageActions text={text} ts={ts} align="end" />}
    </div>
  );
});

function Notice({ entry }: { entry: Extract<Entry, { kind: "notice" }> }) {
  /* command output keeps its columns; long one-line system messages read as prose */
  if (entry.text.includes("\n")) {
    return (
      <pre
        tabIndex={0}
        translate="no"
        className={`max-h-64 overflow-auto overscroll-contain rounded-card bg-inset px-3 py-2.5 font-mono text-[11.5px] leading-[1.6] whitespace-pre-wrap shadow-hairline [overflow-wrap:anywhere] focus-visible:[outline-offset:-2px]! ${entry.tone === "warn" ? "text-orange" : "text-ink-2"}`}
        style={enter}
      >
        {entry.text}
      </pre>
    );
  }
  if (entry.text.length > 120) {
    return (
      <p
        className={`rounded-card px-3 py-2 text-[12.5px] leading-relaxed shadow-hairline [overflow-wrap:anywhere] ${entry.tone === "warn" ? "bg-orange-tint text-ink-2" : "bg-inset text-ink-2"}`}
        style={enter}
      >
        {entry.text}
      </p>
    );
  }
  return (
    <div className="flex justify-center" style={enter}>
      <span className={`rounded-full px-2.5 py-1 text-[12px] font-medium ${entry.tone === "warn" ? "bg-orange-tint text-orange" : "bg-hover text-ink-2"}`}>{entry.text}</span>
    </div>
  );
}

function LiveText({ text }: { text: string }) {
  /* streaming mode repairs half-written markdown and draws the caret after the last block */
  return <Markdown text={text} streaming />;
}

export function Thread({
  view,
  busy,
  workingLabel,
  agentName = "Claude",
  onLoadOlder,
  bottomPad,
  footer,
  empty,
  pendingSlot,
}: {
  /** renders a not-yet-recorded message (status, retry, discard) */
  pendingSlot?: (p: SessionView["pending"][number]) => ReactNode;
  view: SessionView;
  busy: boolean;
  workingLabel: string;
  agentName?: string;
  onLoadOlder: () => void;
  bottomPad: number;
  footer?: ReactNode;
  empty?: ReactNode;
}) {
  const blocks = useMemo(() => toBlocks(view.entries), [view.entries]);
  const dividers = useMemo(() => separators(blocks), [blocks]);
  const runs = useStableRuns(blocks, view.results);
  /* the timer counts from the latest user message; a message still being sent has no timestamp yet, so it counts from now */
  const since = useMemo(() => (view.pending.length ? undefined : turnStart(view.entries)), [view.entries, view.pending.length]);
  const [timestamps] = useSetting("showTimestamps");
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const prependAnchor = useRef<{ height: number; top: number } | null>(null);

  /* Follow new content while the reader is at the bottom; scrolling up releases the pin. */
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    let raf = 0;
    const onScroll = () => {
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
      stickRef.current = near;
      setAtBottom(near);
    };
    const pin = () => {
      if (!stickRef.current) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    };
    /* a jump to an earlier spot (find) must win over a resize that lands before its scroll event */
    const release = () => {
      stickRef.current = false;
      cancelAnimationFrame(raf);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener(RELEASE_PIN_EVENT, release);
    const ro = new ResizeObserver(pin);
    ro.observe(content);
    pin();
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener(RELEASE_PIN_EVENT, release);
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);

  /* keep the reading position steady when older history is prepended */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = prependAnchor.current;
    if (!el || !anchor || view.loadingOlder) return;
    el.scrollTop = anchor.top + (el.scrollHeight - anchor.height);
    prependAnchor.current = null;
  }, [view.entries, view.loadingOlder]);

  const loadOlder = () => {
    const el = scrollRef.current;
    if (el) prependAnchor.current = { height: el.scrollHeight, top: el.scrollTop };
    stickRef.current = false;
    onLoadOlder();
  };

  const liveText = view.streams.filter((s) => s.kind === "text" && s.text);
  /* reasoning streaming in for the next step; shown as a live row in the active run */
  const liveThinking = busy && !liveText.length && !view.pending.length ? view.streams.findLast((s) => s.kind === "thinking" && s.text.trim())?.text : undefined;
  const lastBlock = blocks[blocks.length - 1];
  const lastIsRun = lastBlock?.type === "run";
  /* thinking after prose or a prompt has no run to join yet, so it gets one of its own */
  const thinkingAlone = liveThinking !== undefined && !lastIsRun;
  /* an active tool run already shimmers its own header; otherwise show the pixel loader */
  const showWorking = busy && liveText.length === 0 && !thinkingAlone && (!lastIsRun || view.pending.length > 0);

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} className="h-full overflow-y-auto overscroll-contain" role="log" aria-live="polite" aria-relevant="additions" aria-busy={busy}>
        <div ref={contentRef} className="mx-auto flex w-full max-w-(--thread-w) flex-col gap-(--thread-gap) px-4 pt-5 sm:px-8 sm:pt-8" style={{ paddingBottom: bottomPad + 24 }}>
          {view.cursor !== null && (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={loadOlder}
                disabled={view.loadingOlder}
                className="h-9 rounded-full px-3.5 text-[12.5px] font-medium text-ink-2 shadow-btn transition-[background-color,transform] duration-150 hover:bg-hover hover:text-ink active:scale-[0.97] disabled:opacity-60 sm:h-8"
              >
                {view.loadingOlder ? "Loading earlier messages…" : "Load earlier messages"}
              </button>
            </div>
          )}

          {view.status !== "connecting" && blocks.length === 0 && view.pending.length === 0 && empty}

          {blocks.map((b, i) => {
            const style = i > blocks.length - 40 ? undefined : ({ contentVisibility: "auto", containIntrinsicSize: "auto 80px" } as const);
            if (b.type === "user") {
              const divider = dividers.get(b.key);
              return (
                <div key={b.key} className={`${ACTIONS_GAP} ${i ? "mt-4" : ""}`} style={style}>
                  {divider && (
                    <div className="mb-4 flex items-center gap-3 text-[11.5px] font-medium text-ink-3" role="separator" aria-label={divider}>
                      <span className="h-px flex-1 bg-line" />
                      <time dateTime={b.entry.ts}>{divider}</time>
                      <span className="h-px flex-1 bg-line" />
                    </div>
                  )}
                  <UserBubble text={b.entry.text} images={b.entry.images} ts={b.entry.ts} />
                </div>
              );
            }
            if (b.type === "text")
              return (
                <div key={b.key} className={ACTIONS_HOST} style={style}>
                  <Markdown text={b.entry.text} />
                  <MessageActions text={b.entry.text} ts={timestamps ? b.entry.ts : undefined} />
                </div>
              );
            if (b.type === "notice")
              return (
                <div key={b.key} style={style}>
                  <Notice entry={b.entry} />
                </div>
              );
            const run = runs.get(b.key);
            const isLast = i === blocks.length - 1;
            return (
              <div key={b.key} style={style}>
                <ToolRun
                  items={run?.items ?? b.items}
                  results={run?.results ?? EMPTY_RESULTS}
                  active={busy && isLast && liveText.length === 0 && view.pending.length === 0}
                  thinking={isLast ? liveThinking : undefined}
                />
              </div>
            );
          })}

          {view.pending.map((p) => (
            <div key={p.localId} className="mt-4">
              {pendingSlot ? pendingSlot(p) : <UserBubble text={p.text} pending />}
            </div>
          ))}

          {thinkingAlone && <ToolRun key="live-thinking" items={NO_ITEMS} results={EMPTY_RESULTS} active thinking={liveThinking} />}

          {liveText.map((s) => (
            <LiveText key={`${s.msgId}:${s.index}`} text={s.text} />
          ))}

          {showWorking && (
            <div className="flex min-h-6 items-center" style={{ animation: "fade-in 200ms ease-out both" }}>
              <LoadingState label={workingLabel} variant="Dots" since={since} />
            </div>
          )}

          {footer}
        </div>
      </div>

      {!atBottom && (
        <button
          type="button"
          aria-label={footer ? `${agentName} needs you` : "Jump to latest"}
          onClick={() => {
            stickRef.current = true;
            scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
          }}
          className={`absolute left-1/2 z-10 flex h-9 -translate-x-1/2 items-center justify-center gap-1.5 rounded-full shadow-raised transition-[transform,color] duration-150 active:scale-[0.94] ${
            footer ? "bg-orange-tint px-3.5 text-[12.5px] font-medium text-orange-ink" : "w-9 bg-surface text-ink-2 hover:text-ink"
          }`}
          style={{ bottom: bottomPad + 12, animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both" }}
        >
          {footer && <span>{agentName} needs you</span>}
          <ArrowDown width={16} height={16} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}
