"use client";

import { useEffect, useRef, useState } from "react";
import type { Entry } from "@/lib/types";
import { contextOf, contextTone, fmtTokens as k, fmtUsd, type SessionCost } from "@/lib/client/usage";

export type ContextUsage = Extract<Entry, { kind: "usage" }>;

export { contextWindow } from "@/lib/client/usage";

/** Event the "Details" button fires; the session screen opens the usage panel on it. */
export const OPEN_USAGE_EVENT = "open-usage";

/**
 * The context the latest turn saw, as a ring in the composer rail; tap or hover for the breakdown.
 * `cost` (from `sessionCost()`) shows the session's cost, actual or est.; without it, `costUsd` is shown as the web run's cost.
 */
export function ContextRing({ usage, costUsd = null, cost = null }: { usage: ContextUsage | null; costUsd?: number | null; cost?: SessionCost | null }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  if (!usage) return null;
  const { used, window: limit, pct } = contextOf(usage);
  const tone = contextTone(pct);
  const shown: SessionCost | null = cost ?? (costUsd !== null ? { usd: costUsd, estimated: false, estUsd: costUsd, actualUsd: costUsd, fallback: false } : null);
  const r = 7;
  const c = 2 * Math.PI * r;
  const rows: [string, number][] = [
    ["Cached", usage.cacheRead],
    ["Newly cached", usage.cacheWrite],
    ["Uncached input", usage.input],
  ];

  return (
    <div ref={ref} className="relative" onMouseEnter={() => matchMedia("(hover: hover)").matches && setOpen(true)} onMouseLeave={() => matchMedia("(hover: hover)").matches && setOpen(false)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Context: ${Math.round(pct * 100)}% used, ${k(used)} of ${k(limit)} tokens`}
        aria-expanded={open}
        className="tap relative flex h-9 items-center gap-1.5 rounded-full px-2 text-xs font-medium text-ink-3 tabular-nums transition-colors duration-150 hover:bg-hover hover:text-ink-2 sm:h-7"
      >
        {/* a filled disc behind the arc, so a low reading looks like a gauge and never like a spinner */}
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden className="-rotate-90">
          <circle cx="9" cy="9" r={r} fill="color-mix(in oklch, var(--ink) 6%, transparent)" stroke="color-mix(in oklch, var(--ink) 16%, transparent)" strokeWidth="2" />
          <circle
            cx="9"
            cy="9"
            r={r}
            fill="none"
            stroke={tone}
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={`${Math.max(pct * c, pct > 0 ? 1.5 : 0)} ${c}`}
            className="transition-[stroke-dasharray] duration-500"
          />
        </svg>
        <span>{Math.round(pct * 100)}%</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Context usage"
          className="absolute right-0 bottom-full z-30 mb-2 w-64 rounded-xl bg-popover p-3.5 text-sm shadow-overlay"
          style={{ animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "bottom right" }}
        >
          <div className="flex items-baseline justify-between">
            <span className="font-medium text-ink">Context</span>
            <span className="text-ink-2 tabular-nums">
              {k(used)} / {k(limit)}
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-inset">
            <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${pct * 100}%`, background: tone }} />
          </div>
          <dl className="mt-3 flex flex-col gap-1.5">
            {rows.map(([label, n]) => (
              <div key={label} className="flex justify-between">
                <dt className="text-ink-3">{label}</dt>
                <dd className="text-ink-2 tabular-nums">{k(n)}</dd>
              </div>
            ))}
            <div className="flex justify-between border-t border-line pt-1.5">
              <dt className="text-ink-3">Last reply</dt>
              <dd className="text-ink-2 tabular-nums">{k(usage.output)} out</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-3">Free</dt>
              <dd className="text-ink-2 tabular-nums">
                {k(Math.max(0, limit - used))} ({Math.round((1 - pct) * 100)}%)
              </dd>
            </div>
          </dl>
          {shown && (
            <div className="mt-1.5 flex justify-between text-sm">
              <span className="text-ink-3">Cost</span>
              <span className="text-ink-2 tabular-nums" title={shown.estimated ? "Estimate at list prices" : "Reported"}>
                {fmtUsd(shown.usd)}
                {shown.estimated && <span className="ml-1 text-ink-3">est.</span>}
              </span>
            </div>
          )}
          {pct >= 0.8 && <p className="mt-1.5 text-xs text-orange-ink">Almost full. Run /compact.</p>}
          <div className="mt-2.5 flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-3">{usage.model}</p>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                window.dispatchEvent(new Event(OPEN_USAGE_EVENT));
              }}
              className="-my-1 -mr-1 shrink-0 rounded-[7px] px-2 py-1 text-xs font-medium text-ink-2 transition-colors duration-100 hover:bg-hover hover:text-ink"
            >
              Details
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
