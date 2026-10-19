"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavArrowDown, Refresh } from "iconoir-react";
import { api, timeAgo } from "@/lib/client/api";
import { splitRows, type PatchFile, type PatchLine, type PatchStatus } from "@/lib/client/diff";
import { highlight, isPlainText } from "@/lib/client/highlight";
import { PathLabel } from "./PathLabel";

export type DiffScope = "uncommitted" | "checkpoint" | "branch";
type GitDiff = { scope: DiffScope; base: string; baseLabel: string; files: PatchFile[]; additions: number; deletions: number; truncated: boolean };
type CheckpointOption = { id: string; at: number; label: string };

const HATCH = "repeating-linear-gradient(45deg, var(--red) 0, var(--red) 1.5px, transparent 1.5px, transparent 3px)";
const SPLIT_MIN_WIDTH = 680;
const BIG_FILE_LINES = 400;
const HIGHLIGHT_MAX_LINES = 3000;
const POLL_MS = 8000;
const PREFS = "agent-u:diff";

const STATUS: Record<PatchStatus, { letter: string; tone: string; label: string }> = {
  added: { letter: "A", tone: "text-green", label: "Added" },
  modified: { letter: "M", tone: "text-ink-3", label: "Modified" },
  deleted: { letter: "D", tone: "text-red", label: "Deleted" },
  renamed: { letter: "R", tone: "text-accent-ink", label: "Renamed" },
  binary: { letter: "B", tone: "text-ink-3", label: "Binary" },
};

const field =
  "h-9 min-w-0 rounded-full bg-field px-3 text-[16px] text-ink shadow-hairline outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40 sm:h-8 sm:text-[13px]";

type Prefs = { ws: boolean; split: boolean };
const readPrefs = (): Prefs => {
  try {
    return { ws: false, split: false, ...(JSON.parse(localStorage.getItem(PREFS) ?? "{}") as Partial<Prefs>) };
  } catch {
    return { ws: false, split: false };
  }
};

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex shrink-0 rounded-full bg-inset p-0.5 shadow-hairline">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`h-8 rounded-full px-3 text-[12.5px] font-medium transition-colors duration-150 sm:h-7 ${value === o.value ? "bg-surface text-ink shadow-btn" : "text-ink-3 hover:text-ink"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A git diff of the session folder: uncommitted work, changes since a checkpoint, or the branch against its base.
 * `scope` and `checkpoint` only set where it starts; remount (key) to point it somewhere else. */
export function DiffView({
  session,
  checkpoints = [],
  scope: initialScope = "uncommitted",
  checkpoint: initialCheckpoint,
  busy = false,
  refreshKey,
}: {
  session: string;
  checkpoints?: CheckpointOption[];
  scope?: DiffScope;
  checkpoint?: string;
  busy?: boolean;
  /** bump to reload (after a commit or rewind, say) */
  refreshKey?: unknown;
}) {
  const [scope, setScope] = useState<DiffScope>(initialScope);
  const [cp, setCp] = useState<string | undefined>(initialCheckpoint ?? (initialScope === "checkpoint" ? checkpoints[0]?.id : undefined));
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [data, setData] = useState<GitDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [wide, setWide] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const fileRefs = useRef(new Map<string, HTMLElement>());
  const seq = useRef(0);
  /* the last response as text: a poll that brings the same diff keeps the old object, so nothing re-highlights */
  const lastText = useRef("");

  useEffect(() => setPrefs(readPrefs()), []);
  const ready = prefs !== null;
  const ws = prefs?.ws ?? false;
  const savePrefs = (p: Partial<Prefs>) =>
    setPrefs((cur) => {
      const next = { ws: false, split: false, ...cur, ...p };
      try {
        localStorage.setItem(PREFS, JSON.stringify(next));
      } catch {}
      return next;
    });

  const checkpointId = scope === "checkpoint" ? cp : undefined;

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWide(e.contentRect.width >= SPLIT_MIN_WIDTH));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const load = useCallback(
    /* fresh: a new comparison, so the old one is cleared; refresh: same one, kept while it loads; background: silent */
    async (mode: "fresh" | "refresh" | "background" = "fresh") => {
      if (!ready) return;
      if (scope === "checkpoint" && !checkpointId) {
        lastText.current = "";
        setData(null);
        setLoading(false);
        return;
      }
      const n = ++seq.current;
      if (mode !== "background") setLoading(true);
      if (mode === "fresh") {
        lastText.current = "";
        setData(null);
      }
      const q = new URLSearchParams({ session, scope });
      if (checkpointId) q.set("checkpoint", checkpointId);
      if (ws) q.set("ws", "1");
      try {
        const d = await api<GitDiff>(`/api/git/diff?${q}`);
        if (n !== seq.current) return;
        const text = JSON.stringify(d);
        if (text !== lastText.current) {
          lastText.current = text;
          setData(d);
        }
        setError(null);
      } catch (err) {
        if (n !== seq.current) return;
        setError(err instanceof Error ? err.message : String(err));
        if (mode !== "background") {
          lastText.current = "";
          setData(null);
        }
      } finally {
        if (n === seq.current) setLoading(false);
      }
    },
    [ready, session, scope, checkpointId, ws],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    void load("refresh");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, busy]);

  /* the agent is writing files: keep the diff roughly live */
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => document.visibilityState === "visible" && void load("background"), POLL_MS);
    return () => clearInterval(t);
  }, [busy, load]);

  const files = data?.files ?? [];
  const isOpen = (f: PatchFile) => open[f.path] ?? lineCount(f) <= BIG_FILE_LINES;
  const split = Boolean(prefs?.split) && wide;

  const jump = (path: string) => {
    setOpen((o) => ({ ...o, [path]: true }));
    requestAnimationFrame(() => fileRefs.current.get(path)?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };
  const allOpen = files.length > 0 && files.every(isOpen);
  const toggleAll = () => setOpen(Object.fromEntries(files.map((f) => [f.path, !allOpen])));
  const toggleFile = useCallback((f: PatchFile) => setOpen((o) => ({ ...o, [f.path]: !(o[f.path] ?? lineCount(f) <= BIG_FILE_LINES) })), []);
  const fileRef = useCallback((path: string, el: HTMLElement | null) => {
    if (el) fileRefs.current.set(path, el);
    else fileRefs.current.delete(path);
  }, []);

  return (
    <div ref={root} className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={scope}
          onChange={(e) => {
            const next = e.target.value as DiffScope;
            if (next === "checkpoint" && !cp) setCp(checkpoints[0]?.id);
            setScope(next);
          }} aria-label="Compare" className={field}>
          <option value="uncommitted">Uncommitted</option>
          <option value="checkpoint" disabled={!checkpoints.length}>
            Since checkpoint
          </option>
          <option value="branch">Branch vs base</option>
        </select>
        {scope === "checkpoint" && checkpoints.length > 0 && (
          <select value={checkpointId} onChange={(e) => setCp(e.target.value)} aria-label="Checkpoint" className={`${field} max-w-[16rem] flex-1`}>
            {checkpoints.map((c) => (
              <option key={c.id} value={c.id}>
                {timeAgo(c.at)} · {c.label}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          onClick={() => void load("refresh")}
          disabled={loading}
          aria-label="Reload diff"
          title="Reload"
          className="tap relative ml-auto flex size-9 shrink-0 items-center justify-center rounded-full text-ink-3 hover:bg-hover hover:text-ink disabled:opacity-40 sm:size-8"
        >
          <Refresh width={15} height={15} strokeWidth={2} />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-pressed={ws}
          onClick={() => savePrefs({ ws: !ws })}
          className={`h-8 shrink-0 rounded-full px-3 text-[12.5px] font-medium shadow-hairline transition-colors duration-150 sm:h-7 ${ws ? "bg-ink text-surface" : "text-ink-2 hover:bg-hover hover:text-ink"}`}
        >
          Hide whitespace
        </button>
        {wide && (
          <Segmented
            label="Layout"
            value={prefs?.split ? "split" : "unified"}
            onChange={(v) => savePrefs({ split: v === "split" })}
            options={[
              { value: "unified", label: "Unified" },
              { value: "split", label: "Split" },
            ]}
          />
        )}
        {files.length > 1 && (
          <button type="button" onClick={toggleAll} className="ml-auto shrink-0 text-[12.5px] font-medium text-ink-2 hover:text-ink">
            {allOpen ? "Collapse all" : "Expand all"}
          </button>
        )}
      </div>

      {error && <p className="rounded-[10px] bg-red-tint px-3 py-2 text-[12.5px] text-red-ink">{error}</p>}
      {scope === "checkpoint" && !checkpoints.length && <p className="py-8 text-center text-[13px] text-ink-3">No checkpoints yet.</p>}
      {loading && !data && !error && <p className="py-8 text-center text-[13px] text-ink-3">Loading diff…</p>}
      {data && files.length === 0 && <p className="py-8 text-center text-[13px] text-ink-3">No changes.</p>}

      {data && files.length > 0 && (
        <>
          <div className="flex min-w-0 items-center gap-2 text-[12.5px] text-ink-3">
            <span className="tabular-nums">
              {files.length} {files.length === 1 ? "file" : "files"}
            </span>
            <span className="font-mono text-[12px] tabular-nums">
              <span className="text-green">+{data.additions}</span> <span className="text-red">-{data.deletions}</span>
            </span>
            {data.scope !== "checkpoint" && (
              <span className="min-w-0 truncate" title={data.base}>
                vs <span className="font-mono text-ink-2">{data.baseLabel}</span>
                {data.scope === "branch" && <span className="font-mono"> {data.base.slice(0, 7)}</span>}
              </span>
            )}
            {loading && <span className="ml-auto shrink-0">Updating…</span>}
          </div>
          {data.truncated && <p className="rounded-[10px] bg-inset px-3 py-2 text-[12.5px] text-ink-2 shadow-hairline">Some files are too large to show in full.</p>}

          <ul aria-label="Changed files" className="max-h-48 overflow-y-auto rounded-[10px] bg-inset py-1 font-mono text-[12px] shadow-hairline">
            {files.map((f) => (
              <li key={f.path}>
                <button type="button" onClick={() => jump(f.path)} className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1 text-left hover:bg-hover">
                  <span className={`w-3 shrink-0 text-center font-semibold ${STATUS[f.status].tone}`} title={STATUS[f.status].label}>
                    {STATUS[f.status].letter}
                  </span>
                  <PathLabel path={f.path} className="flex-1" />
                  {f.binary || f.status === "binary" ? <span className="shrink-0 text-ink-3">binary</span> : <Counts f={f} />}
                </button>
              </li>
            ))}
          </ul>

          <div className="flex flex-col gap-3">
            {files.map((f) => (
              <FileDiff
                key={f.path}
                file={f}
                open={isOpen(f)}
                split={split}
                onToggle={toggleFile}
                refCb={fileRef}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const lineCount = (f: PatchFile) => f.hunks.reduce((n, h) => n + h.lines.length, 0);

function Counts({ f }: { f: PatchFile }) {
  if (f.binary || f.status === "binary") return null;
  return (
    <span className="shrink-0 tabular-nums">
      {(f.additions > 0 || f.deletions === 0) && <span className="text-green">+{f.additions}</span>}
      {f.additions > 0 && f.deletions > 0 && " "}
      {f.deletions > 0 && <span className="text-red">-{f.deletions}</span>}
    </span>
  );
}

const FileDiff = memo(function FileDiff({
  file: f,
  open,
  split,
  onToggle,
  refCb,
}: {
  file: PatchFile;
  open: boolean;
  split: boolean;
  onToggle: (f: PatchFile) => void;
  refCb: (path: string, el: HTMLElement | null) => void;
}) {
  const lines = lineCount(f);
  const plain = isPlainText(f.path) || lines > HIGHLIGHT_MAX_LINES;
  const widest = useMemo(() => Math.max(1, ...f.hunks.map((h) => Math.max(h.oldStart, h.newStart) + h.lines.length)), [f.hunks]);
  const num = `calc(${String(widest).length}ch + 14px)`;
  const note =
    f.binary || f.status === "binary"
      ? "Binary file."
      : f.truncated && !f.hunks.length
        ? "Too large to show."
        : !f.hunks.length && f.modeChange
          ? `Mode changed from ${f.modeChange.from} to ${f.modeChange.to}.`
          : !f.hunks.length && f.status === "renamed"
            ? "Renamed without changes."
            : !f.hunks.length
              ? "No content changes."
              : null;

  return (
    <section ref={(el) => refCb(f.path, el)} aria-label={f.path} className="scroll-mt-2 rounded-card bg-surface shadow-card">
      <button
        type="button"
        onClick={() => onToggle(f)}
        aria-expanded={open}
        className={`sticky top-0 z-[1] flex h-9 w-full min-w-0 items-center gap-2 border-line bg-surface px-3 text-left font-mono text-[12px] ${open ? "rounded-t-card border-b" : "rounded-card"}`}
      >
        <NavArrowDown width={12} height={12} strokeWidth={2.4} className={`shrink-0 text-ink-3 transition-transform duration-200 ${open ? "" : "-rotate-90"}`} />
        {f.oldPath && (
          <>
            <span className="min-w-0 max-w-[40%] shrink truncate text-ink-3" title={f.oldPath}>
              {f.oldPath}
            </span>
            <span className="shrink-0 text-ink-3">to</span>
          </>
        )}
        <PathLabel path={f.path} className="flex-1" />
        {f.status !== "modified" && <span className={`shrink-0 font-sans text-[11px] ${STATUS[f.status].tone}`}>{STATUS[f.status].label}</span>}
        <Counts f={f} />
      </button>
      {open && (
        <div className="rounded-b-card">
          {note && <p className="px-3 py-2.5 text-[12.5px] text-ink-3">{note}</p>}
          {f.hunks.length > 0 && (
            <div tabIndex={0} translate="no" className="overflow-x-auto overscroll-x-contain pb-1 font-mono text-[12px] leading-[1.65] text-ink-2 focus-visible:[outline-offset:-2px]!">
              <div className="relative min-w-fit">
                {f.hunks.map((h, hi) => (
                  <div key={hi}>
                    <div className="sticky left-0 truncate bg-inset px-3 py-0.5 text-[11px] text-ink-3">{h.header}</div>
                    {split
                      ? splitRows(h.lines).map((r, i) => (
                          <div key={i} className="grid items-stretch" style={{ gridTemplateColumns: `${num} minmax(0,1fr) ${num} minmax(0,1fr)` }}>
                            <Cell line={r.left} side="old" plain={plain} wrap />
                            <Cell line={r.right} side="new" plain={plain} wrap border />
                          </div>
                        ))
                      : h.lines.map((l, i) => <UnifiedRow key={i} line={l} num={num} plain={plain} />)}
                  </div>
                ))}
              </div>
            </div>
          )}
          {f.truncated && f.hunks.length > 0 && <p className="border-t border-line px-3 py-2 text-[12px] text-ink-3">Diff cut off here.</p>}
        </div>
      )}
    </section>
  );
});

const tint = (t: PatchLine["type"]) => (t === "add" ? "bg-green-tint" : t === "del" ? "bg-red-tint" : "");
const numTone = (t: PatchLine["type"]) => (t === "add" ? "text-green" : t === "del" ? "text-red" : "text-ink-3");
const Bar = ({ type }: { type: PatchLine["type"] }) =>
  type === "ctx" ? null : <span aria-hidden className="absolute inset-y-0 left-0 w-[3px]" style={{ background: type === "add" ? "var(--green)" : HATCH }} />;
const NoEol = () => <span className="ml-2 select-none font-sans text-[10.5px] text-ink-3">no newline at end</span>;

function UnifiedRow({ line: l, num, plain }: { line: PatchLine; num: string; plain: boolean }) {
  return (
    <div className={`relative grid items-start ${tint(l.type)}`} style={{ gridTemplateColumns: `${num} ${num} minmax(0,1fr)` }}>
      <Bar type={l.type} />
      <span className={`select-none pr-1.5 text-right text-[11px] tabular-nums ${numTone(l.type)}`}>{l.oldNo ?? ""}</span>
      <span className={`select-none pr-1.5 text-right text-[11px] tabular-nums ${numTone(l.type)}`}>{l.newNo ?? ""}</span>
      <code className="pr-4 pl-2 whitespace-pre">
        {plain ? l.text : highlight(l.text)}
        {l.noEol && <NoEol />}
      </code>
    </div>
  );
}

function Cell({ line: l, side, plain, wrap, border }: { line: PatchLine | null; side: "old" | "new"; plain: boolean; wrap?: boolean; border?: boolean }) {
  const edge = border ? "border-l border-line" : "";
  if (!l) return <span aria-hidden className={`col-span-2 bg-inset/60 ${edge}`} />;
  const no = side === "old" ? l.oldNo : l.newNo;
  return (
    <>
      <span className={`relative select-none pr-1.5 text-right text-[11px] tabular-nums ${tint(l.type)} ${numTone(l.type)} ${edge}`}>
        <Bar type={l.type} />
        {no ?? ""}
      </span>
      <code className={`min-w-0 pr-3 pl-2 ${wrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre"} ${tint(l.type)}`}>
        {plain ? l.text : highlight(l.text)}
        {l.noEol && <NoEol />}
      </code>
    </>
  );
}
