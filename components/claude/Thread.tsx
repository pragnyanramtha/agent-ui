"use client";

import { parseHandoff } from "@/lib/handoff-text";
import { memo, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, MediaImage } from "iconoir-react";
import { Boundary } from "./Boundary";
import { splitAttachments } from "@/lib/attachments";
import { SentFiles } from "./Attachments";
import LoadingState from "@/components/primitives/LoadingState";
import type { Entry, ToolResult } from "@/lib/types";
import type { SessionView } from "@/lib/client/useSession";
import { useSetting } from "@/lib/client/settings";
import { editsIn, failedCount, splitTurns, toBlocks, undoCheckpoint, type Block } from "@/lib/client/turns";
import type { GitInfo } from "@/lib/client/useGitInfo";
import { api } from "@/lib/client/api";
import { confirmAsk } from "./Ask";
import { dayStamp, type TimeFormat } from "@/lib/time-format";
import { Markdown } from "./Markdown";
import { ACTIONS_GAP, ACTIONS_HOST, ACTIONS_PAD, MessageActions } from "./MessageActions";
import { ENTER } from "./motion";
import { ToolRun, type RunItem } from "./ToolRun";
import { TurnChanges, TurnFold } from "./TurnFold";
import "./thread.css";
import { scrollBehavior } from "@/lib/client/motion";
import { estimateHeight, growWindow, windowStart, WINDOW_FILL_STEP, WINDOW_INITIAL, WINDOW_STEP } from "@/lib/client/thread-window";

/** Dispatched on the thread's scroll box to stop following new content before jumping to an earlier spot. */
export const RELEASE_PIN_EVENT = "cui:release-pin";
/** Dispatched on the thread's scroll box to render every loaded message, so find can search them all. */
export const SHOW_ALL_EVENT = "cui:show-all";
/** Dispatched back on the scroll box once every loaded message is rendered. */
export const SHOWN_ALL_EVENT = "cui:shown-all";

const GAP_MS = 30 * 60_000;
/* how long after opening a session "Never" auto-scroll still keeps the newest content in view, while history lands */
const SETTLE_MS = 1500;

/** A time divider before a user turn that starts a new day or comes after a long pause. */
function separators(blocks: Block[], fmt: TimeFormat) {
  const out = new Map<string, string>();
  let last = 0;
  for (const b of blocks) {
    if (b.type !== "user") continue;
    const t = Date.parse(b.entry.ts);
    if (!Number.isFinite(t)) continue;
    if (!last || t - last > GAP_MS || new Date(t).toDateString() !== new Date(last).toDateString()) out.set(b.key, dayStamp(t, fmt));
    last = t;
  }
  return out;
}

/**
 * Whether the agent is still on the last turn. Busy alone isn't enough: right after a send the
 * agent is busy before the new prompt reaches the transcript, and the turn before it must stay
 * folded. A turn seen finished counts as finished until it grows again.
 */
function useLiveTurn(entries: Entry[], busy: boolean) {
  const settled = useRef<{ key: string; size: number } | null>(null);
  let size = 0;
  let key = "";
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].kind === "user") {
      key = entries[i].id;
      break;
    }
    size++;
  }
  if (!busy) settled.current = { key, size };
  return busy && !(settled.current?.key === key && settled.current.size === size);
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
    for (const b of blocks.flatMap((x) => (x.type === "fold" ? x.blocks : [x]))) {
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

/* A smooth scroll across a long thread crawls (and restarts as off-screen blocks take their real height on the
 * way), so a far jump lands two screens short at once and glides the rest. */
function jumpToEnd(el: HTMLElement) {
  const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
  if (gap > el.clientHeight * 3) el.scrollTop = el.scrollHeight - el.clientHeight * 3;
  el.scrollTo({ top: el.scrollHeight, behavior: scrollBehavior() });
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
      <p translate="no" className="font-mono text-sm whitespace-pre-wrap [overflow-wrap:anywhere] sm:text-[12.5px]">
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
            className="max-h-72 overflow-auto overscroll-contain rounded-[8px] bg-inset px-2.5 py-2 font-mono text-xs leading-[1.6] whitespace-pre text-ink-2 shadow-hairline focus-visible:[outline-offset:-2px]!"
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
    <div className={`flex flex-col items-end ${actions ? ACTIONS_PAD : ""}`} style={enter}>
      <SentFiles paths={paths} />
      <div
        className={`flex max-w-[80%] min-w-0 flex-col gap-1.5 rounded-window bg-field px-3.5 py-2.5 text-md leading-relaxed text-ink sm:px-4 sm:py-3 sm:text-base ${pending ? "opacity-60" : ""}`}
        aria-busy={pending || undefined}
      >
        {images ? (
          <span className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-ink-3">
            <MediaImage width={13} height={13} strokeWidth={1.8} aria-hidden />
            {images === 1 ? "1 image" : `${images} images`}
          </span>
        ) : null}
        {handoff && (
          <span className="text-xs font-medium text-ink-3">
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
      <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${entry.tone === "warn" ? "bg-orange-tint text-orange" : "bg-hover text-ink-2"}`}>{entry.text}</span>
    </div>
  );
}

function LiveText({ text }: { text: string }) {
  /* streaming mode repairs half-written markdown and draws the caret after the last block */
  return <Markdown text={text} streaming />;
}

type BlockListProps = {
  blocks: Block[];
  start: number;
  dividers: Map<string, string>;
  runs: Map<string, RunProps>;
  results: Record<string, ToolResult>;
  timestamps: boolean;
  foldsOpen: boolean;
  changesCard: boolean;
  /** the last run is the one the agent is working in */
  activeLast: boolean;
  liveThinking?: string;
  undoKey: string | null;
  onUndo: () => Promise<string | null>;
  onView?: () => void;
};

/**
 * The rendered part of the thread, from `start` to the end. Its own memo boundary, so the composer growing
 * or anything else that re-renders the thread around it costs nothing here.
 */
const BlockList = memo(function BlockList({ blocks, start, dividers, runs, results, timestamps, foldsOpen, changesCard, activeLast, liveThinking, undoKey, onUndo, onView }: BlockListProps) {
  return blocks.slice(start).map((b, at) => {
    const i = start + at;
    /* off-screen blocks skip layout and paint; the newest stay live so streaming and scroll-to-bottom stay exact */
    const style = i > blocks.length - WINDOW_INITIAL ? undefined : { contentVisibility: "auto" as const, containIntrinsicSize: `auto ${estimateHeight(b, foldsOpen)}px` };
    if (b.type === "user") {
      const divider = dividers.get(b.key);
      return (
        <div key={b.key} data-block className={`${ACTIONS_GAP} ${i ? "mt-4" : ""}`} style={style}>
          {divider && (
            <div className="mb-4 flex items-center gap-3 text-[11.5px] font-medium text-ink-3" role="separator" aria-label={divider}>
              <span className="h-px flex-1 bg-line" />
              <time dateTime={b.entry.ts}>{divider}</time>
              <span className="h-px flex-1 bg-line" />
            </div>
          )}
          <Boundary resetKey={b.entry} entry={b.entry}>
            <UserBubble text={b.entry.text} images={b.entry.images} ts={b.entry.ts} />
          </Boundary>
        </div>
      );
    }
    if (b.type === "text")
      return b.final ? (
        <div key={b.key} data-block className={ACTIONS_HOST} style={style}>
          <Boundary resetKey={b.entry} entry={b.entry}>
            <Markdown text={b.entry.text} />
            <MessageActions text={b.entry.text} ts={timestamps ? b.entry.ts : undefined} />
          </Boundary>
        </div>
      ) : (
        <div key={b.key} data-block style={style}>
          <Boundary resetKey={b.entry} entry={b.entry}>
            <Markdown text={b.entry.text} />
          </Boundary>
        </div>
      );
    if (b.type === "notice")
      return (
        <div key={b.key} data-block style={style}>
          <Boundary resetKey={b.entry} entry={b.entry}>
            <Notice entry={b.entry} />
          </Boundary>
        </div>
      );
    if (b.type === "fold")
      return (
        <div key={b.key} data-block style={style}>
          <TurnFold ms={b.ms} tools={b.tools} defaultOpen={foldsOpen} failed={b.blocks.reduce((n, c) => n + (c.type === "run" ? failedCount(c.items, runs.get(c.key)?.results ?? EMPTY_RESULTS) : 0), 0)}>
            {b.blocks.map((c) =>
              c.type === "run" ? (
                <ToolRun key={c.key} items={runs.get(c.key)?.items ?? c.items} results={runs.get(c.key)?.results ?? EMPTY_RESULTS} active={false} />
              ) : c.type === "text" ? (
                <Markdown key={c.key} text={c.entry.text} />
              ) : null,
            )}
          </TurnFold>
        </div>
      );
    if (b.type === "changes")
      return !changesCard ? null : (
        <div key={b.key} data-block style={style}>
          <TurnChanges tools={b.tools} results={results} onView={onView} onUndo={b.key === undoKey ? onUndo : undefined} />
        </div>
      );
    const run = runs.get(b.key);
    const isLast = i === blocks.length - 1;
    return (
      <div key={b.key} data-block style={style}>
        <Boundary resetKey={run ?? b.items} entry={run ?? { items: b.items }}>
          <ToolRun items={run?.items ?? b.items} results={run?.results ?? EMPTY_RESULTS} active={activeLast && isLast} thinking={isLast ? liveThinking : undefined} />
        </Boundary>
      </div>
    );
  });
});


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
  changes,
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
  /** the session's folder, for a finished turn's changed-files card: View diff and Undo */
  changes?: { session: string; git: GitInfo | null; onView?: () => void; onUndone?: () => void };
}) {
  const live = useLiveTurn(view.entries, busy);
  const [timeFmt] = useSetting("timeFormat");
  const [showThinking] = useSetting("showThinking");
  const [workLog] = useSetting("workLog");
  const [changesCard] = useSetting("turnChanges");
  const [undoButton] = useSetting("turnUndo");
  const [scrollMode] = useSetting("autoScroll");
  const [streamText] = useSetting("streamText");
  const blocks = useMemo(() => toBlocks(view.entries, live, { thinking: showThinking }), [view.entries, live, showThinking]);
  const dividers = useMemo(() => separators(blocks, timeFmt), [blocks, timeFmt]);
  const runs = useStableRuns(blocks, view.results);
  const lastChanges = useMemo(() => blocks.findLast((b) => b.type === "changes")?.key, [blocks]);
  const turnRefs = useMemo(
    () => (changes?.git?.checkpoints.length ? splitTurns(view.entries).map((t) => ({ text: t.user?.text ?? "", ts: t.user?.ts ?? "", edits: editsIn(t.entries).length > 0 })) : []),
    [view.entries, changes?.git],
  );
  /* only the latest changes can be undone on their own: rewinding further back would take later turns' work too */
  const git = changes?.git;
  const undoId = useMemo(() => {
    const b = blocks.find((x) => x.key === lastChanges);
    if (!undoButton || !git || busy || b?.type !== "changes") return null;
    return undoCheckpoint(git.checkpoints, turnRefs, b.turn) ?? null;
  }, [blocks, lastChanges, undoButton, git, busy, turnRefs]);
  /* the block list gets callbacks that never change, so the props SessionScreen rebuilds each render don't re-render it */
  const changesRef = useRef(changes);
  changesRef.current = changes;
  const undoIdRef = useRef(undoId);
  undoIdRef.current = undoId;
  const onView = useCallback(() => changesRef.current?.onView?.(), []);
  const onUndo = useCallback(async () => {
    const id = undoIdRef.current;
    const changes = changesRef.current;
    if (!id || !changes) return null;
    {
      const ok = await confirmAsk({
        title: "Undo these changes?",
        body: "Files go back to how they were before this turn. The conversation stays as it is, and the current files are saved as a checkpoint first, so you can get them back from Git.",
        confirm: "Undo changes",
        danger: true,
      });
      if (!ok) return null;
      const r = await api<{ changed: number; removed: number }>("/api/git", { session: changes.session, action: "rewind", id });
      changes.onUndone?.();
      return r.changed || r.removed ? "Changes undone" : "Nothing to undo";
    }
  }, []);
  /* the timer counts from the latest user message; a message still being sent has no timestamp yet, so it counts from now */
  const since = useMemo(() => (view.pending.length ? undefined : turnStart(view.entries)), [view.entries, view.pending.length]);
  const [timestamps] = useSetting("showTimestamps");
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  /* Jump to latest is scrolling: off-screen blocks take their real height on the way down, so it keeps chasing the bottom */
  const jumpingRef = useRef(false);
  const [atBottom, setAtBottom] = useState(true);
  const prependAnchor = useRef<{ height: number; top: number } | null>(null);
  const modeRef = useRef(scrollMode);
  modeRef.current = scrollMode;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  /* A long thread renders its newest blocks first and older ones as the reader nears the top (or find asks for all).
   * The window is held by its first block's key; see lib/client/thread-window. */
  const keys = useMemo(() => blocks.map((b) => b.key), [blocks]);
  const [first, setFirst] = useState<string | undefined>(undefined);
  const start = windowStart(keys, first);
  if (keys.length && keys[start] !== first) setFirst(keys[start]);
  const windowRef = useRef({ keys, start });
  windowRef.current = { keys, start };
  const grow = useCallback((step: number) => {
    const { keys, start } = windowRef.current;
    if (start > 0) startTransition(() => setFirst(growWindow(keys, start, step)));
  }, []);
  const [filling, setFilling] = useState(false);

  /* Follow new content while the reader is at the bottom (Settings > Conversation > Auto-scroll):
   *   follow: scrolling up releases the pin, coming back to the bottom takes it again
   *   stop: scrolling up releases it until Jump to latest or the next message sent
   *   never: nothing moves while the agent writes; history still lands at the bottom when a session opens */
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    let raf = 0;
    let lastTop = el.scrollTop;
    const mountedAt = Date.now();
    const isNear = () => el.scrollHeight - el.scrollTop - el.clientHeight < 140;
    /* Where the browser has no scroll anchoring (Safari), keep the block at the top of the view in place by hand
     * when content above it changes height: older blocks rendering, or skipped ones taking their real size. */
    let anchor: { node: Element; y: number } | null = null;
    const remember = () => {
      anchor = null;
      if (stickRef.current || getComputedStyle(el).overflowAnchor === "auto") return;
      const box = el.getBoundingClientRect();
      const node = document.elementFromPoint(box.left + box.width / 2, box.top + 8)?.closest("[data-block]");
      if (node && el.contains(node)) anchor = { node, y: node.getBoundingClientRect().top };
    };
    const restore = () => {
      if (!anchor?.node.isConnected) return;
      const shift = anchor.node.getBoundingClientRect().top - anchor.y;
      if (Math.abs(shift) >= 1) el.scrollTop += shift;
    };
    const onScroll = () => {
      const near = isNear();
      const up = el.scrollTop < lastTop - 1;
      lastTop = el.scrollTop;
      if (jumpingRef.current) {
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 2) jumpingRef.current = false;
        stickRef.current = true;
      } else stickRef.current = modeRef.current === "stop" ? stickRef.current && !(up && !near) : near;
      remember();
      setAtBottom(near);
    };
    const pin = () => {
      if (jumpingRef.current) return jumpToEnd(el);
      if (!stickRef.current) {
        restore();
        return setAtBottom(isNear());
      }
      if (modeRef.current === "never" && busyRef.current && Date.now() - mountedAt > SETTLE_MS) {
        stickRef.current = false;
        return setAtBottom(isNear());
      }
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    };
    /* a jump to an earlier spot (find) must win over a resize that lands before its scroll event */
    const release = () => {
      jumpingRef.current = false;
      stickRef.current = false;
      cancelAnimationFrame(raf);
    };
    /* the reader taking over ends a jump */
    const stopJump = () => {
      jumpingRef.current = false;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener(RELEASE_PIN_EVENT, release);
    el.addEventListener("wheel", stopJump, { passive: true });
    el.addEventListener("touchstart", stopJump, { passive: true });
    el.addEventListener("keydown", stopJump);
    const ro = new ResizeObserver(pin);
    ro.observe(content);
    pin();
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener(RELEASE_PIN_EVENT, release);
      el.removeEventListener("wheel", stopJump);
      el.removeEventListener("touchstart", stopJump);
      el.removeEventListener("keydown", stopJump);
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);

  /* older blocks render once the reader is within a couple of screens of the top */
  useEffect(() => {
    const el = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (!el || !sentinel || start === 0) return;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const io = new IntersectionObserver(
      (seen) => {
        if (!seen.some((e) => e.isIntersecting)) return;
        /* still at the top only because the pin to the bottom hasn't landed yet: look again once it has */
        if (stickRef.current && el.scrollHeight - el.scrollTop - el.clientHeight >= 140) {
          retry = setTimeout(() => {
            io.unobserve(sentinel);
            io.observe(sentinel);
          }, 150);
          return;
        }
        grow(WINDOW_STEP);
      },
      { root: el, rootMargin: "1600px 0px 0px 0px" },
    );
    io.observe(sentinel);
    return () => {
      io.disconnect();
      clearTimeout(retry);
    };
  }, [start, grow]);

  /* find fills in the whole thread a slice per frame, then says so */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const fill = () => setFilling(true);
    el.addEventListener(SHOW_ALL_EVENT, fill);
    return () => el.removeEventListener(SHOW_ALL_EVENT, fill);
  }, []);
  useEffect(() => {
    if (!filling) return;
    if (start === 0) {
      setFilling(false);
      scrollRef.current?.dispatchEvent(new Event(SHOWN_ALL_EVENT));
      return;
    }
    const raf = requestAnimationFrame(() => grow(WINDOW_FILL_STEP));
    return () => cancelAnimationFrame(raf);
  }, [filling, start, grow]);

  /* keep the reading position steady when older history is prepended */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = prependAnchor.current;
    if (!el || !anchor || view.loadingOlder) return;
    el.scrollTop = anchor.top + (el.scrollHeight - anchor.height);
    prependAnchor.current = null;
  }, [view.entries, view.loadingOlder]);

  /* "stop" waits for the reader; sending a message is them coming back */
  const pendingCount = view.pending.length;
  const lastPending = useRef(pendingCount);
  useEffect(() => {
    if (pendingCount > lastPending.current && modeRef.current === "stop" && !stickRef.current) {
      stickRef.current = true;
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
    lastPending.current = pendingCount;
  }, [pendingCount]);

  /* rendered blocks come first; only then is there more to fetch */
  const loadOlder = () => {
    if (start > 0) return grow(WINDOW_STEP);
    const el = scrollRef.current;
    if (el) prependAnchor.current = { height: el.scrollHeight, top: el.scrollTop };
    stickRef.current = false;
    onLoadOlder();
  };

  /* "When complete" leaves text that's still arriving out; the working indicator stands in until it lands */
  const liveText = streamText === "live" ? view.streams.filter((s) => s.kind === "text" && s.text) : [];
  /* reasoning streaming in for the next step; shown as a live row in the active run */
  const liveThinking = showThinking && busy && !liveText.length && !view.pending.length ? view.streams.findLast((s) => s.kind === "thinking" && s.text.trim())?.text : undefined;
  const lastBlock = blocks[blocks.length - 1];
  const lastIsRun = lastBlock?.type === "run";
  /* thinking after prose or a prompt has no run to join yet, so it gets one of its own */
  const thinkingAlone = liveThinking !== undefined && !lastIsRun;
  /* an active tool run already shimmers its own header; otherwise show the pixel loader */
  const showWorking = busy && liveText.length === 0 && !thinkingAlone && (!lastIsRun || view.pending.length > 0);

  return (
    <div className="thread-prose relative min-h-0 flex-1">
      <div ref={scrollRef} className="h-full overflow-y-auto overscroll-contain" role="log" aria-live="polite" aria-relevant="additions" aria-busy={busy}>
        <div ref={contentRef} className="mx-auto flex w-full max-w-(--thread-w) flex-col gap-(--thread-gap) px-4 pt-5 sm:px-8 sm:pt-8" style={{ paddingBottom: bottomPad + 24 }}>
          {(start > 0 || view.cursor !== null) && (
            <div className="relative flex justify-center">
              {start > 0 && <div ref={sentinelRef} aria-hidden className="absolute top-0" />}
              <button
                type="button"
                onClick={loadOlder}
                disabled={start === 0 && view.loadingOlder}
                className="h-9 rounded-full px-3.5 text-[12.5px] font-medium text-ink-2 shadow-btn transition-[background-color,transform] duration-150 hover:bg-hover hover:text-ink active:scale-[0.97] disabled:opacity-60 sm:h-8"
              >
                {start === 0 && view.loadingOlder ? "Loading earlier messages…" : "Load earlier messages"}
              </button>
            </div>
          )}

          {view.status !== "connecting" && blocks.length === 0 && view.pending.length === 0 && empty}

          <BlockList
            blocks={blocks}
            start={start}
            dividers={dividers}
            runs={runs}
            results={view.results}
            timestamps={timestamps}
            foldsOpen={workLog === "expanded"}
            changesCard={changesCard}
            activeLast={busy && liveText.length === 0 && view.pending.length === 0}
            liveThinking={liveThinking}
            undoKey={undoId ? (lastChanges ?? null) : null}
            onUndo={onUndo}
            onView={changes?.onView ? onView : undefined}
          />

          {view.pending.map((p) => (
            <div key={p.localId} className="mt-4">
              <Boundary resetKey={p} entry={p}>
                {pendingSlot ? pendingSlot(p) : <UserBubble text={p.text} pending />}
              </Boundary>
            </div>
          ))}

          {thinkingAlone && (
            <Boundary key="live-thinking" resetKey={liveThinking}>
              <ToolRun items={NO_ITEMS} results={EMPTY_RESULTS} active thinking={liveThinking} />
            </Boundary>
          )}

          {liveText.map((s) => (
            <Boundary key={`${s.msgId}:${s.index}`} resetKey={s.text} entry={s}>
              <LiveText text={s.text} />
            </Boundary>
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
            const el = scrollRef.current;
            if (!el) return;
            stickRef.current = true;
            jumpingRef.current = scrollBehavior() === "smooth";
            jumpToEnd(el);
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
