"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChatBubble, ChatLines, Check, EditPencil, Folder, HalfMoon, KeyCommand, LogOut, MailIn, Palette, Search, Settings, SidebarCollapse, SunLight, Computer, Terminal, Xmark } from "iconoir-react";
import type { SessionSummary } from "@/lib/types";
import { api, shortPath, timeAgo } from "@/lib/client/api";
import { Pulse } from "./Pulse";
import { isBusy } from "./SessionList";
import { applyAppearance, applyTheme, getSettings, setSetting, type Settings as SettingValues } from "@/lib/client/settings";
import { comboFor } from "@/lib/client/shortcuts";
import { PALETTES, settingDef, type EnumSetting } from "@/lib/settings-schema";

/** Fired on window to open the palette from anywhere: `window.dispatchEvent(new Event("open-palette"))`. */
export const OPEN_PALETTE_EVENT = "open-palette";

/** Fired on window to fold or unfold the sidebar (the drawer on a phone). */
export const TOGGLE_SIDEBAR_EVENT = "toggle-sidebar";

/** Fired on window to open the keyboard shortcuts sheet. */
export const OPEN_SHORTCUTS_EVENT = "open-shortcuts";

/** Fired on window with `detail: TerminalTarget` to open the web terminal. */
export const OPEN_TERMINAL_EVENT = "open-terminal";

const isLive = (s: SessionSummary) => Boolean(s.terminal) || (s.web !== null && s.web.status !== "closed");

/**
 * How well `q` matches `text`: prefix > word start > substring > in-order
 * characters (so "agu" finds "agent-u"). 0 means no match.
 */
function score(text: string, q: string) {
  const t = text.toLowerCase();
  const i = t.indexOf(q);
  if (i === 0) return 100;
  if (i > 0) return /[\s/_.-]/.test(t[i - 1]) ? 80 : 60;
  let at = 0;
  for (const ch of q) {
    at = t.indexOf(ch, at);
    if (at < 0) return 0;
    at++;
  }
  return q.length > 1 ? 20 : 0;
}

/** Every word of the query has to land somewhere; the title counts most. */
function matchSession(s: SessionSummary, words: string[]) {
  let total = 0;
  for (const w of words) {
    const best = Math.max(score(s.title, w) * 1.5, score(s.project, w), score(s.cwd, w) * 0.8);
    if (!best) return 0;
    total += best;
  }
  return total;
}

type Item = {
  id: string;
  group: "Sessions" | "Messages" | "Actions" | "Themes" | "Appearance";
  label: string;
  hint?: ReactNode;
  /** shortcut id from lib/client/shortcuts.ts, shown on the right */
  combo?: string;
  icon: ReactNode;
  run: () => void;
  /** opens a picker inside the palette instead of closing it */
  keep?: boolean;
  /** picker rows: the appearance this row shows while it's highlighted */
  preview?: Partial<SettingValues>;
  current?: boolean;
};

/** A quick picker inside the palette: arrow keys preview each choice, Enter keeps it, Esc puts the old one back. */
type Picker = "palette" | "theme";

/** The palette setting the theme picker changes: the light-mode one while light, if it's set apart. */
function paletteKey(): "palette" | "lightPalette" {
  const s = getSettings();
  return !document.documentElement.classList.contains("dark") && s.lightPalette !== "same" ? "lightPalette" : "palette";
}

function PaletteDot({ id }: { id: string }) {
  const dark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  const p = PALETTES.find((x) => x.id === id);
  if (!p) return <Palette width={15} height={15} strokeWidth={1.8} />;
  const c = dark ? p.dark : p.light;
  return (
    <span className="flex size-4 overflow-hidden rounded-[5px]" style={{ boxShadow: `inset 0 0 0 1px ${c.line}` }}>
      <span className="w-1/2" style={{ background: c.sidebar }} />
      <span className="flex w-1/2 items-center justify-center" style={{ background: c.page }}>
        <span className="size-1.5 rounded-full" style={{ background: c.accent }} />
      </span>
    </span>
  );
}

const SESSION_CAP_IDLE = 8;
const SESSION_CAP_SEARCH = 50;

export function CommandPalette({
  sessions,
  activeId,
  onOpen,
  onNew,
  onView,
  onTheme,
}: {
  sessions: SessionSummary[] | null;
  activeId: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  /** opens the Agents or Files screen */
  onView?: (tab: "@agents" | "@files" | "@inbox" | "@settings") => void;
  /** called after the theme flips, so other theme controls can resync */
  onTheme?: (dark: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [dark, setDark] = useState(true);
  const [picker, setPicker] = useState<Picker | null>(null);
  /* true while a picker shows a choice that hasn't been kept */
  const previewing = useRef(false);
  const messages = useMessageSearch(query, open && !picker);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  /* set when the chosen command takes the user somewhere new; focus then stays with the new screen */
  const navigated = useRef(false);
  const uid = useId();
  const listId = `${uid}-list`;
  const optId = (i: number) => `${uid}-opt-${i}`;

  const show = useCallback(() => {
    setOpen((was) => {
      if (!was) {
        openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        navigated.current = false;
        setQuery("");
        setActive(0);
        setPicker(null);
        setDark(document.documentElement.classList.contains("dark"));
      }
      return true;
    });
  }, []);

  const endPreview = useCallback(() => {
    if (!previewing.current) return;
    previewing.current = false;
    applyAppearance();
  }, []);

  const openPicker = useCallback((next: Picker | null) => {
    endPreview();
    setPicker(next);
    setQuery("");
    keyMove.current = true;
  }, [endPreview]);

  /* Ctrl+K / Cmd+K toggles from anywhere (capture, so text fields can't swallow it); the event opens it */
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "k") return;
      /* Ctrl+K in a shell kills to end of line */
      if (e.ctrlKey && !e.metaKey && e.target instanceof Element && e.target.closest(".xterm")) return;
      e.preventDefault();
      e.stopPropagation();
      if (panelRef.current) setOpen(false);
      else show();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener(OPEN_PALETTE_EVENT, show);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener(OPEN_PALETTE_EVENT, show);
    };
  }, [show]);

  /* while open: input focused, page behind can't scroll; on close focus goes back where it was */
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus({ preventScroll: true });
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = overflow;
      const back = openerRef.current;
      if (!navigated.current && back?.isConnected) requestAnimationFrame(() => back.focus({ preventScroll: true }));
    };
  }, [open]);

  const close = () => {
    endPreview();
    setPicker(null);
    setOpen(false);
  };

  /* the page underneath never keeps a preview once the palette is gone (Mod+K, unmounts included) */
  useEffect(() => {
    if (!open) endPreview();
  }, [open, endPreview]);
  useEffect(() => () => endPreview(), [endPreview]);

  const toggleTheme = useCallback(() => {
    const next = !document.documentElement.classList.contains("dark");
    applyTheme(next ? "dark" : "light");
    onTheme?.(next);
  }, [onTheme]);

  const pickerItems = useMemo<Item[] | null>(() => {
    if (!picker || !open) return null;
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const s = getSettings();
    const keep = (patch: Partial<SettingValues>) => () => {
      previewing.current = false;
      for (const [k, v] of Object.entries(patch)) setSetting(k as keyof SettingValues, v as never);
    };
    let rows: Item[];
    if (picker === "palette") {
      const key = paletteKey();
      const options = (settingDef("palette") as EnumSetting).options.filter((o) => o.value !== "custom" || s.customTheme);
      rows = options.map((o) => ({
        id: `p:${o.value}`,
        group: "Themes",
        label: o.label,
        hint: key === "lightPalette" ? "Light mode" : undefined,
        icon: <PaletteDot id={o.value} />,
        preview: { [key]: o.value },
        current: s[key] === o.value,
        run: keep({ [key]: o.value }),
      }));
    } else {
      const icons = { system: <Computer width={15} height={15} strokeWidth={1.8} />, light: <SunLight width={15} height={15} strokeWidth={1.8} />, dark: <HalfMoon width={15} height={15} strokeWidth={1.8} /> };
      rows = (settingDef("theme") as EnumSetting<SettingValues["theme"]>).options.map((o) => ({
        id: `t:${o.value}`,
        group: "Appearance",
        label: o.label,
        hint: o.value === "system" ? "Follows this device" : undefined,
        icon: icons[o.value],
        preview: { theme: o.value },
        current: s.theme === o.value,
        run: keep({ theme: o.value }),
      }));
    }
    return words.length ? rows.filter((r) => words.every((w) => score(r.label, w) > 0)) : rows;
  }, [picker, open, query]);

  const items = useMemo<Item[]>(() => {
    if (pickerItems) return pickerItems;
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const all = sessions ?? [];
    let picked: SessionSummary[];
    if (words.length) {
      picked = all
        .map((s) => ({ s, rank: matchSession(s, words) }))
        .filter((x) => x.rank > 0)
        /* open sessions edge ahead of equally good closed ones */
        .sort((a, b) => b.rank + (isLive(b.s) ? 5 : 0) - (a.rank + (isLive(a.s) ? 5 : 0)) || b.s.mtime - a.s.mtime)
        .slice(0, SESSION_CAP_SEARCH)
        .map((x) => x.s);
    } else {
      /* nothing typed: what's open now, then the most recent */
      picked = [...all.filter(isLive), ...all.filter((s) => !isLive(s))].slice(0, SESSION_CAP_IDLE);
    }
    const now = Date.now();
    const sessionItems: Item[] = picked.map((s) => {
      const live = isLive(s);
      return {
        id: `s:${s.id}`,
        group: "Sessions",
        label: s.title,
        hint: (
          <>
            <span className="truncate">{s.project || shortPath(s.cwd) || "No folder"}</span>
            {s.id === activeId ? (
              <span className="shrink-0">· Current</span>
            ) : (
              !live && <span className="shrink-0">· {timeAgo(s.mtime, now)}</span>
            )}
          </>
        ),
        icon: live ? (
          <span className="flex size-4 items-center justify-center" title={isBusy(s) ? "Working" : "Open"}>
            <Pulse busy={isBusy(s)} />
          </span>
        ) : (
          <ChatBubble width={15} height={15} strokeWidth={1.8} />
        ),
        run: () => {
          if (s.id !== activeId) navigated.current = true;
          onOpen(s.id);
        },
      };
    });

    const actions: (Item & { keywords: string })[] = [
      {
        id: "a:new",
        group: "Actions",
        label: "New session",
        combo: "new",
        keywords: "new session start create chat",
        icon: <EditPencil width={15} height={15} strokeWidth={1.8} />,
        run: () => {
          navigated.current = true;
          onNew();
        },
      },
      {
        id: "a:shell",
        group: "Actions",
        label: "Open shell",
        combo: "terminal",
        keywords: "terminal shell bash console command line ssh",
        icon: <Terminal width={15} height={15} strokeWidth={1.8} />,
        run: () => {
          navigated.current = true;
          const s = sessions?.find((x) => x.id === activeId);
          window.dispatchEvent(new CustomEvent(OPEN_TERMINAL_EVENT, { detail: { cwd: s?.cwd || undefined, label: s?.cwd ? `Shell: ${shortPath(s.cwd)}` : "Shell" } }));
        },
      },
      ...(onView
        ? [
            {
              id: "a:inbox",
              group: "Actions" as const,
              label: "Inbox",
              keywords: "inbox waiting approvals needs you failed finished notifications",
              icon: <MailIn width={15} height={15} strokeWidth={1.8} />,
              run: () => {
                navigated.current = true;
                onView("@inbox");
              },
            },
            {
              id: "a:agents",
              group: "Actions" as const,
              label: "Agents and terminals",
              keywords: "agents terminals launch run server profiles accounts proxy tmux",
              icon: <Terminal width={15} height={15} strokeWidth={1.8} />,
              run: () => {
                navigated.current = true;
                onView("@agents");
              },
            },
            {
              id: "a:files",
              group: "Actions" as const,
              label: "Files",
              keywords: "files folder browse upload download artifacts explorer",
              icon: <Folder width={15} height={15} strokeWidth={1.8} />,
              run: () => {
                navigated.current = true;
                onView("@files");
              },
            },
            {
              id: "a:settings",
              group: "Actions" as const,
              label: "Settings",
              combo: "settings",
              keywords: "settings preferences options theme enter send keyboard",
              icon: <Settings width={15} height={15} strokeWidth={1.8} />,
              run: () => {
                navigated.current = true;
                onView("@settings");
              },
            },
          ]
        : []),
      {
        id: "a:sidebar",
        group: "Actions",
        label: "Toggle sidebar",
        combo: "sidebar",
        keywords: "sidebar collapse expand hide show panel rail",
        icon: <SidebarCollapse width={15} height={15} strokeWidth={1.8} />,
        run: () => {
          /* on a phone this opens the drawer, which takes focus */
          navigated.current = !window.matchMedia("(min-width: 1024px)").matches;
          window.dispatchEvent(new Event(TOGGLE_SIDEBAR_EVENT));
        },
      },
      {
        id: "a:theme",
        group: "Actions",
        label: "Toggle light/dark",
        hint: dark ? "Switch to light" : "Switch to dark",
        keywords: "toggle theme dark light mode appearance switch",
        icon: dark ? <SunLight width={15} height={15} strokeWidth={1.8} /> : <HalfMoon width={15} height={15} strokeWidth={1.8} />,
        run: toggleTheme,
      },
      {
        id: "a:palette",
        group: "Actions",
        label: "Change theme…",
        keywords: "theme palette colors color scheme nord solarized catppuccin rose pine github midnight graphite slate custom",
        icon: <Palette width={15} height={15} strokeWidth={1.8} />,
        keep: true,
        run: () => openPicker("palette"),
      },
      {
        id: "a:appearance",
        group: "Actions",
        label: "Change appearance…",
        keywords: "appearance light dark system mode color scheme",
        icon: <Computer width={15} height={15} strokeWidth={1.8} />,
        keep: true,
        run: () => openPicker("theme"),
      },
      {
        id: "a:shortcuts",
        group: "Actions",
        label: "Keyboard shortcuts",
        combo: "shortcuts",
        keywords: "keyboard shortcuts keys hotkeys bindings help",
        icon: <KeyCommand width={15} height={15} strokeWidth={1.8} />,
        run: () => {
          navigated.current = true;
          window.dispatchEvent(new Event(OPEN_SHORTCUTS_EVENT));
        },
      },
      {
        id: "a:signout",
        group: "Actions",
        label: "Sign out",
        keywords: "sign out log out logout leave",
        icon: <LogOut width={15} height={15} strokeWidth={1.8} />,
        run: () => {
          navigated.current = true;
          void api("/api/auth/logout", {})
            .catch(() => undefined)
            .then(() => {
              window.location.href = "/login";
            });
        },
      },
    ];
    const actionItems = words.length ? actions.filter((a) => words.every((w) => score(`${a.label} ${a.keywords}`, w) >= 60)) : actions;
    /* "fil" means the Files action more than a session that mentions files */
    const typed = words.join(" ");
    const prefix = (a: Item) => (!typed ? 1 : a.label.toLowerCase().startsWith(typed) ? 0 : score(a.label, typed) >= 80 ? 0.5 : 1);
    const ranked = [...actionItems].sort((a, b) => prefix(a) - prefix(b));
    const messageItems: Item[] = messages.hits.map((h) => ({
      id: `m:${h.key}`,
      group: "Messages",
      label: all.find((s) => s.id === h.key)?.title || h.title,
      hint: <Snippet text={h.snippet} match={h.match} />,
      icon: <ChatLines width={15} height={15} strokeWidth={1.8} />,
      run: () => {
        if (h.key !== activeId) navigated.current = true;
        onOpen(h.key);
      },
    }));
    const head = ranked.length && prefix(ranked[0]) < 1 ? [...ranked, ...sessionItems] : [...sessionItems, ...ranked];
    return [...head, ...messageItems];
  }, [pickerItems, query, sessions, activeId, dark, messages.hits, onOpen, onNew, onView, toggleTheme, openPicker]);

  /* a new query starts back at the top; a picker starts on the choice in use */
  useEffect(() => {
    keyMove.current = true;
    setActive(query ? 0 : Math.max(0, pickerItems?.findIndex((it) => it.current) ?? 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, picker]);
  const current = Math.min(active, items.length - 1);

  /* the highlighted choice of a picker shows at once on the whole app */
  const previewKey = picker && current >= 0 ? JSON.stringify(items[current]?.preview ?? null) : null;
  useEffect(() => {
    if (!previewKey) return;
    const patch = JSON.parse(previewKey) as Partial<SettingValues> | null;
    if (!patch) return;
    previewing.current = true;
    applyAppearance({ ...getSettings(), ...patch }, { preview: true });
  }, [previewKey]);

  /* only keyboard moves scroll the list; a row under the pointer is already in view */
  const keyMove = useRef(false);
  useLayoutEffect(() => {
    if (!open || current < 0 || !keyMove.current) return;
    keyMove.current = false;
    document.getElementById(optId(current))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, current]);

  const runAt = (i: number) => {
    const item = items[i];
    if (!item) return;
    if (item.keep) return item.run();
    if (item.preview) {
      item.run();
      setPicker(null);
      setOpen(false);
      return;
    }
    close();
    item.run();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const n = items.length;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp": {
        e.preventDefault();
        if (!n) return;
        keyMove.current = true;
        const step = e.key === "ArrowDown" ? 1 : -1;
        setActive((current + step + n) % n);
        return;
      }
      case "Home":
      case "End":
        if (e.target !== inputRef.current || !query) {
          e.preventDefault();
          keyMove.current = true;
          setActive(e.key === "Home" ? 0 : Math.max(0, n - 1));
        }
        return;
      case "Enter":
        if (e.target !== inputRef.current) return;
        e.preventDefault();
        runAt(current);
        return;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        if (query) setQuery("");
        else close();
        return;
      case "Backspace":
        if (picker && !query && e.target === inputRef.current) {
          e.preventDefault();
          openPicker(null);
        }
        return;
      case "Tab": {
        /* focus stays inside the dialog */
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

  const groups = [...new Set(items.map((it) => it.group))]
    .map((g) => ({ g, rows: items.map((it, i) => ({ it, i })).filter((x) => x.it.group === g) }))
    .filter((x) => x.rows.length);
  const loading = sessions === null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center sm:px-4 sm:pt-[12vh]" onKeyDown={onKeyDown}>
      <div
        aria-hidden
        className="absolute inset-0 touch-none bg-black/50 motion-safe:animate-[fade-in_160ms_ease-out_both]"
        onClick={close}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => {
          /* clicks on the chrome keep focus in the field instead of dropping it to the page */
          if (!(e.target as HTMLElement).closest("input, button")) e.preventDefault();
        }}
        className="safe-top relative flex max-h-[min(100dvh,640px)] w-full flex-col overflow-hidden rounded-b-[16px] bg-surface shadow-overlay motion-safe:animate-[fade-up_220ms_cubic-bezier(0.23,1,0.32,1)_both] sm:max-h-[min(72vh,560px)] sm:max-w-[600px] sm:rounded-[14px] sm:motion-safe:animate-[pop-in_180ms_cubic-bezier(0.23,1,0.32,1)_both]"
      >
        <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-line pr-2 pl-4 sm:h-[52px]">
          <Search width={17} height={17} strokeWidth={1.9} className="shrink-0 text-ink-3" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={current >= 0 ? optId(current) : undefined}
            aria-label={picker === "palette" ? "Choose a theme" : picker === "theme" ? "Choose an appearance" : "Search sessions, messages and actions"}
            placeholder={picker === "palette" ? "Choose a theme…" : picker === "theme" ? "Choose an appearance…" : "Search sessions, messages and actions…"}
            enterKeyHint="go"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
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

        <div ref={listRef} id={listId} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
          {groups.map(({ g, rows }) => (
            <div key={g} role="group" aria-labelledby={`${uid}-${g}`} className="pb-1">
              <div id={`${uid}-${g}`} role="presentation" className="px-2.5 pt-2 pb-1 text-xs font-medium text-ink-3">
                {g}
              </div>
              {rows.map(({ it, i }) => {
                const on = i === current;
                return (
                  <div
                    key={it.id}
                    id={optId(i)}
                    role="option"
                    aria-selected={on}
                    onPointerMove={() => !on && setActive(i)}
                    onPointerDown={(e) => e.preventDefault() /* keep focus in the input */}
                    onClick={() => runAt(i)}
                    className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-[9px] px-2.5 py-2 select-none sm:min-h-10 ${on ? "bg-hover text-ink" : "text-ink-2"}`}
                  >
                    <span className={`flex size-5 shrink-0 items-center justify-center ${on ? "text-ink" : "text-ink-3"}`} aria-hidden>
                      {it.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-base font-medium sm:text-sm">{it.label}</span>
                      {it.hint && <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-ink-3">{it.hint}</span>}
                    </span>
                    {it.current && <Check width={15} height={15} strokeWidth={2} className="shrink-0 text-accent-ink" aria-label="In use" />}
                    {on ? (
                      <kbd className="kbd hidden shrink-0 px-1.5 pointer-fine:inline-flex" aria-hidden>
                        Enter
                      </kbd>
                    ) : (
                      it.combo && (
                        <kbd className="kbd hidden shrink-0 px-1.5 pointer-fine:inline-flex" aria-hidden>
                          {comboFor(it.combo)}
                        </kbd>
                      )
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          {loading && !groups.some((x) => x.g === "Sessions") && (
            <p className="px-2.5 py-2 text-sm text-ink-3" role="status">
              Loading sessions…
            </p>
          )}
          {messages.searching && (
            <p className="px-2.5 py-2 text-sm text-ink-3" role="status">
              Searching messages…
            </p>
          )}
          {!items.length && !messages.searching && (
            <p className="px-2.5 py-6 text-center text-sm text-ink-3" role="status">
              Nothing matches <span className="font-medium text-ink-2">“{query.trim()}”</span>.
            </p>
          )}
        </div>

        <div className="hidden h-9 shrink-0 items-center gap-4 border-t border-line px-4 text-xs text-ink-3 pointer-fine:flex" aria-hidden>
          <span>
            <Key>↑</Key> <Key>↓</Key> {picker ? "to preview" : "to move"}
          </span>
          <span>
            <Key>Enter</Key> {picker ? "to keep" : "to open"}
          </span>
          <span>
            <Key>Esc</Key> {picker ? "to put it back" : "to close"}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

type MessageHit = { key: string; title: string; snippet: string; match: [number, number] };
const NO_HITS: MessageHit[] = [];

/** Message text matching the query across sessions (/api/search), fetched once typing pauses. */
function useMessageSearch(query: string, open: boolean) {
  const q = query.trim();
  const wanted = open && q.length >= 2 && q.length <= 200;
  const [found, setFound] = useState<{ q: string; hits: MessageHit[] } | null>(null);
  useEffect(() => {
    if (!wanted) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(q)}`, { cache: "no-store", signal: ctl.signal })
        .then((res) => (res.ok ? (res.json() as Promise<{ hits?: MessageHit[] }>) : { hits: NO_HITS }))
        .then((data) => setFound({ q, hits: data.hits ?? NO_HITS }))
        .catch(() => {
          if (!ctl.signal.aborted) setFound({ q, hits: NO_HITS });
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [q, wanted]);
  if (!wanted) return { hits: NO_HITS, searching: false };
  return found?.q === q ? { hits: found.hits, searching: false } : { hits: NO_HITS, searching: true };
}

function Snippet({ text, match: [start, end] }: { text: string; match: [number, number] }) {
  return (
    <span className="line-clamp-2 min-w-0 break-words">
      {text.slice(0, start)}
      <mark className="rounded-[3px] bg-accent-tint px-px text-ink">{text.slice(start, end)}</mark>
      {text.slice(end)}
    </span>
  );
}

function Key({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}
