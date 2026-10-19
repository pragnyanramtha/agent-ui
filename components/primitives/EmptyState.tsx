"use client";

import type { ReactNode } from "react";

/* One look for every "nothing here" and "couldn't" spot: what happened, then what to do about it.
 * `panel` centers in a screen; `inline` sits left-aligned in narrow columns like the sidebar. */

export type EmptyAction = { label: string; onClick: () => void; primary?: boolean; disabled?: boolean };

const BTN = {
  panel: {
    primary: "tap relative inline-flex h-9 items-center justify-center rounded-full bg-ink px-4 text-sm font-medium text-page transition-opacity duration-150 hover:opacity-90 disabled:opacity-50",
    secondary: "tap relative inline-flex h-9 items-center justify-center rounded-full px-3.5 text-sm font-medium text-ink shadow-btn transition-colors duration-150 hover:bg-hover disabled:opacity-50",
  },
  inline: {
    primary: "tap relative inline-flex h-7 items-center justify-center rounded-full bg-ink px-3 text-xs font-medium text-page transition-opacity duration-150 hover:opacity-90 disabled:opacity-50 pointer-coarse:h-9",
    secondary: "tap relative inline-flex h-7 items-center justify-center rounded-full px-2.5 text-xs font-medium text-ink shadow-btn transition-colors duration-150 hover:bg-hover disabled:opacity-50 pointer-coarse:h-9",
  },
} as const;

export function EmptyState({
  icon,
  title,
  body,
  actions = [],
  tone = "neutral",
  size = "panel",
  announce = false,
  className = "",
}: {
  icon?: ReactNode;
  title: ReactNode;
  body?: ReactNode;
  actions?: EmptyAction[];
  tone?: "neutral" | "error";
  size?: "panel" | "inline";
  /** read out when it appears (search results); errors always are */
  announce?: boolean;
  className?: string;
}) {
  const panel = size === "panel";
  const error = tone === "error";
  const tile = error ? "bg-red-tint text-red-ink" : "bg-surface text-ink-3 shadow-hairline";
  return (
    <div
      role={error ? "alert" : announce ? "status" : undefined}
      data-empty={tone}
      className={`flex min-w-0 flex-col ${panel ? "items-center gap-3 px-4 py-12 text-center text-balance" : "items-start gap-2 px-2.5 py-2"} ${className}`}
      style={{ animation: "fade-in 200ms ease both" }}
    >
      {icon && (
        <span aria-hidden className={`grid shrink-0 place-items-center ${panel ? "size-10 rounded-[12px]" : "size-8 rounded-[10px]"} ${tile}`}>
          {icon}
        </span>
      )}
      <div className={`flex min-w-0 flex-col gap-1 ${panel ? "max-w-[44ch] items-center" : ""}`}>
        <p className={`font-medium [overflow-wrap:anywhere] ${panel ? "text-base text-ink" : "text-sm text-ink-2"}`}>{title}</p>
        {body && <p className="text-sm leading-snug text-ink-3 [overflow-wrap:anywhere]">{body}</p>}
      </div>
      {actions.length > 0 && (
        <div className={`flex flex-wrap gap-2 ${panel ? "justify-center pt-1" : "pt-0.5"}`}>
          {actions.map((a) => (
            <button key={a.label} type="button" onClick={a.onClick} disabled={a.disabled} className={BTN[size][a.primary ? "primary" : "secondary"]}>
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
