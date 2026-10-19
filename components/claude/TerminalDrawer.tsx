"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, Xmark } from "iconoir-react";
import { shortPath } from "@/lib/client/api";
import { sameTarget, tabNames } from "@/lib/client/terminal-tabs";
import { WebTerminal, type TerminalInfo, type TerminalTarget } from "./WebTerminal";

type Tab = { key: number; target: TerminalTarget };

export const NEW_TERMINAL_COMBO = "Ctrl+Shift+`";

/**
 * The terminal panel (docked or a sheet) with a tab per terminal. Each tab is its own terminal on the
 * server; background tabs stay connected. `openKey` changes with every open request: the request
 * becomes a new tab, or selects the tab already showing that terminal.
 */
export function TerminalDrawer({
  target,
  openKey,
  onClose,
  docked,
  hidden,
  onDock,
}: {
  target: TerminalTarget;
  openKey: number;
  onClose: () => void;
  docked: boolean;
  hidden: boolean;
  onDock: (docked: boolean) => void;
}) {
  const [tabs, setTabs] = useState<Tab[]>(() => [{ key: 0, target }]);
  const [active, setActive] = useState(0);
  const [infos, setInfos] = useState<Record<number, TerminalInfo>>({});
  const nextKey = useRef(1);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const infosRef = useRef(infos);
  infosRef.current = infos;
  const activeRef = useRef(active);
  activeRef.current = active;

  const add = (t: TerminalTarget) => {
    const key = nextKey.current++;
    setTabs((ts) => [...ts, { key, target: t }]);
    setActive(key);
  };
  const seen = useRef(openKey);
  useEffect(() => {
    if (openKey === seen.current) return;
    seen.current = openKey;
    if (target.newTab && !target.cwd) return addShell();
    const hit = !target.newTab && tabsRef.current.find((t) => sameTarget(t.target, target) || (infosRef.current[t.key]?.id && infosRef.current[t.key]?.id === target.term));
    if (hit) setActive(hit.key);
    else add(target);
  }, [openKey, target]);

  /* a new shell where the current tab is */
  const addShell = () => {
    const cur = tabsRef.current.find((t) => t.key === activeRef.current) ?? tabsRef.current[0];
    const cwd = infosRef.current[cur?.key ?? -1]?.cwd || cur?.target.cwd || tabsRef.current[0]?.target.cwd || undefined;
    add({ cwd, label: cwd ? `Shell: ${shortPath(cwd)}` : "Shell" });
  };

  /* a closed tab ends its shell (agents and attached sessions keep running and stay listed under Agents and terminals) */
  const closeTab = (key: number) => {
    const info = infosRef.current[key];
    if (info?.kind === "shell" && info.id && info.conn !== "ended") void fetch("/api/terminals", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: info.id }) }).catch(() => undefined);
    const rest = tabsRef.current.filter((t) => t.key !== key);
    if (!rest.length) return onClose();
    if (activeRef.current === key) {
      const i = tabsRef.current.findIndex((t) => t.key === key);
      setActive(rest[Math.min(i, rest.length - 1)].key);
    }
    setTabs(rest);
    setInfos(({ [key]: _gone, ...keep }) => keep);
  };

  /* each tab draws its own copy of the strip; scroll the shown one to the selected tab */
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      for (const el of document.querySelectorAll<HTMLElement>('[data-terminal-tabs] [aria-selected="true"]'))
        if (el.offsetParent) (el.parentElement ?? el).scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    return () => cancelAnimationFrame(id);
  }, [active, hidden, tabs.length]);

  const names = tabNames(tabs.map((t) => infos[t.key]?.label ?? t.target.label));
  const strip = (
    <div className="flex min-w-0 flex-1 items-center gap-0.5">
      <div role="tablist" aria-label="Terminals" data-terminal-tabs className="no-scrollbar flex min-w-0 items-center gap-0.5 overflow-x-auto">
        {tabs.map((t, i) => {
          const info = infos[t.key];
          const on = t.key === active;
          const dot = info?.conn === "open" ? "bg-green" : info?.conn === "ended" ? "bg-red" : "animate-pulse bg-orange";
          return (
            <div key={t.key} className={`flex h-7 shrink-0 items-center rounded-[7px] transition-colors pointer-coarse:h-9 ${on ? "bg-hover text-ink" : "text-ink-3 hover:text-ink-2"}`}>
              <button
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setActive(t.key)}
                title={info?.label ?? t.target.label}
                className={`flex h-full max-w-[180px] items-center gap-1.5 font-mono text-[12px] ${tabs.length > 1 ? "pr-1 pl-2" : "px-2"}`}
              >
                <span className={`size-1.5 shrink-0 rounded-full ${dot}`} aria-hidden />
                <span className="truncate">{names[i]}</span>
              </button>
              {tabs.length > 1 && (
                <button type="button" onClick={() => closeTab(t.key)} aria-label={`Close ${names[i]}`} className="mr-1 flex size-5 shrink-0 items-center justify-center rounded-[5px] text-ink-3 hover:bg-hover-2 hover:text-ink pointer-coarse:size-7">
                  <Xmark width={11} height={11} strokeWidth={2.2} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button type="button" onClick={addShell} aria-label="New terminal" title={`New terminal (${NEW_TERMINAL_COMBO})`} className="tap relative flex size-7 shrink-0 items-center justify-center rounded-[7px] text-ink-3 hover:bg-hover hover:text-ink">
        <Plus width={14} height={14} strokeWidth={2} />
      </button>
    </div>
  );

  return (
    <>
      {tabs.map((t) => (
        <WebTerminal
          key={t.key}
          target={t.target}
          onClose={onClose}
          docked={docked}
          hidden={hidden || t.key !== active}
          onDock={onDock}
          tabs={strip}
          enter={t.key === 0}
          onInfo={(info) => setInfos((m) => (sameInfo(m[t.key], info) ? m : { ...m, [t.key]: info }))}
        />
      ))}
    </>
  );
}

const sameInfo = (a: TerminalInfo | undefined, b: TerminalInfo) => Boolean(a && a.label === b.label && a.conn === b.conn && a.id === b.id && a.kind === b.kind && a.cwd === b.cwd);
