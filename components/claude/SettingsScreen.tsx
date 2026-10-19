"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Menu, NavArrowLeft, NavArrowRight, Search, Xmark } from "iconoir-react";
import { OPEN_SETTINGS_SECTION_EVENT, resetSection, sectionIsDefault, setSettings, useSettings } from "@/lib/client/settings";
import { toast } from "@/lib/client/toast";
import { SECTIONS, searchSettings, sectionInfo, settingsIn, type SectionId, type Settings } from "@/lib/settings-schema";
import { Row, SmallButton } from "./settings/controls";
import { SettingField } from "./settings/SettingField";
import { SECTION_ICONS, SectionBody } from "./settings/sections";

const LAST_KEY = "cui:settings-section";

function SectionHeader({ id }: { id: SectionId }) {
  const values = useSettings();
  const info = sectionInfo(id);
  const own = settingsIn(id);
  const atDefault = sectionIsDefault(values, id);
  const reset = () => {
    const before = Object.fromEntries(own.map((d) => [d.key, values[d.key]])) as Partial<Settings>;
    resetSection(id);
    toast({ key: "reset-section", tone: "success", title: `${info.label} settings reset`, action: { label: "Undo", run: () => setSettings(before) } });
  };
  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-2 px-1">
      <div className="min-w-0 flex-1">
        <h2 className="text-[17px] font-semibold max-md:sr-only tracking-[-0.015em] text-ink">{info.label}</h2>
        <p className="mt-0.5 text-sm text-ink-3">{info.description}</p>
      </div>
      {own.length > 0 && (
        <SmallButton disabled={atDefault} onClick={reset}>
          Reset to defaults
        </SmallButton>
      )}
    </div>
  );
}

function SearchField({ value, onChange, inputRef }: { value: string; onChange: (v: string) => void; inputRef: React.RefObject<HTMLInputElement | null> }) {
  return (
    <div className="field-ring relative flex h-9 items-center gap-2 rounded-control border border-line bg-field px-2.5 md:h-8">
      <Search width={14} height={14} strokeWidth={2} className="shrink-0 text-ink-3" aria-hidden />
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && value && (e.preventDefault(), onChange(""))}
        placeholder="Search settings"
        aria-label="Search settings"
        className="min-w-0 flex-1 bg-transparent text-[16px] text-ink outline-none placeholder:text-ink-3 md:text-sm md:pointer-coarse:text-[16px] [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button type="button" aria-label="Clear search" onClick={() => onChange("")} className="tap relative -mr-1 flex size-6 items-center justify-center rounded-[6px] text-ink-3 hover:bg-hover hover:text-ink">
          <Xmark width={14} height={14} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}

function Results({ query, onOpen }: { query: string; onOpen: (id: SectionId) => void }) {
  const hits = searchSettings(query);
  if (!hits.length) return <p className="px-1 py-10 text-center text-sm text-ink-3">No settings match &ldquo;{query.trim()}&rdquo;.</p>;
  return (
    <>
      {hits.map((h) => {
        const info = sectionInfo(h.section);
        return (
          <section key={h.section} className="flex flex-col">
            <div className="flex items-center px-1 pb-2">
              <h3 className="flex-1 text-xs font-medium text-ink-3">{info.label}</h3>
              <button type="button" onClick={() => onOpen(h.section)} className="tap relative text-xs font-medium text-accent-ink hover:underline">
                Open {info.label}
              </button>
            </div>
            <div className="divide-y divide-line rounded-card border border-line bg-surface">
              {h.settings.map((k) => (
                <SettingField key={k} k={k} />
              ))}
              {h.items.map((id) => {
                const item = info.items!.find((i) => i.id === id)!;
                return (
                  <Row key={id} label={item.label} note={item.description}>
                    <SmallButton onClick={() => onOpen(h.section)}>Open</SmallButton>
                  </Row>
                );
              })}
            </div>
          </section>
        );
      })}
    </>
  );
}

/** Settings: a section list beside the open section on wide screens; on phones the list opens each section as a page. */
export function SettingsScreen({ onMenu, extra, onAgents }: { onMenu: () => void; extra?: ReactNode; onAgents: () => void }) {
  const [section, setSection] = useState<SectionId>("general");
  /* phones only: a section page is open instead of the list */
  const [paged, setPaged] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const saved = sessionStorage.getItem(LAST_KEY) as SectionId | null;
    if (saved && SECTIONS.some((s) => s.id === saved)) setSection(saved);
  }, []);

  const open = (id: SectionId) => {
    setSection(id);
    setPaged(true);
    setQuery("");
    sessionStorage.setItem(LAST_KEY, id);
    contentRef.current?.scrollTo({ top: 0 });
  };

  useEffect(() => {
    const on = (e: Event) => {
      const id = (e as CustomEvent<string>).detail as SectionId;
      if (!SECTIONS.some((x) => x.id === id)) return;
      setSection(id);
      setPaged(true);
      setQuery("");
      contentRef.current?.scrollTo({ top: 0 });
    };
    window.addEventListener(OPEN_SETTINGS_SECTION_EVENT, on);
    return () => window.removeEventListener(OPEN_SETTINGS_SECTION_EVENT, on);
  }, []);

  /* "/" or Ctrl/Cmd+F jumps to the search field */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t?.closest("input, textarea, select, [contenteditable]");
      if ((e.key === "/" && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f")) {
        if (!searchRef.current?.offsetParent) return;
        e.preventDefault();
        searchRef.current.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const searching = query.trim().length > 0;
  const info = sectionInfo(section);

  return (
    <section className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="on-page safe-top safe-x flex shrink-0 items-center bg-page">
        <div className="flex h-14 w-full min-w-0 items-center gap-1 px-1.5 sm:px-3 lg:h-[52px]">
          <button type="button" onClick={onMenu} aria-label="Open sessions" aria-haspopup="dialog" data-drawer-opener className="icon-btn lg:hidden">
            <Menu width={19} height={19} strokeWidth={1.8} />
          </button>
          {paged && !searching && (
            <button type="button" onClick={() => setPaged(false)} aria-label="All settings" className="icon-btn md:hidden">
              <NavArrowLeft width={19} height={19} strokeWidth={1.9} />
            </button>
          )}
          <h1 className="min-w-0 flex-1 truncate px-1.5 text-md font-medium tracking-[-0.01em] text-ink sm:text-base">
            <span className={paged && !searching ? "hidden md:inline" : ""}>Settings</span>
            {paged && !searching && <span className="md:hidden">{info.label}</span>}
          </h1>
          {extra}
        </div>
      </header>

      <div className="safe-x min-h-0 flex-1 overflow-y-auto overscroll-contain md:flex md:overflow-hidden">
        <nav aria-label="Settings sections" className={`shrink-0 flex-col gap-3 px-3 pt-2 pb-4 md:flex md:w-60 md:overflow-y-auto md:border-r md:border-line md:px-2.5 md:pb-6 ${paged && !searching ? "hidden" : "flex"}`}>
          <SearchField value={query} onChange={setQuery} inputRef={searchRef} />
          <ul className={`flex-col gap-px md:flex ${searching ? "hidden" : "flex"} max-md:divide-y max-md:divide-line max-md:rounded-card max-md:border max-md:border-line max-md:bg-surface`}>
            {SECTIONS.map((s) => {
              const Icon = SECTION_ICONS[s.id];
              const current = s.id === section;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => open(s.id)}
                    aria-current={current ? "page" : undefined}
                    className={`tap relative flex w-full items-center gap-3 text-left text-ink max-md:min-h-13 max-md:px-3.5 max-md:py-2.5 md:h-8 md:gap-2.5 md:rounded-control md:px-2.5 md:text-sm ${
                      current ? "md:bg-sidebar-active md:font-medium" : "md:text-ink-2 md:hover:bg-hover md:hover:text-ink"
                    }`}
                  >
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-control bg-field text-ink-2 md:size-4 md:bg-transparent md:text-current">
                      <Icon width={15} height={15} strokeWidth={1.8} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-base md:text-sm">{s.label}</span>
                      <span className="block truncate text-xs text-ink-3 md:hidden">{s.description}</span>
                    </span>
                    <NavArrowRight width={15} height={15} strokeWidth={1.9} className="shrink-0 text-ink-3 md:hidden" aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <div ref={contentRef} className={`safe-bottom min-w-0 md:block md:flex-1 md:overflow-y-auto md:overscroll-contain ${paged || searching ? "block" : "hidden"}`}>
          <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-3 pt-2 pb-16 sm:px-6 md:pt-6">
            {searching ? (
              <Results query={query} onOpen={open} />
            ) : (
              <>
                <SectionHeader id={section} />
                <SectionBody id={section} onAgents={onAgents} />
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
