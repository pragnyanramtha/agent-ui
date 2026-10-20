/* Usage across sessions, shared by the server route and the Usage screen (no React, no I/O).
 *
 * The server keeps each session's usage in 15-minute UTC slots per model (small, and every time zone's day boundary
 * falls on one, India's half hours and Nepal's quarter hours included), then buckets those slots into days in the
 * reader's time zone when a request comes in. */

import { costOf, priceFor, type Tokens } from "@/lib/client/usage";
import type { AgentId } from "@/lib/types";

export const SLOT_MS = 15 * 60_000;
/** the widest range the screen offers; older usage is never read */
export const MAX_DAYS = 90;
export const RANGES = [7, 30, 90] as const;
export type RangeDays = (typeof RANGES)[number];

export type Tok = Tokens & { calls: number };
/** "<slot index>\t<model>" -> tokens */
export type Slots = Map<string, Tok>;

export type SessionUsage = {
  key: string;
  agent: AgentId;
  cwd: string;
  /** the profile the session last ran on (the agent's own when none was picked) */
  profile: string;
  slots: Slots;
  /** newest usage, epoch ms */
  last: number;
};

export const zeroTok = (): Tok => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 });
export const tokSum = (t: Tokens) => t.input + t.cacheRead + t.cacheWrite + t.output;

function addTo(into: Tok, t: Tokens, calls: number, sign = 1) {
  into.input += sign * t.input;
  into.cacheRead += sign * t.cacheRead;
  into.cacheWrite += sign * t.cacheWrite;
  into.output += sign * t.output;
  into.calls += sign * calls;
}

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** Adds one API call to a session's slots; `sign` -1 takes back an earlier one (a record written again with final counts). */
export function addCall(slots: Slots, ts: number, model: string, t: Partial<Tokens>, sign = 1): string | null {
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const clean = { input: n(t.input), cacheRead: n(t.cacheRead), cacheWrite: n(t.cacheWrite), output: n(t.output) };
  const key = `${Math.floor(ts / SLOT_MS)}\t${model || ""}`;
  const cur = slots.get(key) ?? zeroTok();
  addTo(cur, clean, 1, sign);
  if (cur.calls <= 0) slots.delete(key);
  else slots.set(key, cur);
  return key;
}

/* ── days in a time zone ───────────────────────────────────── */

const formatters = new Map<string, Intl.DateTimeFormat>();

/** A valid IANA zone name, else UTC. */
export function safeZone(tz: unknown): string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return "UTC";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/** "2026-10-19": the calendar day `ms` falls on in `tz`. */
export function dayKey(ms: number, tz: string): string {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    formatters.set(tz, f);
  }
  const parts = f.formatToParts(ms);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** The `count` calendar days ending with the one `now` falls on in `tz`, oldest first. */
export function lastDays(now: number, tz: string, count: number): string[] {
  const [y, m, d] = dayKey(now, tz).split("-").map(Number);
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) out.push(new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10));
  return out;
}

/* ── the report ────────────────────────────────────────────── */

/** Tokens and the estimate; `unpriced` counts tokens of models with no known price (left out of `usd`). */
export type Sum = Tok & { usd: number; unpriced: number };
export const zeroSum = (): Sum => ({ ...zeroTok(), usd: 0, unpriced: 0 });

export type DayRow = { day: string; total: Sum; byAgent: Record<string, Sum>; byModel: Record<string, Sum> };
export type SessionRow = { key: string; agent: AgentId; title: string; project: string; cwd: string; profile: string; last: number; sum: Sum };
export type ProjectRow = { project: string; cwd: string; sessions: number; sum: Sum };
export type ModelRow = { model: string; price: string | null; sum: Sum };

export type UsageFilters = { agent?: string | null; profile?: string | null; project?: string | null };

export type UsageReport = {
  tz: string;
  now: number;
  days: number;
  totals: { today: Sum; week: Sum; month: Sum };
  daily: DayRow[];
  sessions: SessionRow[];
  projects: ProjectRow[];
  models: ModelRow[];
  /** what the filters can pick from: everything seen in the widest range, ignoring the filters themselves */
  options: { agents: AgentId[]; profiles: { id: string; label: string }[]; projects: { cwd: string; project: string }[] };
  /** some sessions weren't read yet (the time budget ran out); asking again continues where it stopped */
  partial: boolean;
  pending: number;
};

export const projectName = (cwd: string) => cwd.replace(/\/+$/, "").split("/").pop() || cwd || "No folder";

type PriceInfo = { label: string | null; rate: ReturnType<typeof priceFor> | null };
const priceCache = new Map<string, PriceInfo>();
/** The list price of a model, or null when it isn't known: unknown models show tokens only. */
export function modelPrice(model: string): PriceInfo {
  let hit = priceCache.get(model);
  if (!hit) {
    const p = priceFor(model);
    hit = p.fallback || !model ? { label: null, rate: null } : { label: p.label, rate: p };
    priceCache.set(model, hit);
  }
  return hit;
}

function addSum(into: Sum, t: Tok, model: string) {
  addTo(into, t, t.calls);
  const { rate } = modelPrice(model);
  if (rate) into.usd += costOf(t, rate);
  else into.unpriced += tokSum(t);
}

export const matches = (s: SessionUsage, f: UsageFilters) => (!f.agent || s.agent === f.agent) && (!f.profile || s.profile === f.profile) && (!f.project || s.cwd === f.project);

export type ReportInput = {
  sessions: Iterable<SessionUsage>;
  now: number;
  tz: string;
  days: number;
  filters?: UsageFilters;
  /** display names for sessions in the top list (only called for those) */
  titleOf?: (s: SessionUsage) => string;
  profileLabel?: (id: string) => string;
  /** sessions the user deleted: still counted, never listed */
  hidden?: (key: string) => boolean;
  top?: number;
  partial?: boolean;
  pending?: number;
};

const bySpend = (a: { sum: Sum }, b: { sum: Sum }) => b.sum.usd - a.sum.usd || tokSum(b.sum) - tokSum(a.sum);

export function buildReport(input: ReportInput): UsageReport {
  const tz = safeZone(input.tz);
  const days = Math.max(1, Math.min(MAX_DAYS, Math.round(input.days) || 30));
  const filters = input.filters ?? {};
  const top = input.top ?? 10;
  const window = lastDays(input.now, tz, Math.max(days, 30));
  const today = window[window.length - 1];
  const weekFrom = window[window.length - 7];
  const monthFrom = window[window.length - 30];
  const rangeFrom = window[window.length - days];
  const optionsFrom = lastDays(input.now, tz, MAX_DAYS)[0];
  /* a cheap cut before any day is worked out: no zone is more than a day from UTC */
  const earliest = Date.parse(`${optionsFrom}T00:00:00Z`) - 86_400_000;

  const daily = new Map<string, DayRow>(window.slice(-days).map((day) => [day, { day, total: zeroSum(), byAgent: {}, byModel: {} }]));
  const totals = { today: zeroSum(), week: zeroSum(), month: zeroSum() };
  const models = new Map<string, Sum>();
  const projects = new Map<string, ProjectRow>();
  const rows: { s: SessionUsage; sum: Sum }[] = [];
  const agents = new Set<AgentId>();
  const profiles = new Set<string>();
  const optProjects = new Map<string, number>();
  /* every session shares the same slots, so each slot's day is worked out once */
  const dayOfSlot = new Map<number, string>();
  const dayOf = (slot: number) => {
    let d = dayOfSlot.get(slot);
    if (d === undefined) {
      d = dayKey(slot * SLOT_MS, tz);
      dayOfSlot.set(slot, d);
    }
    return d;
  };

  for (const s of input.sessions) {
    if (s.last < earliest) continue;
    const pass = matches(s, filters);
    const sum = zeroSum();
    let seen = false;
    for (const [k, t] of s.slots) {
      const tab = k.indexOf("\t");
      const slot = Number(k.slice(0, tab));
      if (slot * SLOT_MS < earliest) continue;
      const day = dayOf(slot);
      if (day < optionsFrom || day > today) continue;
      seen = true;
      if (!pass) continue;
      const model = k.slice(tab + 1);
      if (day >= monthFrom) {
        addSum(totals.month, t, model);
        if (day >= weekFrom) addSum(totals.week, t, model);
        if (day === today) addSum(totals.today, t, model);
      }
      if (day < rangeFrom) continue;
      addSum(sum, t, model);
      const row = daily.get(day);
      if (row) {
        addSum(row.total, t, model);
        addSum((row.byAgent[s.agent] ??= zeroSum()), t, model);
        addSum((row.byModel[model || "unknown"] ??= zeroSum()), t, model);
      }
      let m = models.get(model);
      if (!m) models.set(model, (m = zeroSum()));
      addSum(m, t, model);
    }
    if (seen) {
      agents.add(s.agent);
      profiles.add(s.profile);
      if (s.cwd) optProjects.set(s.cwd, Math.max(optProjects.get(s.cwd) ?? 0, s.last));
    }
    if (!pass || !sum.calls) continue;
    rows.push({ s, sum });
    const pk = s.cwd || "";
    const p = projects.get(pk) ?? { project: s.cwd ? projectName(s.cwd) : "No folder", cwd: s.cwd, sessions: 0, sum: zeroSum() };
    p.sessions++;
    for (const k of Object.keys(sum) as (keyof Sum)[]) p.sum[k] += sum[k];
    projects.set(pk, p);
  }

  rows.sort(bySpend);
  const listed = rows.filter((r) => !input.hidden?.(r.s.key)).slice(0, top);
  return {
    tz,
    now: input.now,
    days,
    totals,
    daily: [...daily.values()],
    sessions: listed.map(({ s, sum }) => ({ key: s.key, agent: s.agent, title: input.titleOf?.(s) || "Untitled session", project: s.cwd ? projectName(s.cwd) : "No folder", cwd: s.cwd, profile: s.profile, last: s.last, sum })),
    projects: [...projects.values()].sort(bySpend).slice(0, top),
    models: [...models].map(([model, sum]) => ({ model: model || "unknown", price: modelPrice(model).label, sum })).sort(bySpend),
    options: {
      agents: [...agents].sort(),
      profiles: [...profiles].sort().map((id) => ({ id, label: input.profileLabel?.(id) ?? id })),
      projects: [...optProjects].sort((a, b) => b[1] - a[1]).map(([cwd]) => ({ cwd, project: projectName(cwd) })),
    },
    partial: Boolean(input.partial),
    pending: input.pending ?? 0,
  };
}

/* ── the chart ─────────────────────────────────────────────── */

export type Series = { id: string; label: string; total: number };

/** The stacks to draw: the biggest `max - 1` groups by estimate (tokens where nothing is priced), the rest as Other. */
export function chartSeries(daily: DayRow[], by: "agent" | "model", label: (id: string) => string, max = 6): { series: Series[]; other: boolean } {
  const totals = new Map<string, { usd: number; tokens: number }>();
  for (const d of daily)
    for (const [id, s] of Object.entries(by === "agent" ? d.byAgent : d.byModel)) {
      const t = totals.get(id) ?? { usd: 0, tokens: 0 };
      t.usd += s.usd;
      t.tokens += tokSum(s);
      totals.set(id, t);
    }
  const priced = [...totals.values()].some((t) => t.usd > 0);
  const ranked = [...totals].sort((a, b) => (priced ? b[1].usd - a[1].usd : 0) || b[1].tokens - a[1].tokens);
  const keep = ranked.length > max ? ranked.slice(0, max - 1) : ranked;
  const series = keep.map(([id, t]) => ({ id, label: label(id), total: priced ? t.usd : t.tokens }));
  return { series, other: ranked.length > keep.length };
}

/** One day's stack heights in the chart's unit, in series order, with Other last when there is one. */
export function dayStack(d: DayRow, by: "agent" | "model", series: Series[], other: boolean, unit: "usd" | "tokens"): number[] {
  const groups = by === "agent" ? d.byAgent : d.byModel;
  const val = (s: Sum | undefined) => (s ? (unit === "usd" ? s.usd : tokSum(s)) : 0);
  const out = series.map((s) => val(groups[s.id]));
  if (other) {
    const ids = new Set(series.map((s) => s.id));
    out.push(Object.entries(groups).reduce((acc, [id, s]) => acc + (ids.has(id) ? 0 : val(s)), 0));
  }
  return out;
}

/** A round top for the y axis: 1, 2 or 5 times a power of ten, at least `max`. */
export function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 5, 10]) if (m * p >= max) return m * p;
  return 10 * p;
}
