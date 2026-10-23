"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Menu, StatsReport, WarningTriangle } from "iconoir-react";
import { api, timeAgo } from "@/lib/client/api";
import { fmtTokens, fmtUsd } from "@/lib/client/usage";
import { AGENT_LABEL, type AgentId } from "@/lib/types";
import { chartSeries, dayStack, niceMax, RANGES, tokSum, type DayRow, type RangeDays, type Sum, type UsageReport } from "@/lib/usage-report";
import { AGENT_CHART_TOKEN, OTHER_TOKEN, SERIES_TOKENS, tokenVar } from "@/lib/client/chart-colors";
import { EmptyState } from "@/components/primitives/EmptyState";
import { Segmented } from "./settings/controls";
import { Select } from "./Select";

type By = "agent" | "model";
type Filters = { agent: string; profile: string; project: string };

/* while older sessions are still being read, ask again this often, a bounded number of times */
const PARTIAL_RETRY_MS = 1500;
const PARTIAL_RETRIES = 40;

const zone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

const dayDate = (day: string) => new Date(`${day}T12:00:00Z`);
const shortDay = (day: string) => dayDate(day).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const longDay = (day: string) => dayDate(day).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** "$12.40" for priced usage, the token count when nothing in it has a price. */
const money = (s: Sum) => (s.usd > 0 || s.unpriced === 0 ? fmtUsd(s.usd) : `${fmtTokens(tokSum(s))} tokens`);

export function UsageScreen({ onMenu, extra, onOpen }: { onMenu: () => void; extra?: ReactNode; onOpen: (id: string) => void }) {
  const [days, setDays] = useState<RangeDays>(30);
  const [by, setBy] = useState<By>("agent");
  const [filters, setFilters] = useState<Filters>({ agent: "", profile: "", project: "" });
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const retries = useRef(0);

  const query = useMemo(() => {
    const p = new URLSearchParams({ tz: zone(), days: String(days) });
    if (filters.agent) p.set("agent", filters.agent);
    if (filters.profile) p.set("profile", filters.profile);
    if (filters.project) p.set("project", filters.project);
    return p.toString();
  }, [days, filters]);

  useEffect(() => {
    retries.current = 0;
  }, [query]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api<UsageReport>(`/api/usage?${query}`)
      .then((r) => {
        if (!live) return;
        setReport(r);
        setError(null);
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : "The server didn't answer."))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [query, attempt]);

  /* a cold start reads in slices: keep asking while the server says it isn't done */
  useEffect(() => {
    if (!report?.partial || loading || retries.current >= PARTIAL_RETRIES) return;
    const t = setTimeout(() => {
      retries.current++;
      setAttempt((n) => n + 1);
    }, PARTIAL_RETRY_MS);
    return () => clearTimeout(t);
  }, [report, loading]);

  const retry = useCallback(() => {
    setError(null);
    setAttempt((n) => n + 1);
  }, []);

  const filtered = Boolean(filters.agent || filters.profile || filters.project);
  const empty = report !== null && !report.totals.month.calls && !report.daily.some((d) => d.total.calls) && !report.partial;

  return (
    <section className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="on-page safe-top safe-x flex shrink-0 items-center bg-page">
        <div className="flex h-14 w-full min-w-0 items-center gap-1 px-1.5 sm:px-3 lg:h-[52px]">
          <button type="button" onClick={onMenu} aria-label="Open sessions" aria-haspopup="dialog" data-drawer-opener className="icon-btn lg:hidden">
            <Menu width={19} height={19} strokeWidth={1.8} />
          </button>
          <h1 className="min-w-0 flex-1 truncate px-1.5 text-md font-medium tracking-[-0.01em] text-ink sm:text-base">Usage</h1>
          {extra}
        </div>
      </header>
      <div className="safe-x safe-bottom min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex w-full max-w-[960px] flex-col gap-10 px-4 pt-2 pb-20 sm:px-6 md:pt-6">
          {report === null && !error && <p role="status" className="py-10 text-center text-sm text-ink-3">Loading usage…</p>}
          {error && (
            <EmptyState
              tone="error"
              icon={<WarningTriangle width={18} height={18} strokeWidth={1.8} />}
              title="Couldn't load usage"
              body={error}
              actions={[{ label: loading ? "Trying again…" : "Try again", onClick: retry, disabled: loading, primary: true }]}
            />
          )}
          {report && (empty && !filtered ? (
            <EmptyState
              className="py-16"
              icon={<StatsReport width={18} height={18} strokeWidth={1.8} />}
              title="No usage yet"
              body={`Tokens and estimated cost from your sessions in the last ${days} days show up here.`}
            />
          ) : (
            <Body report={report} days={days} setDays={setDays} by={by} setBy={setBy} filters={filters} setFilters={setFilters} onOpen={onOpen} loading={loading} />
          ))}
        </div>
      </div>
    </section>
  );
}

function Body({
  report,
  days,
  setDays,
  by,
  setBy,
  filters,
  setFilters,
  onOpen,
  loading,
}: {
  report: UsageReport;
  days: RangeDays;
  setDays: (d: RangeDays) => void;
  by: By;
  setBy: (b: By) => void;
  filters: Filters;
  setFilters: (f: Filters) => void;
  onOpen: (id: string) => void;
  loading: boolean;
}) {
  const { options } = report;
  const set = (k: keyof Filters) => (v: string) => setFilters({ ...filters, [k]: v });
  const filtered = Boolean(filters.agent || filters.profile || filters.project);
  const unpriced = report.totals.month.unpriced > 0 || report.models.some((m) => m.price === null);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
        <Segmented label="Range" value={days} options={RANGES.map((d) => ({ value: d, label: `${d} days` }))} onChange={setDays} />
        <div className="grid min-w-0 grid-cols-2 items-center gap-2 max-sm:w-full sm:flex sm:flex-wrap">
          <Select
            label="Agent"
            className="sm:w-40"
            value={filters.agent}
            onChange={set("agent")}
            options={[{ value: "", label: "All agents" }, ...options.agents.map((a) => ({ value: a, label: AGENT_LABEL[a] }))]}
          />
          {options.profiles.length > 1 && (
            <Select
              label="Profile"
              className="sm:w-44"
              value={filters.profile}
              onChange={set("profile")}
              options={[{ value: "", label: "All profiles" }, ...options.profiles.map((p) => ({ value: p.id, label: p.label }))]}
            />
          )}
          <Select
            label="Project"
            className="sm:w-48"
            value={filters.project}
            onChange={set("project")}
            options={[{ value: "", label: "All projects" }, ...options.projects.map((p) => ({ value: p.cwd, label: p.project, hint: p.cwd }))]}
          />
          {filtered && (
            <button type="button" onClick={() => setFilters({ agent: "", profile: "", project: "" })} className="tap relative h-8 rounded-full px-3 text-sm font-medium text-ink-2 hover:bg-hover hover:text-ink">
              Clear filters
            </button>
          )}
        </div>
        {(report.partial || loading) && (
          <p role="status" className="ml-auto text-xs text-ink-3">
            {report.partial ? "Still counting older sessions…" : "Updating…"}
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 divide-y divide-line rounded-xl border border-line sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <Total label="Today" sum={report.totals.today} />
        <Total label="Last 7 days" sum={report.totals.week} />
        <Total label="Last 30 days" sum={report.totals.month} />
      </div>

      <Chart daily={report.daily} by={by} setBy={setBy} />

      <div className="grid grid-cols-1 gap-10 lg:grid-cols-2 lg:gap-8">
        <Card title="Top sessions" aside={`Last ${days} days`}>
          {report.sessions.length ? (
            <table className="w-full table-fixed text-sm">
              <caption className="sr-only">Sessions that used the most in the last {days} days</caption>
              <thead className="text-left text-xs text-ink-3">
                <tr>
                  <th scope="col" className="pb-2 font-normal">Session</th>
                  <th scope="col" className="w-20 pb-1.5 text-right font-medium">Tokens</th>
                  <th scope="col" className="w-20 pb-1.5 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {report.sessions.map((s) => (
                  <tr key={s.key} className="border-t border-line">
                    <td className="py-2.5 pr-2">
                      <button type="button" onClick={() => onOpen(s.key)} className="group flex w-full min-w-0 flex-col rounded-[6px] text-left">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate font-medium text-ink group-hover:underline">{s.title}</span>
                        </span>
                        <span className="truncate text-xs text-ink-3">
                          {AGENT_LABEL[s.agent]} · {s.project} · {timeAgo(s.last)}
                        </span>
                      </button>
                    </td>
                    <td className="py-2.5 text-right text-ink-2 tabular-nums">{fmtTokens(tokSum(s.sum))}</td>
                    <td className="py-2.5 text-right text-ink tabular-nums">{s.sum.usd > 0 ? fmtUsd(s.sum.usd) : <span className="text-ink-3">No price</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="py-4 text-sm text-ink-3">No sessions match these filters.</p>
          )}
        </Card>
        <Card title="Top projects" aside={`Last ${days} days`}>
          {report.projects.length ? (
            <table className="w-full table-fixed text-sm">
              <caption className="sr-only">Projects that used the most in the last {days} days</caption>
              <thead className="text-left text-xs text-ink-3">
                <tr>
                  <th scope="col" className="pb-2 font-normal">Project</th>
                  <th scope="col" className="w-20 pb-1.5 text-right font-medium">Tokens</th>
                  <th scope="col" className="w-20 pb-1.5 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {report.projects.map((p) => (
                  <tr key={p.cwd || "none"} className="border-t border-line">
                    <td className="py-2.5 pr-2">
                      {p.cwd ? (
                        <button
                          type="button"
                          onClick={() => setFilters({ ...filters, project: filters.project === p.cwd ? "" : p.cwd })}
                          aria-pressed={filters.project === p.cwd}
                          className="group flex w-full min-w-0 flex-col rounded-[6px] text-left"
                          title={p.cwd}
                        >
                          <span className="truncate font-medium text-ink group-hover:underline">{p.project}</span>
                          <span className="truncate text-xs text-ink-3">{plural(p.sessions, "session")}</span>
                        </button>
                      ) : (
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate font-medium text-ink-2">{p.project}</span>
                          <span className="truncate text-xs text-ink-3">{plural(p.sessions, "session")}</span>
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 text-right text-ink-2 tabular-nums">{fmtTokens(tokSum(p.sum))}</td>
                    <td className="py-2.5 text-right text-ink tabular-nums">{p.sum.usd > 0 ? fmtUsd(p.sum.usd) : <span className="text-ink-3">No price</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="py-4 text-sm text-ink-3">No projects match these filters.</p>
          )}
        </Card>
      </div>

      {report.models.length > 0 && (
        <Card title="Models" aside={`Last ${days} days`}>
          <table className="w-full text-sm">
            <caption className="sr-only">Usage by model in the last {days} days</caption>
            <thead className="text-left text-xs text-ink-3">
              <tr>
                <th scope="col" className="pb-2 font-normal">Model</th>
                <th scope="col" className="pb-2 font-normal max-sm:hidden">Price</th>
                <th scope="col" className="w-20 pb-1.5 text-right font-medium">Tokens</th>
                <th scope="col" className="w-20 pb-1.5 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {report.models.map((m) => (
                <tr key={m.model} className="border-t border-line">
                  <td className="truncate py-2.5 pr-2 font-mono text-xs text-ink" translate="no">
                    {m.model}
                  </td>
                  <td className="py-2.5 pr-2 text-xs text-ink-3 max-sm:hidden">{m.price ?? "Unknown, tokens only"}</td>
                  <td className="py-2.5 text-right text-ink-2 tabular-nums">{fmtTokens(tokSum(m.sum))}</td>
                  <td className="py-2.5 text-right text-ink tabular-nums">{m.price ? fmtUsd(m.sum.usd) : <span className="text-ink-3">No price</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <p className="text-xs leading-relaxed text-ink-3">
        Costs are estimated from list prices per model and may differ from your bill or plan.
        {unpriced ? " Models without a known price show tokens only." : ""} Days follow this device&apos;s time zone ({report.tz}).
      </p>
    </>
  );
}

function Card({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="min-w-0">
      <div className="flex min-h-8 items-center gap-2 pb-3">
        <h2 className="text-md font-semibold tracking-[-0.01em] text-ink">{title}</h2>
        {aside && <span className="ml-auto text-sm text-ink-3">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

function Total({ label, sum }: { label: string; sum: Sum }) {
  const tokens = tokSum(sum);
  /* one row on a phone (label and tokens left, the figure right), a card above that */
  return (
    <section aria-label={label} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-3 sm:block sm:px-5 sm:py-4">
      <h2 className="text-sm text-ink-2">
        {label}
        {sum.usd > 0 && <span className="sr-only">, estimated</span>}
      </h2>
      <p className="row-span-2 text-right text-[20px] leading-tight font-semibold tracking-[-0.02em] text-ink tabular-nums sm:mt-1.5 sm:text-left sm:text-[28px]">{money(sum)}</p>
      <p className="mt-0.5 truncate text-xs text-ink-3 tabular-nums sm:mt-1">
        {fmtTokens(tokens)} tokens · {plural(sum.calls, "call")}
        {sum.unpriced > 0 && sum.usd > 0 ? ` · ${fmtTokens(sum.unpriced)} without a price` : ""}
      </p>
    </section>
  );
}

/* ── the chart ─────────────────────────────────────────────── */

const CHART_H = 180;
const AXIS_W = 44;
const LABEL_H = 20;

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

function Chart({ daily, by, setBy }: { daily: DayRow[]; by: By; setBy: (b: By) => void }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const unit: "usd" | "tokens" = daily.some((d) => d.total.usd > 0) ? "usd" : "tokens";
  const label = useCallback((id: string) => (by === "agent" ? (AGENT_LABEL[id as AgentId] ?? id) : id), [by]);
  const { series, other } = useMemo(() => chartSeries(daily, by, label), [daily, by, label]);
  const colors = series.map((s, i) => tokenVar(by === "agent" ? (AGENT_CHART_TOKEN[s.id as AgentId] ?? SERIES_TOKENS[i % SERIES_TOKENS.length]) : SERIES_TOKENS[i % SERIES_TOKENS.length]));
  if (other) colors.push(tokenVar(OTHER_TOKEN));
  const names = [...series.map((s) => s.label), ...(other ? ["Other"] : [])];
  const stacks = useMemo(() => daily.map((d) => dayStack(d, by, series, other, unit)), [daily, by, series, other, unit]);
  const totals = stacks.map((s) => s.reduce((a, b) => a + b, 0));
  const top = niceMax(Math.max(0, ...totals));
  const fmt = (v: number) => (unit === "usd" ? fmtUsd(v) : fmtTokens(v));
  const axis = (v: number) => (unit === "usd" ? (v >= 100 ? `$${Math.round(v)}` : `$${Number(v.toFixed(2))}`) : fmtTokens(v));
  const plotW = Math.max(0, width - AXIS_W);
  const step = daily.length ? plotW / daily.length : 0;
  const barW = Math.max(2, Math.min(28, step * 0.7));
  const labelEvery = Math.max(1, Math.ceil(56 / Math.max(1, step)));
  const busiest = totals.reduce((best, v, i) => (v > totals[best] ? i : best), 0);
  const sum = totals.reduce((a, b) => a + b, 0);
  const summary = daily.length
    ? `${unit === "usd" ? "Estimated cost" : "Tokens"} per day over the last ${daily.length} days, ${fmt(sum)} in total. Busiest day: ${longDay(daily[busiest].day)} with ${fmt(totals[busiest])}.`
    : "No days to show.";

  return (
    <Card
      title={unit === "usd" ? "Estimated cost per day" : "Tokens per day"}
      aside={
        <span className="flex items-center gap-2">
          <Segmented
            label="Stack by"
            value={by}
            options={[
              { value: "agent", label: "By agent" },
              { value: "model", label: "By model" },
            ]}
            onChange={setBy}
          />
        </span>
      }
    >
      <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
        {width > 0 && (
          <svg width={width} height={CHART_H + LABEL_H} role="img" aria-label={summary} className="block overflow-visible">
            {[0, 0.5, 1].map((f) => {
              const y = CHART_H - f * CHART_H + 0.5;
              return (
                <g key={f}>
                  <line x1={AXIS_W} x2={width} y1={y} y2={y} stroke="var(--line)" />
                  <text x={AXIS_W - 6} y={y + 4} textAnchor="end" className="fill-ink-3 text-2xs tabular-nums">
                    {axis(top * f)}
                  </text>
                </g>
              );
            })}
            {stacks.map((stack, i) => {
              const x = AXIS_W + i * step + (step - barW) / 2;
              let y = CHART_H;
              return (
                <g key={daily[i].day} opacity={hover === null || hover === i ? 1 : 0.55}>
                  {stack.map((v, j) => {
                    const h = (v / top) * CHART_H;
                    if (h <= 0) return null;
                    y -= h;
                    return <rect key={j} x={x} y={y} width={barW} height={Math.max(1, h)} rx={Math.min(2, barW / 4)} fill={colors[j]} />;
                  })}
                  {(daily.length - 1 - i) % labelEvery === 0 && (
                    <text x={x + barW / 2} y={CHART_H + 14} textAnchor="middle" className="fill-ink-3 text-2xs">
                      {shortDay(daily[i].day)}
                    </text>
                  )}
                  <rect x={AXIS_W + i * step} y={0} width={step} height={CHART_H} fill="transparent" onMouseEnter={() => setHover(i)} onClick={() => setHover(i)} />
                </g>
              );
            })}
          </svg>
        )}
        {hover !== null && daily[hover] && (
          <div
            aria-hidden
            className="pointer-events-none absolute top-0 z-10 w-max max-w-[240px] rounded-[10px] bg-[var(--tooltip-bg)] px-2.5 py-2 text-xs text-[var(--tooltip-fg)] shadow-overlay"
            style={{ left: Math.min(Math.max(0, AXIS_W + hover * step + step / 2 - 90), Math.max(0, width - 200)) }}
          >
            <p className="font-medium">{longDay(daily[hover].day)}</p>
            <p className="text-[var(--tooltip-muted)] tabular-nums">{fmt(totals[hover])}</p>
            {stacks[hover].map((v, j) =>
              v > 0 ? (
                <p key={j} className="flex items-center gap-1.5 tabular-nums">
                  <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: colors[j] }} />
                  <span className="min-w-0 flex-1 truncate">{names[j]}</span>
                  <span>{fmt(v)}</span>
                </p>
              ) : null,
            )}
          </div>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <ul className="flex min-w-0 flex-1 flex-wrap gap-x-3 gap-y-1" aria-label="Legend">
          {names.map((n, j) => (
            <li key={n} className="flex min-w-0 items-center gap-1.5 text-xs text-ink-2">
              <span aria-hidden className="size-2.5 shrink-0 rounded-[3px]" style={{ background: colors[j] }} />
              <span className="truncate" translate={by === "model" ? "no" : undefined}>
                {n}
              </span>
            </li>
          ))}
        </ul>
        <button type="button" aria-expanded={table} onClick={() => setTable((v) => !v)} className="tap relative h-7 rounded-full px-2.5 text-xs font-medium text-ink-2 hover:bg-hover hover:text-ink">
          {table ? "Hide table" : "Show as table"}
        </button>
      </div>
      <div className={table ? "mt-3 max-h-80 overflow-auto" : "sr-only"}>
        <table className="w-full text-sm">
          <caption className="sr-only">{summary}</caption>
          <thead className="text-left text-xs text-ink-3">
            <tr>
              <th scope="col" className="pb-2 font-normal">Day</th>
              {names.map((n) => (
                <th key={n} scope="col" className="pb-1.5 text-right font-medium max-sm:hidden">
                  {n}
                </th>
              ))}
              <th scope="col" className="pb-1.5 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {[...daily].reverse().map((d) => {
              const i = daily.indexOf(d);
              return (
                <tr key={d.day} className="border-t border-line">
                  <th scope="row" className="py-1 text-left font-normal text-ink-2">
                    {longDay(d.day)}
                  </th>
                  {stacks[i].map((v, j) => (
                    <td key={j} className="py-1 text-right text-ink-2 tabular-nums max-sm:hidden">
                      {v > 0 ? fmt(v) : "0"}
                    </td>
                  ))}
                  <td className="py-1 text-right text-ink tabular-nums">{fmt(totals[i])}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
