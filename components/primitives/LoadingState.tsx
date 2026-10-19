"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

/* ─────────────────────────────────────────────────────────
 * LOADING STATE — pixel-grid loader for long-running work
 *
 * Variants:
 *   Drive  — square cells, chevron wavefront driving right;
 *            the 650ms cycle is shorter than the sweep, so
 *            two fronts are always in flight
 *   Dots   — same wavefront, circular cells
 *   Orbit  — a comet lapping the grid perimeter
 *   Surfer — the Drive loader paired with a meme video below
 *
 * Paired with a shimmering label and a live elapsed timer
 * in mono tabular figures. Reduced motion freezes the grid
 * to its dim state; the timer still ticks.
 * ───────────────────────────────────────────────────────── */

const chevron = Array.from({ length: 9 }, (_, i) => {
  const r = Math.floor(i / 3), c = i % 3;
  return (c + Math.abs(r - 1)) * 90;
});

const ORBIT_ORDER = [0, 1, 2, 5, 8, 7, 6, 3];
const orbit = Array.from({ length: 9 }, (_, i) => {
  const k = ORBIT_ORDER.indexOf(i);
  return k === -1 ? null : k * 110;
});

const PATTERNS: Record<string, { delays: (number | null)[]; dur: number; round: boolean }> = {
  Drive: { delays: chevron, dur: 650, round: false },
  Dots: { delays: chevron, dur: 650, round: true },
  Orbit: { delays: orbit, dur: 950, round: false },
};

function LoaderGrid({
  delays,
  dur,
  round,
  paused,
}: {
  delays: (number | null)[];
  dur: number;
  round: boolean;
  paused?: boolean;
}) {
  return (
    <span aria-hidden className="grid shrink-0 grid-cols-[repeat(3,4px)] gap-[1.5px]">
      {delays.map((delay, index) => (
        <span
          key={index}
          className={`size-[4px] bg-ink ${round ? "rounded-full" : "rounded-[1px]"}`}
          style={{
            opacity: delay === null ? 0.07 : 0.15,
            animation: delay === null || paused ? "none" : `pixel-on ${dur}ms ease-in-out ${delay}ms infinite`,
          }}
        />
      ))}
    </span>
  );
}

/** True while the element is on screen and the tab is visible; used to stop ticking and animating when nobody can see it. */
function useOnScreen(ref: RefObject<HTMLElement | null>) {
  const [inView, setInView] = useState(true);
  const [tabVisible, setTabVisible] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  useEffect(() => {
    const sync = () => setTabVisible(document.visibilityState !== "hidden");
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);
  return inView && tabVisible;
}

export function formatElapsed(ms: number) {
  const total = Math.max(0, ms) / 1000;
  if (total < 60) return `${total.toFixed(1)}s`;
  const mins = Math.floor(total / 60);
  if (mins < 60) return `${mins}m ${Math.floor(total % 60)}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** Elapsed time since `since` (epoch ms), or since mount when it is unknown. Only ticks while `live`. */
function useElapsed(since: number | undefined, live: boolean) {
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  /* a timestamp from the future (host and browser clocks disagree) falls back to mount time */
  const start = since !== undefined && Number.isFinite(since) && since <= mountedAt + 1000 ? since : mountedAt;
  const pastMinute = now - start >= 60_000;
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    /* tenths only matter in the first minute; after that a 1s tick is enough */
    const t = setInterval(() => setNow(Date.now()), pastMinute ? 1000 : 100);
    return () => clearInterval(t);
  }, [live, start, pastMinute]);
  return formatElapsed(now - start);
}

/** Loading labels always end with an ellipsis. */
const withEllipsis = (label: string) => label.replace(/\s*(\.{3}|…)?\s*$/, "…");

/* the shimmer lives in classes (not inline styles) so reduced motion can swap it for plain text */
const SHIMMER =
  "bg-[linear-gradient(90deg,var(--ink-3)_35%,var(--ink)_50%,var(--ink-3)_65%)] bg-[length:200%_100%] bg-clip-text text-transparent animate-[shimmer-text_1.4s_linear_infinite] motion-reduce:animate-none motion-reduce:bg-none motion-reduce:text-ink-2";

export default function LoadingState({
  label,
  variant = "Drive",
  since,
  /** the meme feed for the Surfer variant; hosted on Vercel Blob so it plays in
   *  production (the local /public/subway-surfers.mp4 stays gitignored).
   *  Heavily compressed (288px, 20fps, no audio → ~265 KB, from 1.1 MB) to keep
   *  Blob data transfer down. */
  videoSrc = "https://95dnc2a95qgwt9ff.public.blob.vercel-storage.com/subway-surfers-min.mp4",
}: {
  label?: string;
  variant?: string;
  /** when the work started (epoch ms); the timer counts from mount when omitted */
  since?: number;
  videoSrc?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const live = useOnScreen(rootRef);
  const elapsed = useElapsed(since, live);
  const surfer = variant === "Surfer";
  const resolvedLabel = withEllipsis(label ?? (surfer ? "Subway surfing" : "Churning"));
  const [videoOk, setVideoOk] = useState(true);
  const { delays, dur, round } = PATTERNS[variant] ?? PATTERNS.Drive;
  /* off screen or in a background tab nothing needs to move */
  const paused = !live;

  const labelEl = (
    <span className={`text-sm font-medium ${SHIMMER}`} style={paused ? { animationPlayState: "paused" } : undefined}>
      {resolvedLabel}
    </span>
  );
  /* the timer ticks ten times a second; keep it out of the live region so screen readers only hear the label */
  const elapsedEl = (
    <span aria-hidden className="font-mono text-xs text-ink-3 tabular-nums">
      {elapsed}
    </span>
  );

  if (surfer) {
    return (
      <div ref={rootRef} role="status" className="flex w-fit flex-col items-start">
        <div className="flex items-center gap-2.5">
          <LoaderGrid {...PATTERNS.Drive} paused={paused} />
          {labelEl}
          {elapsedEl}
        </div>

        {/* the context card follows the status text it is illustrating */}
        <div
          className="mt-2 w-56 overflow-hidden rounded-[10px] shadow-overlay"
          style={{ animation: "pop-in 200ms cubic-bezier(0.16,1,0.3,1) both", transformOrigin: "top left" }}
        >
          <div className="relative aspect-video w-full" style={{ background: "var(--tooltip-bg)" }}>
            {videoOk ? (
              <video
                src={videoSrc}
                autoPlay
                muted
                loop
                playsInline
                onError={() => setVideoOk(false)}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-1.5">
                <LoaderGrid {...PATTERNS.Drive} />
                <span className="px-3 text-center font-mono text-[10px]" style={{ color: "var(--tooltip-muted)" }}>
                  Video unavailable
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} role="status" className="flex w-fit items-center gap-2.5">
      <LoaderGrid delays={delays} dur={dur} round={round} paused={paused} />
      {labelEl}
      {elapsedEl}
    </div>
  );
}
