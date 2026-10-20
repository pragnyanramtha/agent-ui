"use client";

import { createContext, memo, startTransition, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { NavArrowDown, Page, Plus, Refresh } from "iconoir-react";
import { api, timeAgo } from "@/lib/client/api";
import type { PatchFile, PatchLine, PatchStatus } from "@/lib/client/diff";
import { CHUNK_ROWS, chunkRows, chunkText, diffRows, type DiffRow } from "@/lib/client/diff-chunks";
import { highlight, isPlainText } from "@/lib/client/highlight";
import { useSetting } from "@/lib/client/settings";
import { fileStartsOpen } from "@/lib/client/diff-prefs";
import { PathLabel } from "./PathLabel";
import { scrollBehavior } from "@/lib/client/motion";
import { composing } from "@/lib/keybindings";
import { bounds, covers, type LineRange } from "@/lib/client/line-range";
import { anchorRow, clampToHunk, commentLabel, linesIn, type DiffSide, type ReviewComment, type ReviewLine } from "@/lib/client/review";
import { addReview, editReview, removeReview, useReviewComments } from "@/lib/client/review-store";
import { CommentCard, CommentEditor } from "./DiffComments";
import { openFilePanel } from "./FileLink";
import "./diff.css";

/** "turn": the session's newest checkpoint against now, so what the last message changed */
export type DiffScope = "uncommitted" | "checkpoint" | "branch" | "turn";
type GitDiff = { scope: Exclude<DiffScope, "turn">; base: string; baseLabel: string; files: PatchFile[]; additions: number; deletions: number; truncated: boolean };
type CheckpointOption = { id: string; at: number; label: string };

const HATCH = "repeating-linear-gradient(45deg, var(--red) 0, var(--red) 1.5px, transparent 1.5px, transparent 3px)";
const SPLIT_MIN_WIDTH = 680;
const HIGHLIGHT_MAX_LINES = 3000;
const POLL_MS = 8000;
/* files whose first rows mount straight away, so the top of the diff never shows the plain stand-in */
const EAGER_FILES = 3;

/** The box the diff scrolls in (null: the page), for deciding which rows are near the screen. */
const ScrollRoot = createContext<Element | null | undefined>(undefined);

function scrollParent(el: Element | null): Element | null {
  for (let n = el?.parentElement; n; n = n.parentElement) {
    const o = getComputedStyle(n).overflowY;
    if (o === "auto" || o === "scroll") return n;
  }
  return null;
}

const STATUS: Record<PatchStatus, { letter: string; tone: string; label: string }> = {
  added: { letter: "A", tone: "text-(--add-ink)", label: "Added" },
  modified: { letter: "M", tone: "text-ink-3", label: "Modified" },
  deleted: { letter: "D", tone: "text-(--del-ink)", label: "Deleted" },
  renamed: { letter: "R", tone: "text-accent-ink", label: "Renamed" },
  binary: { letter: "B", tone: "text-ink-3", label: "Binary" },
};

const field =
  "h-9 min-w-0 rounded-full bg-field px-3 text-[16px] text-ink shadow-hairline outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40 sm:h-8 sm:text-sm";


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
  root: repoRoot,
}: {
  session: string;
  checkpoints?: CheckpointOption[];
  scope?: DiffScope;
  checkpoint?: string;
  busy?: boolean;
  /** bump to reload (after a commit or rewind, say) */
  refreshKey?: unknown;
  /** the repository's folder: lines take review comments, and files open in the Files panel */
  root?: string;
}) {
  const [scope, setScope] = useState<DiffScope>(initialScope);
  const [cp, setCp] = useState<string | undefined>(initialCheckpoint ?? (initialScope === "checkpoint" ? checkpoints[0]?.id : undefined));
  const [layout, setLayout] = useSetting("diffLayout");
  const [ws, setWs] = useSetting("diffIgnoreWhitespace");
  const [wrap, setWrap] = useSetting("diffWrap");
  const [fileState] = useSetting("diffFileState");
  const [data, setData] = useState<GitDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [wide, setWide] = useState(false);
  const [scroller, setScroller] = useState<Element | null | undefined>(undefined);
  const root = useRef<HTMLDivElement>(null);
  const fileRefs = useRef(new Map<string, HTMLElement>());
  const seq = useRef(0);
  /* the last response as text: a poll that brings the same diff keeps the old object, so nothing re-highlights */
  const lastText = useRef("");

  /* stored settings only exist after hydration; waiting a tick keeps the first request from ignoring them */
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  const latest = checkpoints[0];
  const checkpointId = scope === "checkpoint" ? cp : scope === "turn" ? latest?.id : undefined;
  const needsCheckpoint = scope === "checkpoint" || scope === "turn";

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    setScroller(scrollParent(el));
    const ro = new ResizeObserver(([e]) => {
      setWide(e.contentRect.width >= SPLIT_MIN_WIDTH);
      el.style.setProperty("--diff-w", `${Math.round(e.contentRect.width)}px`);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const load = useCallback(
    /* fresh: a new comparison, so the old one is cleared; refresh: same one, kept while it loads; background: silent */
    async (mode: "fresh" | "refresh" | "background" = "fresh") => {
      if (!ready) return;
      if (needsCheckpoint && !checkpointId) {
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
      const q = new URLSearchParams({ session, scope: scope === "turn" ? "checkpoint" : scope });
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
    [ready, session, scope, checkpointId, needsCheckpoint, ws],
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
  const isOpen = (f: PatchFile) => open[f.path] ?? fileStartsOpen(fileState, lineCount(f));
  const split = layout === "split" && wide;

  const jump = (path: string) => {
    setOpen((o) => ({ ...o, [path]: true }));
    requestAnimationFrame(() => fileRefs.current.get(path)?.scrollIntoView({ block: "start", behavior: scrollBehavior() }));
  };
  const allOpen = files.length > 0 && files.every(isOpen);
  const noneOpen = !files.some(isOpen);
  const setAll = (v: boolean) => setOpen(Object.fromEntries(files.map((f) => [f.path, v])));
  const toggleFile = useCallback((f: PatchFile) => setOpen((o) => ({ ...o, [f.path]: !(o[f.path] ?? fileStartsOpen(fileState, lineCount(f))) })), [fileState]);
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
          {(checkpoints.length > 0 || scope === "turn") && <option value="turn">Last turn</option>}
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
          onClick={() => setWs(!ws)}
          className={`h-8 shrink-0 rounded-full px-3 text-[12.5px] font-medium shadow-hairline transition-colors duration-150 sm:h-7 ${ws ? "bg-ink text-surface" : "text-ink-2 hover:bg-hover hover:text-ink"}`}
        >
          Hide whitespace
        </button>
        {/* split columns always wrap */}
        {!split && (
          <button
            type="button"
            aria-pressed={wrap}
            onClick={() => setWrap(!wrap)}
            title="Wrap long lines instead of scrolling sideways"
            className={`h-8 shrink-0 rounded-full px-3 text-[12.5px] font-medium shadow-hairline transition-colors duration-150 sm:h-7 ${wrap ? "bg-ink text-surface" : "text-ink-2 hover:bg-hover hover:text-ink"}`}
          >
            Wrap lines
          </button>
        )}
        {wide && (
          <Segmented
            label="Layout"
            value={layout}
            onChange={setLayout}
            options={[
              { value: "unified", label: "Unified" },
              { value: "split", label: "Split" },
            ]}
          />
        )}
        {files.length > 0 && (
          <span className="ml-auto flex shrink-0 items-center gap-3">
            <button type="button" onClick={() => setAll(true)} disabled={allOpen} className="text-[12.5px] font-medium text-ink-2 hover:text-ink disabled:text-ink-3 disabled:opacity-60">
              Expand all
            </button>
            <button type="button" onClick={() => setAll(false)} disabled={noneOpen} className="text-[12.5px] font-medium text-ink-2 hover:text-ink disabled:text-ink-3 disabled:opacity-60">
              Collapse all
            </button>
          </span>
        )}
      </div>

      {error && <p className="rounded-[10px] bg-red-tint px-3 py-2 text-[12.5px] text-red-ink">{error}</p>}
      {needsCheckpoint && !checkpoints.length && <p className="py-8 text-center text-sm text-ink-3">No checkpoints yet.</p>}
      {loading && !data && !error && <p className="py-8 text-center text-sm text-ink-3">Loading diff…</p>}
      {data && files.length === 0 && <p className="py-8 text-center text-sm text-ink-3">No changes.</p>}

      {data && files.length > 0 && (
        <>
          <div className="flex min-w-0 items-center gap-2 text-[12.5px] text-ink-3">
            <span className="tabular-nums">
              {files.length} {files.length === 1 ? "file" : "files"}
            </span>
            <span className="diff-tone font-mono text-xs tabular-nums">
              <span className="text-(--add-ink)">+{data.additions}</span> <span className="text-(--del-ink)">-{data.deletions}</span>
            </span>
            {scope === "turn" && latest && (
              <span className="min-w-0 truncate" title={latest.label}>
                vs before <span className="text-ink-2">{latest.label}</span>
              </span>
            )}
            {data.scope !== "checkpoint" && (
              <span className="min-w-0 truncate" title={data.base}>
                vs <span className="font-mono text-ink-2">{data.baseLabel}</span>
                {data.scope === "branch" && <span className="font-mono"> {data.base.slice(0, 7)}</span>}
              </span>
            )}
            {loading && <span className="ml-auto shrink-0">Updating…</span>}
          </div>
          {data.truncated && <p className="rounded-[10px] bg-inset px-3 py-2 text-[12.5px] text-ink-2 shadow-hairline">Some files are too large to show in full.</p>}

          <ul aria-label="Changed files" className="diff-tone max-h-48 overflow-y-auto rounded-[10px] bg-inset py-1 font-mono text-xs shadow-hairline">
            {files.map((f) => (
              <li key={f.path} className="relative">
                <button type="button" onClick={() => jump(f.path)} className={`flex w-full min-w-0 items-center gap-2 px-2.5 py-1 text-left hover:bg-hover ${repoRoot && f.status !== "deleted" ? "pr-9" : ""}`}>
                  <span className={`w-3 shrink-0 text-center font-semibold ${STATUS[f.status].tone}`} title={STATUS[f.status].label}>
                    {STATUS[f.status].letter}
                  </span>
                  <PathLabel path={f.path} className="flex-1" />
                  {f.binary || f.status === "binary" ? <span className="shrink-0 text-ink-3">binary</span> : <Counts f={f} />}
                </button>
                {repoRoot && f.status !== "deleted" && (
                  <button
                    type="button"
                    onClick={() => openFilePanel({ path: joinPath(repoRoot, f.path) })}
                    aria-label={`Show ${f.path} in Files`}
                    data-tip="Show in Files"
                    className="absolute inset-y-0 right-1 my-auto flex size-7 items-center justify-center rounded-[6px] text-ink-3 hover:bg-hover hover:text-ink"
                  >
                    <Page width={13} height={13} strokeWidth={1.8} aria-hidden />
                  </button>
                )}
              </li>
            ))}
          </ul>

          <ScrollRoot.Provider value={scroller}>
            <div className="flex flex-col gap-3">
              {files.map((f, i) => (
                <FileDiff key={f.path} file={f} open={isOpen(f)} eager={i < EAGER_FILES} split={split} wrap={wrap} onToggle={toggleFile} refCb={fileRef} session={session} root={repoRoot} />
              ))}
            </div>
          </ScrollRoot.Provider>
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
      {(f.additions > 0 || f.deletions === 0) && <span className="text-(--add-ink)">+{f.additions}</span>}
      {f.additions > 0 && f.deletions > 0 && " "}
      {f.deletions > 0 && <span className="text-(--del-ink)">-{f.deletions}</span>}
    </span>
  );
}

const joinPath = (root: string, rel: string) => `${root.replace(/\/+$/, "")}/${rel}`;

type Draft = { lines: ReviewLine[]; side: DiffSide };
const NO_EXTRAS = new Map<number, ReactNode>();

const FileDiff = memo(function FileDiff({
  file: f,
  open,
  eager,
  split,
  wrap,
  onToggle,
  refCb,
  session,
  root,
}: {
  file: PatchFile;
  open: boolean;
  eager: boolean;
  split: boolean;
  wrap: boolean;
  onToggle: (f: PatchFile) => void;
  refCb: (path: string, el: HTMLElement | null) => void;
  session: string;
  root?: string;
}) {
  const lines = lineCount(f);
  const plain = isPlainText(f.path) || lines > HIGHLIGHT_MAX_LINES;
  const widest = useMemo(() => Math.max(1, ...f.hunks.map((h) => Math.max(h.oldStart, h.newStart) + h.lines.length)), [f.hunks]);
  const num = `calc(${String(widest).length}ch + 14px)`;
  const rows = useMemo(() => (open ? diffRows(f, split) : []), [f, split, open]);
  const chunks = useMemo(() => chunkRows(rows), [rows]);
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

  /* ── review comments: only where the diff knows its repository ── */
  const reviewable = Boolean(root) && f.status !== "binary" && !f.binary;
  const all = useReviewComments(reviewable ? session : "");
  const comments = useMemo(() => (reviewable ? all.filter((c) => c.path === f.path) : []), [all, f.path, reviewable]);
  const [sel, setSel] = useState<{ range: LineRange; side: DiffSide } | null>(null);
  /* the lines a new comment is for, kept as text so a reload of the diff under it doesn't move it */
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const draftEmpty = useRef(true);
  const opener = useRef<HTMLElement | null>(null);
  const suppressClick = useRef(false);
  const section = useRef<HTMLElement | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const selRef = useRef(sel);
  selRef.current = sel;
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const placed = useMemo(() => {
    const at = new Map<number, ReviewComment[]>();
    const loose: ReviewComment[] = [];
    for (const c of comments) {
      const i = anchorRow(rows, c);
      if (i < 0) loose.push(c);
      else at.set(i, [...(at.get(i) ?? []), c]);
    }
    return { at, loose };
  }, [comments, rows]);

  const lineButton = (i: number, side: DiffSide) => section.current?.querySelector<HTMLElement>(`button[data-ln][data-row="${i}"][data-side="${side}"]`) ?? null;
  const backToLine = useCallback(() => {
    const el = opener.current;
    opener.current = null;
    if (el?.isConnected) el.focus({ preventScroll: true });
  }, []);
  const startDraft = (range: LineRange, side: DiffSide, from: HTMLElement | null) => {
    const [a, b] = bounds(range);
    const picked = linesIn(rowsRef.current, a, b, side);
    if (!picked.length) return;
    opener.current = lineButton(range.anchor, side) ?? from;
    draftEmpty.current = true;
    setEditing(null);
    setSel({ range, side });
    setDraft({ lines: picked, side });
  };
  const closeDraft = () => {
    setDraft(null);
    setSel(null);
    backToLine();
  };

  const target = (e: { target: EventTarget }) => {
    const el = (e.target as Element).closest?.("[data-ln]") as HTMLElement | null;
    return el ? { el, i: Number(el.dataset.row), side: el.dataset.side as DiffSide } : null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const t = target(e);
    if (!t || e.pointerType !== "mouse" || e.button !== 0) return;
    /* no text selection while picking lines */
    e.preventDefault();
    if (e.shiftKey) return;
    const anchor = t.i;
    setSel({ range: { anchor, head: anchor }, side: t.side });
    const move = (ev: PointerEvent) => {
      const row = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-row]");
      if (!row || !section.current?.contains(row)) return;
      const head = clampToHunk(rowsRef.current, anchor, Number(row.dataset.row));
      setSel((s) => (s && s.range.head !== head ? { ...s, range: { anchor, head } } : s));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false));
      const s = selRef.current;
      if (s) startDraft(s.range, s.side, t.el);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onClick = (e: React.MouseEvent) => {
    const t = target(e);
    if (!t) return;
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    const s = selRef.current;
    const same = s && s.side === t.side;
    /* on a phone, a tap on another line number while the new comment is still empty grows its range */
    const touchGrow = draftRef.current && draftEmpty.current && (e.nativeEvent as PointerEvent).pointerType && (e.nativeEvent as PointerEvent).pointerType !== "mouse";
    if (same && (e.shiftKey || touchGrow)) startDraft({ anchor: s.range.anchor, head: clampToHunk(rowsRef.current, s.range.anchor, t.i) }, t.side, t.el);
    else if (same && e.detail === 0 && covers(s.range, t.i)) startDraft(s.range, t.side, t.el);
    else startDraft({ anchor: t.i, head: t.i }, t.side, t.el);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const t = target(e);
    if (!t || t.el.tagName !== "BUTTON" || composing(e.nativeEvent)) return;
    if (e.key === "Escape" && selRef.current && !draftRef.current) {
      e.preventDefault();
      setSel(null);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const all = [...(section.current?.querySelectorAll<HTMLElement>(`button[data-ln][data-side="${t.side}"]`) ?? [])];
    const at = all.indexOf(t.el);
    let next = all[at + (e.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    if (e.shiftKey) {
      const s = selRef.current;
      const anchor = s && s.side === t.side && covers(s.range, t.i) ? s.range.anchor : t.i;
      const head = clampToHunk(rowsRef.current, anchor, Number(next.dataset.row));
      setSel({ range: { anchor, head }, side: t.side });
      next = lineButton(head, t.side) ?? next;
    } else if (!draftRef.current) setSel(null);
    t.el.tabIndex = -1;
    next.tabIndex = 0;
    next.focus();
  };

  const save = (body: string) => {
    if (!draft || !root) return;
    addReview(session, { file: joinPath(root, f.path), path: f.path, lines: draft.lines, body });
    closeDraft();
  };

  /* while a new comment is written, its lines stay marked where they are now */
  const marked = useMemo(() => {
    if (draft) {
      const a = anchorRow(rows, { lines: draft.lines.slice(0, 1) });
      const b = anchorRow(rows, draft);
      return a >= 0 && b >= 0 ? { from: a, to: b, side: draft.side, end: b } : null;
    }
    if (!sel) return null;
    const [from, to] = bounds(sel.range);
    return { from, to, side: sel.side, end: -1 };
  }, [draft, sel, rows]);

  const card = (c: ReviewComment) => {
    const label = commentLabel(f.path, c.lines);
    return editing === c.id ? (
      <CommentEditor
        key={c.id}
        label={label}
        initial={c.body}
        onSave={(body) => {
          editReview(session, c.id, body);
          setEditing(null);
          backToLine();
        }}
        onCancel={() => {
          setEditing(null);
          backToLine();
        }}
      />
    ) : (
      <CommentCard
        key={c.id}
        comment={c}
        label={label}
        onEdit={() => {
          opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          setDraft(null);
          setSel(null);
          setEditing(c.id);
        }}
        onDelete={() => {
          removeReview(session, c.id);
          const i = anchorRow(rowsRef.current, c);
          requestAnimationFrame(() => (i >= 0 ? lineButton(i, split ? (c.lines.at(-1)?.type === "del" ? "old" : "new") : "both") : section.current)?.focus({ preventScroll: true }));
        }}
      />
    );
  };

  const extras = useMemo(() => {
    if (!reviewable) return [];
    return chunks.map((rowsIn, k) => {
      const from = k * CHUNK_ROWS;
      const to = from + rowsIn.length - 1;
      const m = new Map<number, ReactNode>();
      for (const [i, list] of placed.at) if (i >= from && i <= to) m.set(i, list.map(card));
      if (draft && marked && marked.end >= from && marked.end <= to) {
        m.set(
          marked.end,
          <>
            {m.get(marked.end)}
            <CommentEditor
              key={`new-${marked.from}`}
              label={commentLabel(f.path, draft.lines)}
              onSave={save}
              onCancel={closeDraft}
              onEmpty={(empty) => (draftEmpty.current = empty)}
            />
          </>,
        );
      }
      return m.size ? m : NO_EXTRAS;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewable, chunks, placed, draft, marked, editing, f.path, split]);

  const firstLine = reviewable ? rows.findIndex((r) => r.kind !== "hunk") : -1;
  const count = comments.length;

  return (
    <section
      ref={(el) => {
        section.current = el;
        refCb(f.path, el);
      }}
      aria-label={f.path}
      className="diff-tone scroll-mt-2 rounded-card bg-surface shadow-card"
    >
      <button
        type="button"
        onClick={() => onToggle(f)}
        aria-expanded={open}
        className={`sticky top-0 z-[1] flex h-9 w-full min-w-0 items-center gap-2 border-line bg-surface px-3 text-left font-mono text-xs ${open ? "rounded-t-card border-b" : "rounded-card"}`}
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
        {count > 0 && <span className="shrink-0 font-sans text-2xs text-accent-ink">{count === 1 ? "1 comment" : `${count} comments`}</span>}
        {f.status !== "modified" && <span className={`shrink-0 font-sans text-2xs ${STATUS[f.status].tone}`}>{STATUS[f.status].label}</span>}
        <Counts f={f} />
      </button>
      {open && (
        <div className="rounded-b-card">
          {note && <p className="px-3 py-2.5 text-[12.5px] text-ink-3">{note}</p>}
          {placed.loose.length > 0 && (
            <div className="border-b border-line px-1 pt-1.5 pb-0.5">
              <p className="px-2 text-xs text-ink-3">{placed.loose.length === 1 ? "This comment's lines aren't in this diff." : "These comments' lines aren't in this diff."}</p>
              {placed.loose.map(card)}
            </div>
          )}
          {f.hunks.length > 0 && (
            <div
              tabIndex={0}
              translate="no"
              onPointerDown={reviewable ? onPointerDown : undefined}
              onClick={reviewable ? onClick : undefined}
              onKeyDown={reviewable ? onKeyDown : undefined}
              className="overflow-x-auto overscroll-x-contain pb-1 font-mono text-xs leading-[1.65] text-ink-2 focus-visible:[outline-offset:-2px]!"
            >
              <div className={`relative ${wrap && !split ? "" : "min-w-fit"}`}>
                {chunks.map((rowsIn, i) => {
                  const from = i * CHUNK_ROWS;
                  const hit = marked && marked.to >= from && marked.from < from + rowsIn.length;
                  return (
                    <Chunk
                      key={i}
                      rows={rowsIn}
                      offset={from}
                      eager={(eager && i === 0) || Boolean(hit)}
                      num={num}
                      plain={plain}
                      wrap={wrap}
                      split={split}
                      reviewable={reviewable}
                      selFrom={hit ? marked.from : -1}
                      selTo={hit ? marked.to : -1}
                      selSide={hit ? marked.side : "both"}
                      firstLine={firstLine}
                      extras={extras[i] ?? NO_EXTRAS}
                    />
                  );
                })}
              </div>
            </div>
          )}
          {f.truncated && f.hunks.length > 0 && <p className="border-t border-line px-3 py-2 text-xs text-ink-3">Diff cut off here.</p>}
        </div>
      )}
    </section>
  );
});

/**
 * A run of rows that mounts once it comes near the screen. Until then it is the rows' text in one block at the
 * same line height: roughly the same height, nothing to highlight, and still found by the browser's find.
 */
const Chunk = memo(function Chunk({
  rows,
  offset,
  eager,
  num,
  plain,
  wrap,
  split,
  reviewable,
  selFrom,
  selTo,
  selSide,
  firstLine,
  extras,
}: {
  rows: DiffRow[];
  offset: number;
  eager: boolean;
  num: string;
  plain: boolean;
  wrap: boolean;
  split: boolean;
  reviewable: boolean;
  selFrom: number;
  selTo: number;
  selSide: DiffSide;
  firstLine: number;
  extras: Map<number, ReactNode>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const root = useContext(ScrollRoot);
  const [shown, setShown] = useState(eager);
  useEffect(() => {
    if (eager) setShown(true);
  }, [eager]);
  useEffect(() => {
    const el = ref.current;
    if (shown || !el || root === undefined) return;
    const io = new IntersectionObserver(
      (seen) => {
        if (!seen.some((e) => e.isIntersecting)) return;
        io.disconnect();
        /* interruptible, so a fast scroll keeps its frames while rows highlight */
        startTransition(() => setShown(true));
      },
      { root, rootMargin: "800px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown, root]);

  if (!shown) {
    return (
      <div ref={ref} className={`pr-4 text-ink-3 ${wrap || split ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre"}`} style={{ paddingLeft: split ? 12 : `calc(${num} * 2 + 8px)` }}>
        {chunkText(rows)}
      </div>
    );
  }
  const on = (i: number, side: DiffSide) => i >= selFrom && i <= selTo && (side === selSide || selSide === "both");
  return (
    <div ref={ref}>
      {rows.map((r, k) => {
        const i = offset + k;
        const extra = extras.get(i);
        const row =
          r.kind === "hunk" ? (
            <div key={i} className="sticky left-0 truncate bg-inset px-3 py-0.5 text-2xs text-ink-3">
              {r.header}
            </div>
          ) : r.kind === "pair" ? (
            <div key={i} data-row={i} className="grid items-stretch" style={{ gridTemplateColumns: `${num} minmax(0,1fr) ${num} minmax(0,1fr)` }}>
              <Cell line={r.left} side="old" plain={plain} wrap row={reviewable ? i : -1} selected={on(i, "old")} first={i === firstLine} />
              <Cell line={r.right} side="new" plain={plain} wrap border row={reviewable ? i : -1} selected={on(i, "new")} first={i === firstLine && !r.left} />
            </div>
          ) : (
            <UnifiedRow key={i} line={r.line} num={num} plain={plain} wrap={wrap} row={reviewable ? i : -1} selected={on(i, "both")} first={i === firstLine} />
          );
        return extra ? (
          <div key={i}>
            {row}
            {extra}
          </div>
        ) : (
          row
        );
      })}
    </div>
  );
});

const tint = (t: PatchLine["type"]) => (t === "add" ? "bg-green-tint" : t === "del" ? "bg-red-tint" : "");
const numTone = (t: PatchLine["type"]) => (t === "add" ? "text-(--add-ink)" : t === "del" ? "text-(--del-ink)" : "text-ink-3");
const Bar = ({ type }: { type: PatchLine["type"] }) =>
  type === "ctx" ? null : <span aria-hidden className="absolute inset-y-0 left-0 w-[3px]" style={{ background: type === "add" ? "var(--green)" : HATCH }} />;
const NoEol = () => <span className="ml-2 select-none font-sans text-[10.5px] text-ink-3">no newline at end</span>;
const SELECTED = "bg-accent-tint!";

/** The "+" that starts a comment, over the edge of a line number; the number itself takes taps on a phone. */
function CommentButton({ row, side, no, first }: { row: number; side: DiffSide; no: number | undefined; first: boolean }) {
  return (
    <button
      type="button"
      data-ln=""
      data-row={row}
      data-side={side}
      tabIndex={first ? 0 : -1}
      aria-label={`Comment on line ${no ?? ""}`}
      className="absolute top-px -right-2 z-[1] flex size-[18px] items-center justify-center rounded-[5px] bg-accent text-white opacity-0 shadow-btn transition-opacity duration-100 group-hover/ln:opacity-100 focus-visible:opacity-100 pointer-coarse:hidden"
    >
      <Plus width={12} height={12} strokeWidth={2.6} aria-hidden />
    </button>
  );
}

const UnifiedRow = memo(function UnifiedRow({ line: l, num, plain, wrap, row, selected, first }: { line: PatchLine; num: string; plain: boolean; wrap: boolean; row: number; selected: boolean; first: boolean }) {
  const review = row >= 0;
  const ln = review ? { "data-ln": "", "data-row": row, "data-side": "both" } : {};
  return (
    <div data-row={review ? row : undefined} className={`group/ln relative grid items-start ${tint(l.type)} ${selected ? SELECTED : ""}`} style={{ gridTemplateColumns: `${num} ${num} minmax(0,1fr)` }}>
      <Bar type={l.type} />
      <span {...ln} className={`select-none pr-1.5 text-right text-2xs tabular-nums ${numTone(l.type)} ${review ? "cursor-pointer" : ""}`}>
        {l.oldNo ?? ""}
      </span>
      <span {...ln} className={`relative select-none pr-1.5 text-right text-2xs tabular-nums ${numTone(l.type)} ${review ? "cursor-pointer" : ""}`}>
        {l.newNo ?? ""}
        {review && <CommentButton row={row} side="both" no={l.newNo ?? l.oldNo} first={first} />}
      </span>
      <code className={`pr-4 pl-2 ${wrap ? "min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre"}`}>
        {plain ? l.text : highlight(l.text)}
        {l.noEol && <NoEol />}
      </code>
    </div>
  );
});

function Cell({ line: l, side, plain, wrap, border, row = -1, selected = false, first = false }: { line: PatchLine | null; side: "old" | "new"; plain: boolean; wrap?: boolean; border?: boolean; row?: number; selected?: boolean; first?: boolean }) {
  const edge = border ? "border-l border-line" : "";
  if (!l) return <span aria-hidden className={`col-span-2 bg-inset/60 ${edge}`} />;
  const no = side === "old" ? l.oldNo : l.newNo;
  const review = row >= 0;
  return (
    <>
      <span
        {...(review ? { "data-ln": "", "data-row": row, "data-side": side } : {})}
        className={`group/ln relative select-none pr-1.5 text-right text-2xs tabular-nums ${tint(l.type)} ${numTone(l.type)} ${edge} ${selected ? SELECTED : ""} ${review ? "cursor-pointer" : ""}`}
      >
        <Bar type={l.type} />
        {no ?? ""}
        {review && <CommentButton row={row} side={side} no={no} first={first} />}
      </span>
      <code className={`min-w-0 pr-3 pl-2 ${wrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre"} ${tint(l.type)} ${selected ? SELECTED : ""}`}>
        {plain ? l.text : highlight(l.text)}
        {l.noEol && <NoEol />}
      </code>
    </>
  );
}
