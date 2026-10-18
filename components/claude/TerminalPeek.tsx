"use client";

import { useEffect, useRef, useState } from "react";
import { Xmark } from "iconoir-react";
import { OPEN_TERMINAL_EVENT } from "./CommandPalette";

type Prompt = { ok: true } | { ok: false; code: "agent_focus"; agent: string } | { ok: false; code: "has_text"; text: string } | { ok: false; code: "no_prompt" };

const promptLabel = (p: Prompt | null) =>
  !p
    ? null
    : p.ok
      ? { text: "Ready", tone: "text-green" }
      : p.code === "agent_focus"
        ? { text: `@${p.agent} has focus. Switch to main first.`, tone: "text-orange-ink" }
        : p.code === "has_text"
          ? { text: "Unsent text in the prompt. Send or clear it first.", tone: "text-orange-ink" }
          : { text: "A dialog is open. Answer it first.", tone: "text-orange-ink" };

const KEYS: [string, string, string][] = [
  ["Escape", "Esc", "Stop or close dialog"],
  ["1", "1", "Pick option 1"],
  ["2", "2", "Pick option 2"],
  ["3", "3", "Pick option 3"],
  ["Up", "↑", "Up"],
  ["Down", "↓", "Down"],
  ["Enter", "Enter", "Confirm"],
  ["ShiftTab", "⇧Tab", "Change approval mode"],
];

/** A live look at the terminal pane the session runs in, refreshed every 2s while open, with keys for dialogs. */
export function TerminalPeek({ id, pid, where, onClose }: { id: string; pid?: number; where: string; onClose: () => void }) {
  const [screen, setScreen] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const press = async (key: string) => {
    setKeyError(null);
    const res = await fetch(`/api/sessions/${id}/keys`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) }).catch(() => null);
    if (!res?.ok) setKeyError(((await res?.json().catch(() => null)) as { error?: string } | null)?.error ?? "Couldn't press the key.");
  };

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const res = await fetch(`/api/sessions/${id}/screen`, { cache: "no-store" });
        const data = (await res.json()) as { screen?: string; prompt?: Prompt; error?: string };
        if (!alive) return;
        if (!res.ok) setError(data.error ?? "Couldn't read the terminal.");
        else {
          setError(null);
          setScreen(data.screen ?? "");
          setPrompt(data.prompt ?? null);
        }
      } catch {
        if (alive) setError("Couldn't reach the server.");
      }
      if (alive && document.visibilityState === "visible") timer = setTimeout(tick, 2000);
      else if (alive) timer = setTimeout(tick, 6000);
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id]);

  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [screen]);

  const label = promptLabel(prompt);
  return (
    <div className="border-b border-line bg-inset" style={{ animation: "fade-up 220ms cubic-bezier(0.23,1,0.32,1) both" }}>
      <div className="flex h-9 items-center gap-2 px-3 text-[12px] sm:px-4">
        <span className="font-medium text-ink-2">Terminal</span>
        {label && <span className={`hidden min-w-0 truncate md:inline ${label.tone}`}>· {label.text}</span>}
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent(OPEN_TERMINAL_EVENT, { detail: { session: id, pid, label: where } }))}
          className="tap relative ml-auto shrink-0 rounded-full bg-ink px-3 py-1 text-[11.5px] font-medium text-page hover:opacity-90"
        >
          Open in terminal
        </button>
        <button type="button" onClick={onClose} aria-label="Close preview" className="tap relative flex size-7 shrink-0 items-center justify-center rounded-[7px] text-ink-3 hover:bg-hover hover:text-ink">
          <Xmark width={14} height={14} strokeWidth={2} />
        </button>
      </div>
      {label && <p className={`px-3 pb-1.5 text-[11.5px] md:hidden ${label.tone}`}>{label.text}</p>}
      <div className="no-scrollbar flex items-center gap-1 overflow-x-auto px-3 pb-2 sm:px-4" role="toolbar" aria-label="Terminal keys">
        {KEYS.map(([key, text, hint]) => (
          <button
            key={key}
            type="button"
            title={hint}
            onClick={() => void press(key)}
            className="tap relative h-7 shrink-0 rounded-[7px] bg-surface px-2.5 font-mono text-[11.5px] text-ink-2 shadow-hairline transition-colors hover:bg-hover hover:text-ink active:scale-[0.96]"
          >
            {text}
          </button>
        ))}
        {keyError && <span className="ml-1 shrink-0 text-[11.5px] text-red-ink">{keyError}</span>}
      </div>
      <pre
        ref={preRef}
        tabIndex={0}
        translate="no"
        aria-label="Terminal screen"
        className="max-h-[38dvh] overflow-auto overscroll-contain border-t border-line bg-page px-3 py-2 font-mono text-[10.5px] leading-[1.45] whitespace-pre text-ink-2 sm:px-4 sm:text-[11.5px]"
      >
        {error ? <span className="text-red-ink">{error}</span> : screen ?? "Reading the terminal…"}
      </pre>
    </div>
  );
}
