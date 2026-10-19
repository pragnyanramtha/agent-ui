"use client";

import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { Xmark } from "iconoir-react";
import type { SessionView } from "@/lib/client/useSession";
import { terminalBusy } from "@/lib/status";
import { modalOpen } from "@/lib/client/shortcuts";
import {
  contextOf,
  contextSeries,
  contextTone,
  fmtDuration,
  fmtPct,
  fmtTokens as k,
  fmtUsd,
  latestUsage,
  sessionCost,
  turnTimings,
  usageTotals,
  type ContextState,
  type SessionCost,
  type UsageTotals,
} from "@/lib/client/usage";

const TURN_ROWS = 20;

/* stacking tints, shared by bar slices and legend dots */
const SOLID = "var(--accent)";
const FADED = "color-mix(in oklch, var(--accent) 45%, transparent)";
const MUTED = "var(--ink-3)";
const FREE = "var(--line-strong)";

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-b border-line px-3 py-4 last:border-b-0 sm:px-4">
      <div className="mb-2.5 flex items-baseline gap-2">
        <h3 className="text-[12.5px] font-medium text-ink">{title}</h3>
        {aside && <div className="ml-auto text-[12px] text-ink-3 tabular-nums">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

const Dot = ({ color }: { color: string }) => <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: color }} />;

/** A stacked bar of named slices; widths are fractions of the whole bar. */
function StackedBar({ slices, label }: { slices: { label: string; value: number; color: string; text: string }[]; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex h-2 gap-px overflow-hidden rounded-full bg-inset shadow-hairline">
      {slices
        .filter((s) => s.value >= 0.002)
        .map((s) => (
          <div
            key={s.label}
            role="meter"
            aria-label={s.label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(s.value * 100)}
            aria-valuetext={s.text}
            className="h-full transition-[width] duration-500 first:rounded-l-full last:rounded-r-full"
            style={{ width: `${Math.min(1, s.value) * 100}%`, background: s.color }}
          />
        ))}
    </div>
  );
}

function ContextBreakdown({ ctx }: { ctx: ContextState }) {
  const rows = [
    { label: "Cached", n: ctx.cached, color: SOLID },
    { label: "Newly cached", n: ctx.newlyCached, color: FADED },
    { label: "Uncached input", n: ctx.uncached, color: MUTED },
  ];
  const tone = contextTone(ctx.pct);
  return (
    <Section
      title="Context"
      aside={
        <span style={{ color: ctx.pct >= 0.7 ? tone : undefined }}>
          {k(ctx.used)} / {k(ctx.window)} · {fmtPct(ctx.pct)}
        </span>
      }
    >
      <StackedBar label="Context window" slices={rows.map((r) => ({ label: r.label, value: r.n / ctx.window, color: r.color, text: `${k(r.n)} tokens` }))} />
      <dl className="mt-3 flex flex-col gap-1.5 text-[12.5px]">
        {[...rows, { label: "Free", n: ctx.free, color: FREE }].map((r) => (
          <div key={r.label} className="flex items-center gap-2">
            <Dot color={r.color} />
            <dt className="text-ink-3">{r.label}</dt>
            <dd className="ml-auto flex gap-3 text-ink-2 tabular-nums">
              <span className="w-10 text-right text-ink-3">{fmtPct(r.n / ctx.window)}</span>
              <span className="w-12 text-right">{k(r.n)}</span>
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-2.5 text-[11.5px] text-ink-3">
        As of the latest API call{ctx.model ? <span className="font-mono"> · {ctx.model}</span> : null}. Last reply wrote {k(ctx.output)} tokens.
      </p>
      {ctx.pct >= 0.8 && <p className="mt-1.5 text-[12px] text-orange-ink">Getting full. /compact frees space.</p>}
    </Section>
  );
}

function CostMeter({ cost, totals }: { cost: SessionCost; totals: UsageTotals }) {
  const tint = (i: number) => (i === 0 ? SOLID : i === 1 ? FADED : MUTED);
  return (
    <Section title="Cost" aside={cost.actualUsd !== null ? "reported by the run" : "estimated"}>
      <div className="flex items-baseline gap-2">
        <span className="text-[24px] leading-none font-semibold tracking-[-0.01em] text-ink tabular-nums">{fmtUsd(cost.usd)}</span>
        {cost.estimated && <span className="rounded-chip bg-field px-1.5 py-0.5 text-[11px] font-medium text-ink-3 shadow-hairline">est.</span>}
        <span className="text-[12px] text-ink-3">{cost.actualUsd !== null ? "web run" : "session"}</span>
        {cost.actualUsd !== null && totals.calls > 0 && (
          <span className="ml-auto text-[12px] text-ink-3 tabular-nums" title="Estimated from every loaded API call at list prices">
            {fmtUsd(cost.estUsd)} est. transcript
          </span>
        )}
      </div>
      {totals.models.length > 0 && (
        <>
          <div className="mt-3">
            <StackedBar label="Cost by model" slices={totals.models.map((m, i) => ({ label: m.model, value: m.share, color: tint(i), text: `${fmtUsd(m.usd)} est.` }))} />
          </div>
          <ul className="mt-3 flex flex-col gap-2 text-[12.5px]">
            {totals.models.map((m, i) => (
              <li key={m.model} className="flex min-w-0 items-center gap-2">
                <Dot color={tint(i)} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-[12px] text-ink-2" title={m.model}>
                    {m.model}
                  </p>
                  <p className="text-[11.5px] text-ink-3 tabular-nums">
                    {k(m.input + m.cacheRead + m.cacheWrite)} in · {k(m.output)} out · {m.calls} {m.calls === 1 ? "call" : "calls"}
                    {m.price.fallback ? " · generic rate" : ""}
                  </p>
                </div>
                <span className="shrink-0 text-ink-2 tabular-nums">
                  {fmtUsd(m.usd)} <span className="text-ink-3">est.</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="mt-3 text-[11.5px] leading-relaxed text-ink-3">
        Estimates use list prices per million tokens{cost.fallback ? ", with a generic rate for unrecognized models" : ""}. Subscription plans aren&apos;t billed per token.
      </p>
    </Section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-[10px] bg-inset px-3 py-2 shadow-hairline" title={hint}>
      <dt className="truncate text-[11.5px] text-ink-3">{label}</dt>
      <dd className="mt-0.5 text-[15px] font-medium text-ink tabular-nums">{value}</dd>
    </div>
  );
}

function Tokens({ totals }: { totals: UsageTotals }) {
  return (
    <Section title="Tokens" aside={`${totals.calls} API ${totals.calls === 1 ? "call" : "calls"}`}>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat label="Output" value={k(totals.output)} />
        <Stat label="Cache reads" value={k(totals.cacheRead)} />
        <Stat label="Cache writes" value={k(totals.cacheWrite)} />
        <Stat label="Uncached input" value={k(totals.input)} />
        <Stat label="Cache hit rate" value={fmtPct(totals.cacheHit)} hint="Cache reads as a share of all input the model saw" />
        <Stat label="Turns" value={String(totals.turns)} />
      </dl>
    </Section>
  );
}

/** Context size after every API call, scaled to the session's peak. Drops are compactions. */
function Sparkline({ points, window }: { points: { t: number; used: number }[]; window: number }) {
  const W = 300;
  const H = 48;
  const peak = points.reduce((m, p) => Math.max(m, p.used), 1);
  const xs = points.length > 1 ? points.map((_, i) => (i / (points.length - 1)) * W) : [0, W];
  const ys = (points.length > 1 ? points : [points[0], points[0]]).map((p) => H - 2 - (p.used / peak) * (H - 6));
  const line = xs.map((x, i) => `${i ? "L" : "M"}${x.toFixed(1)} ${ys[i].toFixed(1)}`).join(" ");
  const area = `${line} L${W} ${H} L0 ${H} Z`;
  const last = points[points.length - 1];
  const pct = last.used / window;
  return (
    <Section title="Context over time" aside={`peak ${k(peak)} · now ${k(last.used)}`}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-12 w-full overflow-visible" role="img" aria-label={`Context grew to a peak of ${k(peak)} tokens over ${points.length} API calls`}>
        <path d={area} fill="var(--accent-tint)" />
        <path d={line} fill="none" stroke={pct >= 0.7 ? contextTone(pct) : "var(--accent)"} strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mt-1.5 flex justify-between text-[11px] text-ink-3 tabular-nums">
        <span>{fmtTime(points[0].t)}</span>
        <span>
          {points.length} {points.length === 1 ? "call" : "calls"}
        </span>
        <span>{fmtTime(last.t)}</span>
      </div>
    </Section>
  );
}

const fmtTime = (t: number | string) => {
  const d = new Date(t);
  return Number.isNaN(d.getTime()) || !t ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

function Turns({ view, busy }: { view: SessionView; busy: boolean }) {
  const turns = useMemo(() => turnTimings(view.entries), [view.entries]);
  const recent = turns.slice(-TURN_ROWS).reverse();
  const timed = turns.filter((t) => t.durationMs !== null && !(t.open && busy));
  const avg = timed.length ? timed.reduce((s, t) => s + (t.durationMs ?? 0), 0) / timed.length : null;
  if (!turns.length) return null;
  return (
    <Section title="Turns" aside={avg !== null ? `avg ${fmtDuration(avg)}` : undefined}>
      <div role="table" aria-label="Turn timing" className="text-[12.5px]">
        <div role="row" className="grid grid-cols-[4.25rem_minmax(0,1fr)_4rem_3.5rem_3.5rem] gap-2 border-b border-line pb-1.5 text-[11.5px] text-ink-3">
          <span role="columnheader">Time</span>
          <span role="columnheader">Prompt</span>
          <span role="columnheader" className="text-right">
            Duration
          </span>
          <span role="columnheader" className="text-right">
            Output
          </span>
          <span role="columnheader" className="text-right" title="Output tokens per second of turn time, tool runs included">
            Tok/s
          </span>
        </div>
        {recent.map((t) => {
          const live = t.open && busy;
          return (
            <div key={t.id} role="row" className="grid grid-cols-[4.25rem_minmax(0,1fr)_4rem_3.5rem_3.5rem] items-baseline gap-2 border-b border-line py-1.5 last:border-b-0">
              <span role="cell" className="whitespace-nowrap text-ink-3 tabular-nums">
                {fmtTime(t.ts)}
              </span>
              <span role="cell" className="truncate text-ink-2" title={t.text}>
                {t.text.replace(/\s+/g, " ").trim() || "(image)"}
              </span>
              <span role="cell" className="text-right text-ink-2 tabular-nums">
                {live ? <span className="text-ink-3">Running…</span> : t.durationMs !== null ? fmtDuration(t.durationMs) : "–"}
              </span>
              <span role="cell" className="text-right text-ink-2 tabular-nums">
                {t.output ? k(t.output) : "–"}
              </span>
              <span role="cell" className="text-right text-ink-3 tabular-nums">
                {!live && t.tokensPerSec !== null ? t.tokensPerSec.toFixed(t.tokensPerSec < 10 ? 1 : 0) : "–"}
              </span>
            </div>
          );
        })}
      </div>
      {turns.length > TURN_ROWS && <p className="mt-2 text-[11.5px] text-ink-3">Latest {TURN_ROWS} of {turns.length} turns.</p>}
    </Section>
  );
}

/** Session usage sheet: context breakdown, cost meter, token totals, context growth, and per-turn timing. */
export function UsagePanel({ view, onClose }: { view: SessionView; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const totals = useMemo(() => usageTotals(view.entries), [view.entries]);
  const latest = useMemo(() => latestUsage(view.entries), [view.entries]);
  const series = useMemo(() => contextSeries(view.entries), [view.entries]);
  const cost = useMemo(() => sessionCost(view.entries, view.run, totals), [view.entries, view.run, totals]);
  const busy = view.run ? view.run.status === "running" || view.run.status === "starting" : terminalBusy(view.terminal?.status);
  const partial = view.cursor !== null;

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && !modalOpen() && closeRef.current();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <aside
      ref={ref}
      tabIndex={-1}
      aria-label="Usage"
      className="absolute inset-0 z-20 flex flex-col bg-page outline-none lg:static lg:inset-auto lg:w-[440px] lg:shrink-0 lg:border-l lg:border-line xl:w-[520px]"
      style={{ animation: "fade-up 220ms cubic-bezier(0.23,1,0.32,1) both" }}
    >
      <div className="safe-top flex shrink-0 items-center gap-2 border-b border-line px-3 sm:px-4">
        <div className="flex h-14 min-w-0 flex-1 items-center gap-2">
          <span className="text-[14px] font-semibold text-ink">Usage</span>
          {totals.calls > 0 && (
            <span className="text-[12px] text-ink-3 tabular-nums">
              {fmtUsd(cost.usd)}
              {cost.estimated ? " est." : ""} · {k(totals.output)} out
            </span>
          )}
          <button type="button" onClick={onClose} aria-label="Close usage" className="tap relative ml-auto flex size-9 items-center justify-center rounded-[9px] text-ink-3 hover:bg-hover hover:text-ink">
            <Xmark width={16} height={16} strokeWidth={2} />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {partial && <p className="px-3 pt-3 text-[11.5px] text-ink-3 sm:px-4">From the loaded part of the conversation. Load earlier messages to include older usage.</p>}
        {totals.calls === 0 && !latest ? (
          <p className="px-4 py-10 text-center text-[13px] text-ink-3">No token usage reported in this conversation yet.</p>
        ) : (
          <>
            {latest && <ContextBreakdown ctx={contextOf(latest)} />}
            <CostMeter cost={cost} totals={totals} />
            <Tokens totals={totals} />
            {series.length > 0 && latest && <Sparkline points={series} window={contextOf(latest).window} />}
            <Turns view={view} busy={busy} />
          </>
        )}
      </div>
    </aside>
  );
}
