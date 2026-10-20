"use client";

import { useEffect, useRef, useState, type ComponentType } from "react";
import { Bug, CheckCircle, Flask, Hammer, Play, Rocket, Terminal } from "iconoir-react";
import type { ActionIcon } from "@/lib/projects";
import { ApiError } from "@/lib/client/api";
import { runAction, useProjectFor } from "@/lib/client/projects";
import { openServerTerminal } from "@/lib/client/terminals";
import { toast } from "@/lib/client/toast";

type Icon = ComponentType<{ width?: number; height?: number; strokeWidth?: number; className?: string; "aria-hidden"?: boolean }>;
export const ACTION_ICON: Record<ActionIcon, Icon> = { play: Play, test: Flask, build: Hammer, lint: CheckCircle, debug: Bug, deploy: Rocket, terminal: Terminal };
export const ACTION_ICON_LABEL: Record<ActionIcon, string> = { play: "Play", test: "Test", build: "Build", lint: "Check", debug: "Debug", deploy: "Deploy", terminal: "Terminal" };

/** The session header's Run button: the folder's project actions (Settings > Projects), each opening a terminal. */
export function RunMenu({ cwd, className }: { cwd: string; className: string }) {
  const { project } = useProjectFor(cwd);
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    const away = (e: Event) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("focusin", away);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("focusin", away);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const actions = project?.actions ?? [];
  if (!actions.length) return null;

  const run = async (id: string, name: string) => {
    setOpen(false);
    setRunning(id);
    try {
      const t = await runAction(cwd, id);
      openServerTerminal(t, `${name}: ${t.cwd.split("/").filter(Boolean).pop() ?? t.cwd}`);
    } catch (err) {
      toast({ key: "run-action", tone: "error", title: `Couldn't run ${name}`, body: err instanceof ApiError ? err.message : "Couldn't reach the server." });
    } finally {
      setRunning(null);
    }
  };

  return (
    <div ref={wrap} className="relative flex h-full shrink-0">
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Run an action"
        data-tip="Run"
        data-tip-pos="bottom"
        disabled={running !== null}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={className}
      >
        <Play width={16} height={16} strokeWidth={1.6} />
        <span className="max-sm:sr-only @max-[44rem]:sr-only">{running ? "Starting…" : "Run"}</span>
      </button>
      {open && (
        <div
          ref={menu}
          role="menu"
          aria-label="Run an action"
          onKeyDown={(e) => {
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            e.preventDefault();
            const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
            const i = items.indexOf(document.activeElement as HTMLElement);
            items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
          }}
          className="absolute top-full right-0 z-30 mt-1.5 w-72 max-w-[calc(100vw-1rem)] rounded-[12px] bg-surface p-1 shadow-overlay"
          style={{ animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "top right" }}
        >
          <p className="truncate px-2.5 pt-1.5 pb-1 text-xs font-medium text-ink-3">{project?.name ?? "Actions"}</p>
          {actions.map((a) => {
            const I = ACTION_ICON[a.icon] ?? Play;
            return (
              <button key={a.id} type="button" role="menuitem" onClick={() => void run(a.id, a.name)} title={a.command} className="menu-item items-start">
                <I width={15} height={15} strokeWidth={1.8} className="mt-0.5 shrink-0 text-ink-3" aria-hidden />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{a.name}</span>
                  <span className="truncate font-mono text-2xs text-ink-3" translate="no">
                    {a.command}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
