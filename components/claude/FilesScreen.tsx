"use client";

import { confirmAsk, promptAsk } from "./Ask";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Copy, Download, EditPencil, Eye, EyeClosed, Folder, FolderPlus, Menu, MoreHoriz, NavArrowLeft, NavArrowUp, OpenNewWindow, Page, Refresh, Trash, Upload, Xmark } from "iconoir-react";
import { api, ApiError, shortPath, timeAgo } from "@/lib/client/api";
import { withPreviewCsp } from "@/lib/client/html-preview";
import { formatBytes, uploadFile } from "@/lib/client/upload";
import { CodeCard, copyText } from "./CodeCard";
import { Markdown } from "./Markdown";

/* Files on the server: browse, preview artifacts (images, media, markdown, HTML, code), edit text,
 * and move files both ways. Works the same on a phone: the preview takes the screen there. */

export { OPEN_FILES_EVENT } from "@/lib/client/events";

type Item = { name: string; path: string; type: "dir" | "file" | "broken"; link: boolean; size: number; mtime: number };
type Listing = { kind: "dir"; path: string; parent: string | null; home: string; entries: Item[]; truncated: boolean; hiddenCount: number };
type FileInfo = { kind: "file"; path: string; parent: string | null; size: number; mtime: number; mime: string; text: boolean };
type Upload = { id: string; name: string; sent: number; total: number; state: "sending" | "retrying" | "done" | "failed"; error?: string };

const PATH_KEY = "cui:filesPath";
const raw = (p: string, download = false) => `/api/files/raw?path=${encodeURIComponent(p)}${download ? "&download=1" : ""}`;
const PREVIEW_BYTES = 1024 * 1024;
const iconBtn = "icon-btn disabled:opacity-40";

export function FilesScreen({ onMenu, extra, start, startKey }: { onMenu: () => void; extra?: ReactNode; start?: string | null; startKey?: number }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [file, setFile] = useState<FileInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [drag, setDrag] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [menuUp, setMenuUp] = useState(false);
  const [typed, setTyped] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const reqRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const open = useCallback(
    async (target?: string, opts: { hidden?: boolean } = {}) => {
      const n = ++reqRef.current;
      setLoading(true);
      const q = new URLSearchParams();
      if (target) q.set("path", target);
      if (opts.hidden ?? hidden) q.set("hidden", "1");
      try {
        const d = await api<Listing | FileInfo>(`/api/files?${q}`);
        if (n !== reqRef.current) return;
        setError(null);
        if (d.kind === "file") {
          setFile(d);
          if (d.parent && d.parent !== listing?.path) void open(d.parent, opts);
          return;
        }
        setListing(d);
        localStorage.setItem(PATH_KEY, d.path);
      } catch (err) {
        if (n === reqRef.current) setError(err instanceof ApiError ? err.message : "Couldn't reach the server.");
      } finally {
        if (n === reqRef.current) setLoading(false);
      }
    },
    [hidden, listing?.path],
  );

  useEffect(() => {
    void open(start || localStorage.getItem(PATH_KEY) || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, startKey]);

  useEffect(() => {
    if (!menuFor) return;
    const away = (e: PointerEvent) => {
      if (!(e.target as Element).closest?.("[role=menu], [aria-expanded=true]")) setMenuFor(null);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [menuFor]);

  useEffect(() => {
    scrollRef.current?.querySelector("[data-selected]")?.scrollIntoView({ block: "center" });
  }, [file?.path, listing?.path]);

  const dir = listing?.path ?? "";
  const refresh = () => void open(dir || undefined);

  const upload = async (files: FileList | File[]) => {
    if (!dir) return;
    for (const f of Array.from(files)) {
      const id = `${f.name}-${f.size}-${Math.random().toString(36).slice(2, 6)}`;
      setUploads((u) => [...u, { id, name: f.name, sent: 0, total: f.size, state: "sending" }]);
      const set = (patch: Partial<Upload>) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, ...patch } : x)));
      try {
        let replace = false;
        if (listing?.entries.some((e) => e.name === f.name)) {
          if (!(await confirmAsk({ title: `Replace ${f.name}?`, body: "A file with this name exists.", confirm: "Replace" }))) {
            setUploads((u) => u.filter((x) => x.id !== id));
            continue;
          }
          replace = true;
        }
        await uploadFile(dir, f, { replace, onProgress: (p) => set({ sent: p.sent, state: p.retrying ? "retrying" : "sending" }) });
        set({ state: "done", sent: f.size });
        setTimeout(() => setUploads((u) => u.filter((x) => x.id !== id)), 4000);
      } catch (err) {
        set({ state: "failed", error: err instanceof ApiError ? err.message : "Upload failed." });
      }
    }
    refresh();
  };

  const act = async (body: Record<string, unknown>, after?: () => void) => {
    try {
      await api("/api/files", body);
      after?.();
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reach the server.");
    }
  };
  const mkdir = async () => {
    const name = await promptAsk({ title: "New folder", body: `In ${shortPath(dir)}`, confirm: "Create" });
    if (name) void act({ action: "mkdir", path: dir, name });
  };
  const rename = async (it: { path: string; name: string }) => {
    const name = await promptAsk({ title: `Rename ${it.name}`, confirm: "Rename", value: it.name });
    if (name && name !== it.name) void act({ action: "rename", path: it.path, name }, () => file?.path === it.path && setFile(null));
  };
  const remove = async (it: { path: string; name: string; type?: string }) => {
    const ok = await confirmAsk({ title: `Delete ${it.name}?`, body: it.type === "dir" ? "Deletes everything inside. This can't be undone." : "This can't be undone.", confirm: "Delete", danger: true });
    if (ok) void act({ action: "delete", path: it.path }, () => file?.path === it.path && setFile(null));
  };

  const crumbs = useMemo(() => {
    if (!dir) return [];
    const parts = dir.split("/").filter(Boolean);
    return [{ name: "/", path: "/" }, ...parts.map((p, i) => ({ name: p, path: `/${parts.slice(0, i + 1).join("/")}` }))];
  }, [dir]);

  const now = Date.now();
  const list = (
    <div
      className={`relative flex min-h-0 min-w-0 flex-col ${file ? "max-md:hidden md:w-[min(40%,440px)] md:flex-none" : "flex-1"}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        if (e.dataTransfer.files.length) void upload(e.dataTransfer.files);
      }}
    >
      <div className="flex shrink-0 items-center gap-0.5 px-2 pb-1 sm:px-4">
        <button type="button" onClick={() => listing?.parent && void open(listing.parent)} disabled={!listing?.parent} aria-label="Up one folder" data-tip="Up" className={iconBtn}>
          <NavArrowUp width={17} height={17} strokeWidth={1.8} />
        </button>
        {typed !== null ? (
          <form
            className="min-w-0 flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              const p = typed.trim().replace(/^~(?=\/|$)/, listing?.home ?? "~");
              setTyped(null);
              if (p) void open(p);
            }}
          >
            <input
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onBlur={() => setTyped(null)}
              aria-label="Go to path"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              translate="no"
              className="h-8 w-full rounded-[8px] bg-inset px-2.5 font-mono text-[16px] text-ink shadow-hairline outline-none sm:text-sm"
            />
          </form>
        ) : (
          <nav aria-label="Path" className="no-scrollbar flex min-w-0 flex-1 items-center self-stretch overflow-x-auto font-mono text-sm whitespace-nowrap" onDoubleClick={() => setTyped(dir)}>
            {crumbs.map((c, i) => (
              <span key={c.path} className="flex items-center">
                {i > 1 && <span className="px-0.5 text-ink-3">/</span>}
                <button type="button" onClick={() => void open(c.path)} className={`tap relative min-h-6 min-w-6 rounded-[6px] px-1 py-0.5 hover:bg-hover ${i === crumbs.length - 1 ? "text-ink" : "text-ink-3"}`} translate="no">
                  {c.name}
                </button>
              </span>
            ))}
            <button type="button" onClick={() => setTyped(dir)} className="tap relative ml-1 inline-flex min-h-6 items-center rounded-[6px] px-1.5 py-0.5 text-ink-3 hover:bg-hover" aria-label="Type a path">
              <EditPencil width={13} height={13} strokeWidth={1.8} />
            </button>
          </nav>
        )}
        <button
          type="button"
          onClick={() => {
            setHidden((h) => !h);
            void open(dir || undefined, { hidden: !hidden });
          }}
          aria-pressed={hidden}
          aria-label={hidden ? "Hide hidden files" : "Show hidden files"}
          data-tip={hidden ? "Hide hidden files" : "Show hidden files"}
          className={iconBtn}
        >
          {hidden ? <Eye width={17} height={17} strokeWidth={1.8} /> : <EyeClosed width={17} height={17} strokeWidth={1.8} />}
        </button>
        <button type="button" onClick={mkdir} disabled={!dir} aria-label="New folder" data-tip="New folder" className={iconBtn}>
          <FolderPlus width={17} height={17} strokeWidth={1.8} />
        </button>
        <button type="button" onClick={refresh} aria-label="Refresh" data-tip="Refresh" className={iconBtn}>
          <Refresh width={16} height={16} strokeWidth={1.8} className={loading ? "animate-spin" : ""} />
        </button>
        <button type="button" onClick={() => inputRef.current?.click()} disabled={!dir} className="tap relative ml-1 inline-flex h-8 items-center gap-1.5 rounded-full bg-ink px-3 text-sm font-medium text-page disabled:opacity-50">
          <Upload width={15} height={15} strokeWidth={1.9} />
          <span>Upload</span>
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) void upload(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {uploads.length > 0 && (
        <ul className="mx-2 mb-1 flex flex-col gap-1 rounded-[10px] bg-inset p-2 sm:mx-4">
          {uploads.map((u) => (
            <li key={u.id} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-ink" translate="no">
                {u.name}
              </span>
              <span className={`shrink-0 tabular-nums ${u.state === "failed" ? "text-red-ink" : "text-ink-3"}`}>
                {u.state === "failed" ? u.error : u.state === "done" ? "Uploaded" : `${u.state === "retrying" ? "Reconnecting… " : ""}${formatBytes(u.sent)} of ${formatBytes(u.total)}`}
              </span>
              {u.state === "failed" && (
                <button type="button" onClick={() => setUploads((x) => x.filter((y) => y.id !== u.id))} aria-label="Dismiss" className="text-ink-3 hover:text-ink">
                  <Xmark width={14} height={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p role="alert" className="mx-2 mb-1 rounded-[10px] bg-red-tint px-3 py-2 text-sm text-red-ink sm:mx-4">
          {error}
        </p>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pb-6 sm:px-3">
        {listing === null && !error ? (
          <p className="px-3 py-6 text-sm text-ink-3">Loading files…</p>
        ) : listing?.entries.length === 0 ? (
          <p className="px-3 py-6 text-sm text-ink-3">Empty folder{listing.hiddenCount ? ` (${listing.hiddenCount} hidden)` : ""}</p>
        ) : (
          <ul className="flex flex-col">
            {listing?.entries.map((it) => (
              <li key={it.path} className="group relative" data-selected={file?.path === it.path || undefined}>
                <button
                  type="button"
                  onClick={() => (it.type === "dir" ? void open(it.path) : void open(it.path))}
                  className={`flex min-h-11 w-full min-w-0 items-center gap-3 rounded-[9px] px-2.5 pr-11 text-left hover:bg-hover sm:min-h-9 ${file?.path === it.path ? "bg-hover" : ""}`}
                >
                  {it.type === "dir" ? <Folder width={16} height={16} strokeWidth={1.8} className="shrink-0 text-accent-ink" aria-hidden /> : <Page width={16} height={16} strokeWidth={1.8} className="shrink-0 text-ink-3" aria-hidden />}
                  <span className={`min-w-0 flex-1 truncate text-sm ${it.type === "broken" ? "text-ink-3 line-through" : "text-ink"}`} translate="no">
                    {it.name}
                    {it.link && <span className="text-ink-3"> ↗</span>}
                  </span>
                  <span className="hidden shrink-0 text-xs text-ink-3 tabular-nums min-[420px]:inline">{it.type === "file" ? formatBytes(it.size) : ""}</span>
                  <span className="w-10 shrink-0 text-right text-xs text-ink-3 tabular-nums">{it.mtime ? timeAgo(it.mtime, now) : ""}</span>
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    setMenuUp(window.innerHeight - e.currentTarget.getBoundingClientRect().bottom < 200);
                    setMenuFor((m) => (m === it.path ? null : it.path));
                  }}
                  aria-label={`Actions for ${it.name}`}
                  aria-expanded={menuFor === it.path}
                  className="absolute top-1/2 right-1 flex size-8 -translate-y-1/2 items-center justify-center rounded-[8px] text-ink-3 opacity-100 hover:bg-hover hover:text-ink sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                >
                  <MoreHoriz width={16} height={16} />
                </button>
                {menuFor === it.path && (
                  <div role="menu" className={`absolute right-1 z-30 w-48 ${menuUp ? "bottom-full" : "top-full"} rounded-[12px] bg-surface p-1 shadow-overlay`} onMouseLeave={() => setMenuFor(null)}>
                    {it.type === "file" && (
                      <a role="menuitem" href={raw(it.path, true)} download={it.name} className="menu-item" onClick={() => setMenuFor(null)}>
                        <Download width={15} height={15} strokeWidth={1.8} className="shrink-0 text-ink-3" aria-hidden />
                        Download
                      </a>
                    )}
                    <button type="button" role="menuitem" className="menu-item" onClick={() => (setMenuFor(null), void copyText(it.path))}>
                      <Copy width={15} height={15} strokeWidth={1.8} className="shrink-0 text-ink-3" aria-hidden />
                      Copy path
                    </button>
                    <button type="button" role="menuitem" className="menu-item" onClick={() => (setMenuFor(null), rename(it))}>
                      <EditPencil width={15} height={15} strokeWidth={1.8} className="shrink-0 text-ink-3" aria-hidden />
                      Rename
                    </button>
                    <button type="button" role="menuitem" className="menu-item text-red-ink" onClick={() => (setMenuFor(null), remove(it))}>
                      <Trash width={15} height={15} strokeWidth={1.8} className="shrink-0" aria-hidden />
                      Delete
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {listing?.truncated && <p className="px-3 py-2 text-xs text-ink-3">Showing the first 2000 entries.</p>}
      </div>
      {drag && (
        <div className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-[14px] border-2 border-dashed border-accent bg-page/80 text-base font-medium text-ink">
          Drop to upload to {shortPath(dir)}
        </div>
      )}
    </div>
  );

  return (
    <section className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="on-page safe-top safe-x flex shrink-0 items-center bg-page">
        <div className="flex h-14 w-full min-w-0 items-center gap-1 px-1.5 sm:px-3 lg:h-[52px]">
          <button type="button" onClick={onMenu} aria-label="Open sessions" aria-haspopup="dialog" data-drawer-opener className="icon-btn lg:hidden">
            <Menu width={19} height={19} strokeWidth={1.8} />
          </button>
          <h1 className="min-w-0 flex-1 truncate px-1.5 text-md font-medium tracking-[-0.01em] text-ink sm:text-base">Files</h1>
          {extra}
        </div>
      </header>
      <div className="safe-x safe-bottom flex min-h-0 flex-1">
        {list}
        {file && (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col border-line md:border-l">
            <Preview file={file} onClose={() => setFile(null)} onRename={() => rename({ path: file.path, name: file.path.split("/").pop() ?? "" })} onDelete={() => remove({ path: file.path, name: file.path.split("/").pop() ?? "" })} onSaved={refresh} />
          </div>
        )}
      </div>
    </section>
  );
}

/* ── the artifact viewer ──────────────────────────────────── */

type TextState = { text: string; partial: boolean } | { error: string } | null;

function Preview({ file, onClose, onRename, onDelete, onSaved }: { file: FileInfo; onClose: () => void; onRename: () => void; onDelete: () => void; onSaved: () => void }) {
  const name = file.path.split("/").pop() ?? file.path;
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const textual = file.text || file.mime.startsWith("text/") || file.mime === "application/json";
  const kind = file.mime.startsWith("image/") ? "image" : file.mime.startsWith("video/") ? "video" : file.mime.startsWith("audio/") ? "audio" : file.mime === "application/pdf" ? "pdf" : file.mime === "text/html" ? "html" : ext === "md" || ext === "markdown" ? "markdown" : textual ? "text" : "binary";
  const [text, setText] = useState<TextState>(null);
  const [source, setSource] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setText(null);
    setSource(false);
    setEditing(null);
    setSaveError(null);
    if (!["html", "markdown", "text"].includes(kind)) return;
    const ctl = new AbortController();
    fetch(raw(file.path), { headers: { Range: `bytes=0-${PREVIEW_BYTES - 1}` }, signal: ctl.signal, cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
        setText({ text: await r.text(), partial: file.size > PREVIEW_BYTES });
      })
      .catch((err) => !ctl.signal.aborted && setText({ error: err instanceof Error ? err.message : "Couldn't load file." }));
    return () => ctl.abort();
  }, [file.path, file.mtime, file.size, kind]);

  const save = async () => {
    if (editing === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api("/api/files", { action: "write", path: file.path, text: editing });
      setText({ text: editing, partial: false });
      setEditing(null);
      onSaved();
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Couldn't reach the server.");
    } finally {
      setSaving(false);
    }
  };

  const body = (() => {
    if (kind === "image") return <img src={`${raw(file.path)}&v=${file.mtime}`} alt={name} className="mx-auto max-h-full max-w-full rounded-[8px] object-contain shadow-hairline" />;
    if (kind === "video") return <video src={raw(file.path)} controls playsInline className="mx-auto max-h-full max-w-full rounded-[8px]" />;
    if (kind === "audio") return <audio src={raw(file.path)} controls className="w-full" />;
    if (kind === "pdf")
      return (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <a href={raw(file.path)} target="_blank" rel="noopener" className="tap relative inline-flex h-9 items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-medium text-page">
            <OpenNewWindow width={15} height={15} /> Open PDF
          </a>
        </div>
      );
    if (kind === "binary")
      return (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <p className="text-sm text-ink-3">No preview available.</p>
          <a href={raw(file.path, true)} download={name} className="tap relative inline-flex h-9 items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-medium text-page">
            <Download width={15} height={15} /> Download {formatBytes(file.size)}
          </a>
        </div>
      );
    if (text === null) return <p className="py-6 text-sm text-ink-3">Loading preview…</p>;
    if ("error" in text) return <p className="py-6 text-sm text-red-ink">{text.error}</p>;
    if (editing !== null)
      return (
        <textarea
          value={editing}
          onChange={(e) => setEditing(e.target.value)}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="h-full min-h-[50vh] w-full resize-none rounded-[10px] bg-inset p-3 font-mono text-[16px] leading-relaxed text-ink shadow-hairline outline-none sm:text-sm"
        />
      );
    if (kind === "html" && !source)
      return <iframe title={name} sandbox="allow-scripts" srcDoc={withPreviewCsp(text.text)} className="h-full min-h-[60vh] w-full rounded-[10px] bg-white shadow-hairline" />;
    if (kind === "markdown" && !source)
      return (
        <div className="px-1">
          <Markdown text={text.text} />
        </div>
      );
    return <CodeCard code={text.text} label={name} />;
  })();

  const canEdit = ["html", "markdown", "text"].includes(kind) && text !== null && !("error" in text) && !text.partial;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-0.5 px-2 pb-1 sm:px-3">
        <button type="button" onClick={onClose} aria-label="Back" className="icon-btn md:hidden">
          <NavArrowLeft width={18} height={18} strokeWidth={1.8} />
        </button>
        <div className="flex min-w-0 flex-1 flex-col px-1">
          <span className="truncate text-sm font-medium text-ink" translate="no">
            {name}
          </span>
          <span className="truncate text-xs text-ink-3">
            {formatBytes(file.size)} · {timeAgo(file.mtime)}
            {text && "partial" in text && text.partial ? ` · first ${formatBytes(PREVIEW_BYTES)} shown` : ""}
          </span>
        </div>
        {(kind === "html" || kind === "markdown") && editing === null && (
          <button type="button" onClick={() => setSource((s) => !s)} aria-pressed={source} className="h-8 rounded-full px-2.5 text-sm font-medium text-ink-2 hover:bg-hover">
            {source ? "Rendered" : "Source"}
          </button>
        )}
        {canEdit &&
          (editing === null ? (
            <button type="button" onClick={() => setEditing("text" in text! ? text.text : "")} aria-label="Edit" data-tip="Edit" className="icon-btn">
              <EditPencil width={16} height={16} strokeWidth={1.8} />
            </button>
          ) : (
            <>
              <button type="button" onClick={() => setEditing(null)} className="h-8 rounded-full px-2.5 text-sm font-medium text-ink-2 hover:bg-hover">
                Cancel
              </button>
              <button type="button" onClick={() => void save()} disabled={saving} className="h-8 rounded-full bg-ink px-3 text-sm font-medium text-page disabled:opacity-60">
                {saving ? "Saving…" : "Save"}
              </button>
            </>
          ))}
        <a href={raw(file.path, true)} download={name} aria-label="Download" data-tip="Download" className="icon-btn">
          <Download width={16} height={16} strokeWidth={1.8} />
        </a>
        <button type="button" onClick={() => void copyText(file.path)} aria-label="Copy path" data-tip="Copy path" className="icon-btn max-sm:hidden">
          <Copy width={16} height={16} strokeWidth={1.8} />
        </button>
        <button type="button" onClick={onRename} className="h-8 rounded-full px-2.5 text-sm font-medium text-ink-2 hover:bg-hover max-sm:hidden">
          Rename
        </button>
        <button type="button" onClick={onDelete} aria-label="Delete" data-tip="Delete" className="icon-btn text-red-ink">
          <Trash width={16} height={16} strokeWidth={1.8} />
        </button>
        <button type="button" onClick={onClose} aria-label="Close preview" className="icon-btn max-md:hidden">
          <Xmark width={17} height={17} strokeWidth={1.8} />
        </button>
      </div>
      {saveError && <p className="mx-3 mb-1 rounded-[10px] bg-red-tint px-3 py-2 text-sm text-red-ink">{saveError}</p>}
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain px-2 pb-6 sm:px-3">{body}</div>
    </div>
  );
}
