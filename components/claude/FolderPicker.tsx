"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Eye, EyeClosed, Folder, NavArrowRight, Search, Xmark } from "iconoir-react";
import { shortPath } from "@/lib/client/api";

/* A combobox for choosing a working folder on the server: recent projects on
 * top, then a browser of the server's filesystem (folders only) starting at
 * home. A centered panel on desktop, a bottom sheet on phones. */

type Listing = { path: string; parent: string | null; home: string; dirs: { name: string; path: string }[]; truncated: boolean };
type Item = { kind: "recent" | "dir"; path: string; name: string };

const base = (p: string) => p.replace(/\/+$/, "").split("/").pop() || "/";

export function FolderPicker({
  open,
  value,
  recent,
  onPick,
  onClose,
}: {
  open: boolean;
  /** the folder chosen so far; browsing starts there */
  value: string;
  /** recent project folders, newest first */
  recent: string[];
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const uid = useId();
  const [query, setQuery] = useState("");
  const [data, setData] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const crumbsRef = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const abort = useRef<AbortController | null>(null);
  const home = data?.home ?? "";

  const browse = useCallback(
    async (target?: string, opts: { hidden?: boolean; quiet?: boolean } = {}) => {
      abort.current?.abort();
      const ctl = new AbortController();
      abort.current = ctl;
      setLoading(true);
      const params = new URLSearchParams();
      if (target) params.set("path", target);
      if (opts.hidden ?? hidden) params.set("hidden", "1");
      try {
        const res = await fetch(`/api/fs?${params}`, { signal: ctl.signal });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "Couldn't open that folder.");
        setData(body as Listing);
        setError(null);
        setActive(0);
        return true;
      } catch (err) {
        if ((err as Error).name === "AbortError") return false;
        if (!opts.quiet) setError((err as Error).message);
        return false;
      } finally {
        if (abort.current === ctl) setLoading(false);
      }
    },
    [hidden],
  );

  /* open: remember who opened us, start at the current folder (or home) */
  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement as HTMLElement | null;
    setQuery("");
    setError(null);
    setActive(0);
    void (async () => {
      if (!value || !(await browse(value, { quiet: true }))) await browse();
    })();
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => abort.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = useCallback(() => {
    onClose();
    requestAnimationFrame(() => opener.current?.focus?.());
  }, [onClose]);

  const pick = (p: string) => {
    onPick(p);
    close();
  };

  /* "~/x" and "/x" in the box browse that path; anything else filters */
  const expand = (q: string) => (q.startsWith("~") && home ? home + q.slice(1) : q);
  const pathMode = query.startsWith("/") || query.startsWith("~");
  const expanded = expand(query.trim());
  const pathDir = pathMode ? expanded.slice(0, expanded.lastIndexOf("/") + 1) || "/" : "";
  const leaf = pathMode ? expanded.slice(expanded.lastIndexOf("/") + 1).toLowerCase() : query.trim().toLowerCase();
  /* "/home/ubuntu" typed without the last slash means that folder, not the one being listed (/home) */
  const typedDir = pathMode && leaf ? data?.dirs.find((d) => d.name === expanded.slice(expanded.lastIndexOf("/") + 1)) : undefined;
  const chosen = typedDir?.path ?? data?.path;

  useEffect(() => {
    if (!open || !pathMode || !home) return;
    const dir = pathDir.length > 1 ? pathDir.replace(/\/+$/, "") : "/";
    if (data && dir === data.path) return;
    const t = setTimeout(() => void browse(dir, { quiet: true }), 160);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pathMode, pathDir, home]);

  const items = useMemo<Item[]>(() => {
    const recents: Item[] = pathMode
      ? []
      : recent
          .filter((p) => !leaf || p.toLowerCase().includes(leaf))
          .slice(0, leaf ? 6 : 4)
          .map((p) => ({ kind: "recent", path: p, name: base(p) }));
    const dirs: Item[] = (data?.dirs ?? [])
      .filter((d) => !leaf || (pathMode ? d.name.toLowerCase().startsWith(leaf) : d.name.toLowerCase().includes(leaf)))
      .map((d) => ({ kind: "dir", path: d.path, name: d.name }));
    return [...recents, ...dirs];
  }, [recent, data, leaf, pathMode]);

  useEffect(() => setActive(0), [query]);
  const current = Math.min(active, items.length - 1);
  const optId = (i: number) => `${uid}-opt-${i}`;

  useLayoutEffect(() => {
    if (current >= 0) document.getElementById(optId(current))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);
  useLayoutEffect(() => {
    const el = crumbsRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [data?.path]);

  const enter = (it: Item) => {
    if (it.kind === "recent") return pick(it.path);
    void browse(it.path);
    setQuery(pathMode ? `${it.path.startsWith(home) && query.startsWith("~") ? `~${it.path.slice(home.length)}` : it.path}/` : "");
  };

  const goUp = () => {
    if (data?.parent) void browse(data.parent);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
        if (!items.length) return;
        e.preventDefault();
        setActive((a) => (Math.min(a, items.length - 1) + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
        return;
      case "Enter":
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) return chosen && pick(chosen);
        if (pathMode && !items.length && expanded) {
          void browse(expanded.replace(/(.)\/+$/, "$1")).then((ok) => ok && setQuery(""));
          return;
        }
        if (items[current]) enter(items[current]);
        else if (data && !query) pick(data.path);
        return;
      case "ArrowRight": {
        const it = items[current];
        const input = e.target as HTMLInputElement;
        if (it?.kind === "dir" && input === inputRef.current && input.selectionStart === query.length) {
          e.preventDefault();
          enter(it);
        }
        return;
      }
      case "ArrowLeft":
      case "Backspace":
        if (!query && e.target === inputRef.current) {
          e.preventDefault();
          goUp();
        }
        return;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        if (query) setQuery("");
        else close();
        return;
      case "Tab": {
        const focusables = Array.from(panelRef.current?.querySelectorAll<HTMLElement>("input, button:not([disabled])") ?? []).filter((el) => el.tabIndex >= 0);
        if (!focusables.length) return;
        const at = focusables.indexOf(document.activeElement as HTMLElement);
        const next = e.shiftKey ? (at <= 0 ? focusables.length - 1 : at - 1) : at === focusables.length - 1 ? 0 : at + 1;
        e.preventDefault();
        focusables[next].focus();
        return;
      }
    }
  };

  if (!open) return null;

  /* breadcrumb: "~" for home, then each segment */
  const crumbs: { label: string; path: string }[] = [];
  if (data) {
    const inHome = home && (data.path === home || data.path.startsWith(`${home}/`));
    const rest = inHome ? data.path.slice(home.length) : data.path;
    crumbs.push(inHome ? { label: "~", path: home } : { label: "/", path: "/" });
    let acc = inHome ? home : "";
    for (const seg of rest.split("/").filter(Boolean)) {
      acc = `${acc}/${seg}`;
      crumbs.push({ label: seg, path: acc });
    }
  }

  const recentCount = items.filter((i) => i.kind === "recent").length;
  const dirCount = items.length - recentCount;

  const row = (it: Item, i: number) => {
    const on = i === current;
    return (
      <div
        key={`${it.kind}:${it.path}`}
        id={optId(i)}
        role="option"
        aria-selected={on}
        onMouseMove={() => active !== i && setActive(i)}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => enter(it)}
        title={it.path}
        className={`flex min-h-11 cursor-pointer items-center gap-2.5 rounded-[8px] px-2.5 text-base transition-colors duration-75 sm:min-h-9 sm:text-sm ${on ? "bg-hover text-ink" : "text-ink-2"}`}
      >
        <Folder width={16} height={16} strokeWidth={1.8} className={`shrink-0 ${on ? "text-ink-2" : "text-ink-3"}`} aria-hidden />
        <span className="min-w-0 truncate" translate="no">
          {it.name}
        </span>
        {it.kind === "recent" ? (
          <span className="ml-auto min-w-0 shrink truncate pl-3 text-xs text-ink-3" translate="no">
            {shortPath(it.path)}
          </span>
        ) : (
          <NavArrowRight width={14} height={14} strokeWidth={2} className={`ml-auto shrink-0 text-ink-3 transition-opacity duration-100 ${on ? "opacity-100" : "opacity-0"}`} aria-hidden />
        )}
      </div>
    );
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-start sm:px-4 sm:pt-[12vh]" onKeyDown={onKeyDown}>
      <div aria-hidden className="absolute inset-0 touch-none bg-black/40 motion-safe:animate-[fade-in_160ms_ease-out_both]" onClick={close} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Choose a folder"
        onMouseDown={(e) => {
          if (!(e.target as HTMLElement).closest("input, button")) e.preventDefault();
        }}
        className="folder-sheet safe-bottom relative flex h-[min(78dvh,620px)] w-full flex-col overflow-hidden rounded-t-[18px] bg-surface shadow-overlay sm:h-[min(72vh,540px)] sm:max-w-[560px] sm:rounded-[14px]"
      >
        <div aria-hidden className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-line-strong sm:hidden" />
        <div className="flex h-14 shrink-0 items-center gap-2.5 pr-2 pl-4 sm:h-[52px]">
          <Search width={17} height={17} strokeWidth={1.9} className="shrink-0 text-ink-3" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={`${uid}-list`}
            aria-autocomplete="list"
            aria-activedescendant={current >= 0 ? optId(current) : undefined}
            aria-label="Search folders or type a path"
            placeholder="Search or type a path"
            enterKeyHint="go"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            translate="no"
            className="h-full min-w-0 flex-1 bg-transparent text-[16px] text-ink outline-none placeholder:text-ink-3 sm:text-base sm:pointer-coarse:text-[16px]"
          />
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="tap relative flex size-10 shrink-0 items-center justify-center rounded-[9px] text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink sm:size-8"
          >
            <Xmark width={16} height={16} strokeWidth={2} />
          </button>
        </div>

        <div className="flex h-10 shrink-0 items-center gap-1 border-y border-line pr-1.5 pl-2.5">
          <nav ref={crumbsRef} aria-label="Folder path" className="no-scrollbar flex min-w-0 flex-1 items-center overflow-x-auto whitespace-nowrap text-sm" translate="no">
            {crumbs.map((c, i) => {
              const last = i === crumbs.length - 1;
              return (
                <span key={c.path} className="flex shrink-0 items-center">
                  {i > 0 && crumbs[i - 1].label !== "/" && (
                    <span aria-hidden className="px-0.5 text-ink-3">
                      /
                    </span>
                  )}
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-current={last ? "location" : undefined}
                    onClick={() => {
                      setQuery("");
                      void browse(c.path);
                      inputRef.current?.focus();
                    }}
                    className={`rounded-[6px] px-1.5 py-1 transition-colors duration-100 hover:bg-hover ${last ? "font-medium text-ink" : "text-ink-3 hover:text-ink-2"}`}
                  >
                    {c.label}
                  </button>
                </span>
              );
            })}
          </nav>
          <button
            type="button"
            onClick={() => {
              const next = !hidden;
              setHidden(next);
              if (data) void browse(data.path, { hidden: next });
              inputRef.current?.focus();
            }}
            aria-pressed={hidden}
            aria-label={hidden ? "Hide hidden folders" : "Show hidden folders"}
            title={hidden ? "Hide hidden folders" : "Show hidden folders"}
            className={`tap relative flex size-8 shrink-0 items-center justify-center rounded-[8px] transition-colors duration-100 hover:bg-hover ${hidden ? "text-ink" : "text-ink-3 hover:text-ink-2"}`}
          >
            {hidden ? <Eye width={15} height={15} strokeWidth={1.9} /> : <EyeClosed width={15} height={15} strokeWidth={1.9} />}
          </button>
        </div>

        <div id={`${uid}-list`} role="listbox" aria-label="Folders" aria-busy={loading} className="thin-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
          {recentCount > 0 && (
            <div role="group" aria-labelledby={`${uid}-recent`} className="pb-1">
              <div id={`${uid}-recent`} role="presentation" className="px-2.5 pt-1.5 pb-1 text-xs font-medium text-ink-3">
                Recent
              </div>
              {items.slice(0, recentCount).map((it, i) => row(it, i))}
            </div>
          )}
          <div role="group" aria-label={data ? `Folders in ${shortPath(data.path)}` : "Folders"}>
            {recentCount > 0 && (
              <div role="presentation" className="px-2.5 pt-2 pb-1 text-xs font-medium text-ink-3">
                {data ? base(data.path === home ? "~" : data.path) : "Folders"}
              </div>
            )}
            {items.slice(recentCount).map((it, i) => row(it, recentCount + i))}
          </div>
          {error ? (
            <p role="alert" className="px-2.5 py-3 text-sm text-red-ink">
              {error}
            </p>
          ) : !loading && data && dirCount === 0 ? (
            <p className="px-2.5 py-3 text-sm text-ink-3">{leaf ? "No folders match." : "No subfolders here."}</p>
          ) : !data ? (
            <p className="px-2.5 py-3 text-sm text-ink-3">Loading folders…</p>
          ) : null}
          {data?.truncated && !leaf && <p className="px-2.5 py-2 text-xs text-ink-3">First 500 shown. Type to filter.</p>}
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-line py-2.5 pr-2.5 pl-4">
          <span className="min-w-0 flex-1 truncate text-sm text-ink-3" title={chosen} translate="no">
            {chosen ? shortPath(chosen) : "\u00a0"}
          </span>
          <button
            type="button"
            disabled={!chosen}
            onClick={() => chosen && pick(chosen)}
            title="Use this folder (Ctrl+Enter)"
            className="tap relative h-10 shrink-0 rounded-full bg-ink px-4 text-sm font-medium text-surface transition-[opacity,transform] duration-150 enabled:active:scale-[0.97] disabled:opacity-40 sm:h-8"
          >
            Use this folder
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
