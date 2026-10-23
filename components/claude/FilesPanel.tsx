"use client";

import { memo, startTransition, useEffect, useMemo, useRef, useState } from "react";
import { AtSign, Copy, Download, Folder, NavArrowLeft, NavArrowUp, OpenNewWindow, Page, Search, Xmark } from "iconoir-react";
import { api, ApiError, timeAgo } from "@/lib/client/api";
import { OPEN_FILES_EVENT } from "@/lib/client/events";
import { modalOpen } from "@/lib/client/shortcuts";
import { composing } from "@/lib/keybindings";
import { useReturnFocus } from "@/lib/client/a11y";
import { highlight, isPlainText } from "@/lib/client/highlight";
import { scrollBehavior } from "@/lib/client/motion";
import { formatBytes } from "@/lib/client/upload";
import { sendToComposer } from "@/lib/client/composer-insert";
import { mentionToken } from "@/lib/client/file-refs";
import { relToRoot } from "@/lib/client/review";
import { bounds, covers, pick, rangeText, step, type LineRange } from "@/lib/client/line-range";
import { toast } from "@/lib/client/toast";
import { EmptyState } from "@/components/primitives/EmptyState";
import { copyText } from "./CodeCard";
import { Markdown } from "./Markdown";
import { FileRoot } from "./FileLink";

/* The session folder beside the conversation: browse it, read a file with its line numbers, pick lines and mention
 * them in the next message. Reads go through /api/files like the Files screen. */

export type FileTarget = { path: string; line?: number; endLine?: number; n: number };

type Item = { name: string; path: string; type: "dir" | "file" | "broken"; link: boolean; size: number; mtime: number };
type Listing = { kind: "dir"; path: string; parent: string | null; entries: Item[]; truncated: boolean; hiddenCount: number };
type FileInfo = { kind: "file"; path: string; parent: string | null; size: number; mtime: number; mime: string; text: boolean };

const raw = (p: string, download = false) => `/api/files/raw?path=${encodeURIComponent(p)}${download ? "&download=1" : ""}`;
const READ_BYTES = 1024 * 1024;
const CHUNK = 200;
const OFFLINE = "Couldn't reach the server.";
const failText = (err: unknown) => (err instanceof ApiError ? err.message : OFFLINE);
const nameOf = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;
const parentOf = (p: string) => p.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/";
const inside = (p: string, root: string) => p === root || p.startsWith(`${root.replace(/\/+$/, "")}/`);
const wide = () => window.matchMedia("(min-width: 1024px)").matches;
const ICON = "icon-btn disabled:opacity-40";

export function FilesPanel({ root, target, onClose, onQuickOpen }: { root: string; target: FileTarget | null; onClose: () => void; onQuickOpen: () => void }) {
  const ref = useRef<HTMLElement>(null);
  useReturnFocus(ref);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && !modalOpen() && closeRef.current();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const [dir, setDir] = useState(root);
  const [shown, setShown] = useState<FileTarget | null>(target);
  useEffect(() => setShown(target), [target]);
  useEffect(() => setDir(root), [root]);
  const listRef = useRef<HTMLDivElement>(null);

  const back = () => {
    if (shown && inside(shown.path, root)) setDir(parentOf(shown.path));
    setShown(null);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>("button[data-entry]")?.focus({ preventScroll: true }));
  };

  return (
    <aside
      ref={ref}
      tabIndex={-1}
      aria-label="Files"
      className="absolute inset-0 z-20 flex flex-col bg-page outline-none lg:static lg:inset-auto lg:w-[440px] lg:shrink-0 lg:border-l lg:border-line xl:w-[520px]"
      style={{ animation: "fade-up 220ms cubic-bezier(0.23,1,0.32,1) both" }}
    >
      <div className="safe-top flex shrink-0 items-center gap-1 border-b border-line px-3 sm:px-4">
        <div className="flex h-14 min-w-0 flex-1 items-center gap-2">
          <span className="text-base font-semibold text-ink">Files</span>
          <span className="min-w-0 truncate font-mono text-xs text-ink-3" title={root} translate="no">
            {nameOf(root)}
          </span>
        </div>
        <button type="button" onClick={onQuickOpen} aria-label="Go to file" data-tip="Go to file" data-tip-pos="bottom" className={ICON}>
          <Search width={16} height={16} strokeWidth={1.8} />
        </button>
        <button type="button" onClick={onClose} aria-label="Close files" className="tap relative flex size-9 items-center justify-center rounded-[9px] text-ink-3 hover:bg-hover hover:text-ink">
          <Xmark width={16} height={16} strokeWidth={2} />
        </button>
      </div>
      {shown ? (
        <Viewer key={shown.path} root={root} target={shown} onBack={back} onClose={onClose} onFolder={(p) => (setDir(p), setShown(null))} />
      ) : (
        <div ref={listRef} className="flex min-h-0 flex-1 flex-col">
          <Browser root={root} dir={dir} onDir={setDir} onOpen={(path) => setShown({ path, n: Date.now() })} />
        </div>
      )}
    </aside>
  );
}

/* ── the folder list ──────────────────────────────────────── */

function Browser({ root, dir, onDir, onOpen }: { root: string; dir: string; onDir: (p: string) => void; onOpen: (p: string) => void }) {
  const [data, setData] = useState<Listing | { error: string } | null>(null);
  useEffect(() => {
    let gone = false;
    setData(null);
    api<Listing | FileInfo>(`/api/files?path=${encodeURIComponent(dir)}`)
      .then((d) => {
        if (gone) return;
        if (d.kind === "dir") setData(d);
        else onOpen(d.path);
      })
      .catch((err) => !gone && setData({ error: failText(err) }));
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir]);

  const atRoot = dir.replace(/\/+$/, "") === root.replace(/\/+$/, "") || !inside(dir, root);
  const where = relToRoot(dir, root);
  return (
    <>
      <div className="flex h-10 shrink-0 items-center gap-1 px-2 sm:px-3">
        <button type="button" onClick={() => onDir(parentOf(dir))} disabled={atRoot} aria-label="Up one folder" data-tip="Up one folder" className={ICON}>
          <NavArrowUp width={16} height={16} strokeWidth={1.8} />
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-3" title={dir} translate="no">
          {where === dir ? nameOf(dir) : `${nameOf(root)}/${where}`}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-4 sm:px-3">
        {data === null ? (
          <p role="status" className="px-2 py-6 text-sm text-ink-3">
            Loading files…
          </p>
        ) : "error" in data ? (
          <EmptyState size="inline" tone="error" title="Couldn't open this folder" body={data.error} actions={[{ label: "Go to the session folder", onClick: () => onDir(root) }]} />
        ) : data.entries.length === 0 ? (
          <EmptyState size="inline" icon={<Folder width={16} height={16} strokeWidth={1.8} />} title="Empty folder" body={data.hiddenCount ? `Only hidden files here (${data.hiddenCount}).` : "Nothing in here yet."} />
        ) : (
          <ul aria-label={`Files in ${nameOf(dir)}`}>
            {data.entries.map((it) => (
              <li key={it.path}>
                <button
                  type="button"
                  data-entry
                  disabled={it.type === "broken"}
                  onClick={() => (it.type === "dir" ? onDir(it.path) : onOpen(it.path))}
                  className="flex h-9 w-full min-w-0 items-center gap-2 rounded-[8px] px-2 text-left text-sm text-ink-2 transition-colors duration-100 hover:bg-hover hover:text-ink disabled:opacity-50 pointer-coarse:h-11"
                >
                  {it.type === "dir" ? (
                    <Folder width={15} height={15} strokeWidth={1.8} className="shrink-0 text-ink-2" aria-hidden />
                  ) : (
                    <Page width={15} height={15} strokeWidth={1.8} className="shrink-0 text-ink-3" aria-hidden />
                  )}
                  <span className="min-w-0 flex-1 truncate" translate="no">
                    {it.name}
                  </span>
                  {it.type === "file" && <span className="shrink-0 text-2xs text-ink-3 tabular-nums">{formatBytes(it.size)}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        {data && !("error" in data) && data.truncated && <p className="px-2 pt-2 text-xs text-ink-3">Only the first part of this folder is listed.</p>}
      </div>
    </>
  );
}

/* ── one file ─────────────────────────────────────────────── */

type Text = { text: string; partial: boolean } | { error: string } | null;

function Viewer({ root, target, onBack, onClose, onFolder }: { root: string; target: FileTarget; onBack: () => void; onClose: () => void; onFolder: (p: string) => void }) {
  const [info, setInfo] = useState<FileInfo | { error: string } | null>(null);
  const [text, setText] = useState<Text>(null);
  const [source, setSource] = useState(Boolean(target.line));
  const [range, setRange] = useState<LineRange | null>(target.line ? { anchor: target.line, head: target.endLine ?? target.line } : null);
  const path = target.path;

  useEffect(() => {
    setRange(target.line ? { anchor: target.line, head: target.endLine ?? target.line } : null);
    if (target.line) setSource(true);
  }, [target]);

  useEffect(() => {
    let gone = false;
    setInfo(null);
    api<FileInfo | Listing>(`/api/files?path=${encodeURIComponent(path)}`)
      .then((d) => {
        if (gone) return;
        if (d.kind === "dir") onFolder(d.path);
        else setInfo(d);
      })
      .catch((err) => !gone && setInfo({ error: failText(err) }));
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const file = info && !("error" in info) ? info : null;
  const name = nameOf(path);
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const kind = !file
    ? null
    : file.mime.startsWith("image/") && file.mime !== "image/svg+xml"
      ? "image"
      : ext === "md" || ext === "markdown"
        ? "markdown"
        : file.text || file.mime.startsWith("text/") || file.mime === "application/json" || file.mime === "image/svg+xml"
          ? "text"
          : "binary";

  useEffect(() => {
    setText(null);
    if (!file || (kind !== "text" && kind !== "markdown")) return;
    const ctl = new AbortController();
    fetch(raw(file.path), { headers: { Range: `bytes=0-${READ_BYTES - 1}` }, signal: ctl.signal, cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
        setText({ text: await r.text(), partial: file.size > READ_BYTES });
      })
      .catch((err) => !ctl.signal.aborted && setText({ error: err instanceof Error ? err.message : "Couldn't load the file." }));
    return () => ctl.abort();
  }, [file, kind]);

  const rel = relToRoot(path, root);
  const sel = range ? bounds(range) : null;
  const lineView = kind === "text" || (kind === "markdown" && source);
  const mention = () => {
    const ok = sendToComposer(mentionToken(rel, lineView && sel ? sel[0] : undefined, lineView && sel ? sel[1] : undefined), true);
    if (!ok) toast({ title: "Open a conversation to mention files.", key: "mention" });
    else if (!wide()) onClose();
  };
  const mentionLabel = lineView && sel ? `Mention ${sel[0] === sel[1] ? "line" : "lines"} ${rangeText(sel[0], sel[1])} in message` : "Mention in message";

  const body = (() => {
    if (info === null) return <p role="status" className="px-3 py-6 text-sm text-ink-3">Loading file…</p>;
    if ("error" in info) return <EmptyState size="inline" tone="error" title="Couldn't open this file" body={info.error} actions={[{ label: "Back to files", onClick: onBack }]} />;
    if (kind === "image")
      return (
        <div className="px-3 py-3">
          <img src={`${raw(info.path)}&v=${info.mtime}`} alt={name} className="mx-auto max-w-full rounded-[8px] object-contain shadow-hairline" />
        </div>
      );
    if (kind === "binary")
      return (
        <div className="flex flex-col items-center gap-3 px-3 py-10 text-center">
          <p className="text-sm text-ink-3">No preview for this kind of file.</p>
          <a href={raw(info.path, true)} download={name} className="tap relative inline-flex h-9 items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-medium text-page">
            <Download width={15} height={15} aria-hidden /> Download {formatBytes(info.size)}
          </a>
        </div>
      );
    if (text === null) return <p role="status" className="px-3 py-6 text-sm text-ink-3">Loading file…</p>;
    if ("error" in text) return <p className="px-3 py-6 text-sm text-red-ink">{text.error}</p>;
    if (kind === "markdown" && !source)
      return (
        <div className="px-3 py-3">
          <FileRoot.Provider value={parentOf(path)}>
            <Markdown text={text.text} />
          </FileRoot.Provider>
        </div>
      );
    return <Lines text={text.text} plain={isPlainText(name)} range={range} onRange={setRange} jump={target.line ? target : null} label={name} />;
  })();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-0.5 px-1.5 py-1 sm:px-2.5">
        <button type="button" onClick={onBack} aria-label="Back to files" data-tip="Back to files" className={ICON}>
          <NavArrowLeft width={18} height={18} strokeWidth={1.8} />
        </button>
        <div className="flex min-w-0 flex-1 flex-col px-1">
          <span className="truncate text-sm font-medium text-ink" title={path} translate="no">
            {rel}
          </span>
          <span className="truncate text-2xs text-ink-3">
            {file ? `${formatBytes(file.size)} · ${timeAgo(file.mtime)}` : " "}
            {text && "partial" in text && text.partial ? ` · first ${formatBytes(READ_BYTES)} shown` : ""}
          </span>
        </div>
        {kind === "markdown" && (
          <button type="button" onClick={() => setSource((s) => !s)} aria-pressed={source} className="h-8 shrink-0 rounded-full px-2.5 text-sm font-medium text-ink-2 hover:bg-hover">
            {source ? "Rendered" : "Source"}
          </button>
        )}
        <button type="button" onClick={mention} aria-label={mentionLabel} data-tip="Mention in message" className={ICON}>
          <AtSign width={16} height={16} strokeWidth={1.8} />
        </button>
        <button type="button" onClick={() => void copyText(path).then((ok) => ok && toast({ title: "Path copied.", key: "copy-path" }))} aria-label="Copy path" data-tip="Copy path" className={`${ICON} max-sm:hidden`}>
          <Copy width={16} height={16} strokeWidth={1.8} />
        </button>
        <a href={raw(path, true)} download={name} aria-label="Download" data-tip="Download" className={`${ICON} max-sm:hidden`}>
          <Download width={16} height={16} strokeWidth={1.8} />
        </a>
        <button type="button" onClick={() => window.dispatchEvent(new CustomEvent(OPEN_FILES_EVENT, { detail: { path } }))} aria-label="Open in the Files screen" data-tip="Open in the Files screen" className={ICON}>
          <OpenNewWindow width={16} height={16} strokeWidth={1.8} />
        </button>
      </div>
      <div className="relative min-h-0 flex-1">{body}</div>
      {lineView && sel && (
        <div className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-2 sm:px-4" style={{ animation: "fade-up 160ms cubic-bezier(0.23,1,0.32,1) both" }}>
          <p className="min-w-0 flex-1 truncate text-xs text-ink-3">
            {sel[0] === sel[1] ? `Line ${sel[0]}` : `Lines ${rangeText(sel[0], sel[1])}`}
            <span className="pointer-fine:hidden">{sel[0] === sel[1] ? ". Tap another line for a range." : ""}</span>
          </p>
          <button type="button" onClick={() => setRange(null)} className="h-8 shrink-0 rounded-full px-2.5 text-sm font-medium text-ink-2 hover:bg-hover">
            Clear
          </button>
          <button type="button" onClick={mention} className="tap relative h-8 shrink-0 rounded-full bg-ink px-3 text-sm font-medium text-surface">
            Mention in message
          </button>
        </div>
      )}
    </div>
  );
}

/* ── lines with numbers to pick ───────────────────────────── */

function Lines({ text, plain, range, onRange, jump, label }: { text: string; plain: boolean; range: LineRange | null; onRange: (r: LineRange | null) => void; jump: FileTarget | null; label: string }) {
  const lines = useMemo(() => {
    const all = text.split("\n");
    if (all.length > 1 && all[all.length - 1] === "") all.pop();
    return all;
  }, [text]);
  const total = lines.length;
  const width = `calc(${String(total).length}ch + 18px)`;
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [focusLine, setFocusLine] = useState(jump?.line ?? 1);
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const suppress = useRef(false);
  const sel = range ? bounds(range) : null;

  const lineButton = (n: number) => scroller.current?.querySelector<HTMLElement>(`button[data-line="${n}"]`) ?? null;

  /* the target line: in view and focused once its rows are on the page */
  useEffect(() => {
    if (!jump?.line) return;
    const n = Math.min(jump.line, total);
    setFocusLine(n);
    const frame = requestAnimationFrame(() => {
      const el = lineButton(n);
      el?.closest("[data-row]")?.scrollIntoView({ block: "center", behavior: "auto" });
    });
    return () => cancelAnimationFrame(frame);
  }, [jump, total]);

  const focusTo = (n: number) => {
    setFocusLine(n);
    requestAnimationFrame(() => {
      const el = lineButton(n);
      el?.focus({ preventScroll: true });
      el?.closest("[data-row]")?.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });
    });
  };

  const lineOf = (t: EventTarget | null) => {
    const el = (t as Element | null)?.closest?.("[data-line]") as HTMLElement | null;
    return el ? Number(el.dataset.line) : 0;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const n = lineOf(e.target);
    if (!n || e.pointerType !== "mouse" || e.button !== 0) return;
    e.preventDefault();
    const start = pick(rangeRef.current, n, e.shiftKey);
    onRange(start);
    setFocusLine(n);
    const move = (ev: PointerEvent) => {
      const row = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-row]");
      if (!row || !scroller.current?.contains(row)) return;
      const head = Number(row.dataset.row);
      if (head) onRange({ anchor: start.anchor, head });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      suppress.current = true;
      setTimeout(() => (suppress.current = false));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onClick = (e: React.MouseEvent) => {
    const n = lineOf(e.target);
    if (!n) return;
    if (suppress.current) {
      suppress.current = false;
      return;
    }
    const r = rangeRef.current;
    setFocusLine(n);
    /* a keyboard press (detail 0) follows Shift; a tap grows a picked line into a range, and a tap on the only picked line drops it */
    if (e.detail === 0) return onRange(pick(r, n, e.shiftKey));
    if (r && r.anchor === r.head && r.anchor === n) return onRange(null);
    onRange(pick(r, n, Boolean(r)));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const n = lineOf(e.target);
    if (!n || composing(e.nativeEvent)) return;
    if (e.key === "Escape" && rangeRef.current) {
      e.preventDefault();
      onRange(null);
      return;
    }
    const delta = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : e.key === "PageDown" ? 20 : e.key === "PageUp" ? -20 : 0;
    if (!delta) return;
    e.preventDefault();
    const { range: next, to } = step(rangeRef.current, n, delta, e.shiftKey, 1, total);
    if (e.shiftKey) onRange(next);
    focusTo(to);
  };

  const chunks = useMemo(() => {
    const out: string[][] = [];
    for (let i = 0; i < lines.length; i += CHUNK) out.push(lines.slice(i, i + CHUNK));
    return out;
  }, [lines]);

  return (
    <div
      ref={(el) => {
        scroller.current = el;
        setScrollEl(el);
      }}
      role="group"
      aria-label={`${label}, ${total} ${total === 1 ? "line" : "lines"}`}
      onPointerDown={onPointerDown}
      onClick={onClick}
      onKeyDown={onKeyDown}
      translate="no"
      className="absolute inset-0 overflow-y-auto overscroll-contain bg-surface py-2 font-mono text-xs leading-[1.65] text-ink-2"
    >
      {scrollEl &&
        chunks.map((c, k) => {
          const from = k * CHUNK + 1;
          const to = from + c.length - 1;
          const hit = (focusLine >= from && focusLine <= to) || (sel && sel[0] <= to && sel[1] >= from) || (jump?.line && jump.line >= from && jump.line <= to);
          return (
            <LineChunk
              key={k}
              lines={c}
              from={from}
              eager={k === 0 || Boolean(hit)}
              width={width}
              plain={plain}
              selFrom={sel && sel[0] <= to && sel[1] >= from ? sel[0] : 0}
              selTo={sel && sel[0] <= to && sel[1] >= from ? sel[1] : 0}
              focusLine={focusLine >= from && focusLine <= to ? focusLine : 0}
              scroller={scrollEl}
            />
          );
        })}
    </div>
  );
}

const LineChunk = memo(function LineChunk({
  lines,
  from,
  eager,
  width,
  plain,
  selFrom,
  selTo,
  focusLine,
  scroller,
}: {
  lines: string[];
  from: number;
  eager: boolean;
  width: string;
  plain: boolean;
  selFrom: number;
  selTo: number;
  focusLine: number;
  scroller: Element;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(eager);
  useEffect(() => {
    if (eager) setShown(true);
  }, [eager]);
  useEffect(() => {
    const el = ref.current;
    if (shown || !el) return;
    const io = new IntersectionObserver(
      (seen) => {
        if (!seen.some((e) => e.isIntersecting)) return;
        io.disconnect();
        startTransition(() => setShown(true));
      },
      { root: scroller, rootMargin: "800px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown, scroller]);

  if (!shown)
    return (
      <div ref={ref} className="whitespace-pre-wrap pr-4 text-ink-3 [overflow-wrap:anywhere]" style={{ paddingLeft: `calc(${width} + 8px)` }}>
        {lines.join("\n")}
      </div>
    );
  return (
    <div ref={ref}>
      {lines.map((line, k) => {
        const n = from + k;
        const on = covers(selFrom ? { anchor: selFrom, head: selTo } : null, n);
        return (
          <div key={n} data-row={n} className={`grid items-start ${on ? "bg-accent-tint" : ""}`} style={{ gridTemplateColumns: `${width} minmax(0,1fr)` }}>
            <button
              type="button"
              data-line={n}
              tabIndex={n === focusLine ? 0 : -1}
              aria-label={`Line ${n}`}
              aria-pressed={on}
              className={`cursor-pointer select-none rounded-[3px] pr-2 text-right text-2xs tabular-nums hover:text-ink focus-visible:[outline-offset:-2px]! ${on ? "text-accent-ink" : "text-ink-3"}`}
            >
              {n}
            </button>
            <code className="min-w-0 whitespace-pre-wrap pr-4 pl-2 [overflow-wrap:anywhere]">{line ? (plain ? line : highlight(line)) : " "}</code>
          </div>
        );
      })}
    </div>
  );
});
