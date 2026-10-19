"use client";

import { useLayoutEffect, useState } from "react";
import { CheckCircle, InfoCircle, WarningCircle, WarningTriangle, Xmark } from "iconoir-react";
import { dismissToast, holdToasts, useToasts, type Toast } from "@/lib/client/toast";

/* The toast stack: top of the screen on phones (newest first), bottom right on wider screens (newest nearest the
 * corner). Hovering or focusing it stops the clocks. Reduced motion drops the animation (app/globals.css). */

const ICON = {
  info: { Icon: InfoCircle, cls: "text-ink-3" },
  success: { Icon: CheckCircle, cls: "text-green" },
  warning: { Icon: WarningTriangle, cls: "text-orange-ink" },
  error: { Icon: WarningCircle, cls: "text-red-ink" },
} as const;

function Item({ t }: { t: Toast }) {
  const { Icon, cls } = ICON[t.tone];
  return (
    <li
      className="pointer-events-auto flex w-full items-start gap-2.5 rounded-card border border-line bg-surface py-2.5 pr-1.5 pl-3 text-ink shadow-overlay transition-[opacity,transform] duration-150 ease-out"
      style={{
        animation: "pop-in 200ms cubic-bezier(0.23, 1, 0.32, 1) both",
        opacity: t.leaving ? 0 : 1,
        transform: t.leaving ? "scale(0.97)" : undefined,
      }}
      data-tone={t.tone}
    >
      <Icon width={17} height={17} strokeWidth={1.9} className={`mt-px shrink-0 ${cls}`} aria-hidden />
      <div className="min-w-0 flex-1 py-px">
        <p className="text-sm leading-snug font-medium [overflow-wrap:anywhere]">{t.title}</p>
        {t.body && <p className="mt-0.5 line-clamp-2 text-sm leading-snug text-ink-3 [overflow-wrap:anywhere]">{t.body}</p>}
      </div>
      {t.action && (
        <button
          type="button"
          onClick={() => {
            t.action?.run();
            dismissToast(t.id);
          }}
          className="tap relative -my-0.5 shrink-0 rounded-control px-2.5 py-1 text-sm font-medium text-accent-ink hover:bg-hover"
        >
          {t.action.label}
        </button>
      )}
      <button type="button" aria-label="Dismiss" onClick={() => dismissToast(t.id)} className="tap relative -my-0.5 flex size-6 shrink-0 items-center justify-center rounded-[6px] text-ink-3 hover:bg-hover hover:text-ink">
        <Xmark width={14} height={14} strokeWidth={2} aria-hidden />
      </button>
    </li>
  );
}

/** the stack's width plus its gap from the right edge (md:w-[360px], md:right-4) */
const STACK_PX = 376;

/** On wide screens, how far to raise the stack so it sits above a composer it would cover. */
function useLift(active: boolean) {
  const [lift, setLift] = useState(0);
  useLayoutEffect(() => {
    if (!active) return;
    const wide = window.matchMedia("(min-width: 768px)");
    const measure = () => {
      const r = document.querySelector("#session-panel [data-composer]")?.getBoundingClientRect();
      const covers = wide.matches && r && r.height > 0 && r.right > window.innerWidth - STACK_PX && r.bottom > window.innerHeight - 160;
      setLift(covers ? Math.round(window.innerHeight - r.top + 12) : 0);
    };
    measure();
    window.addEventListener("resize", measure);
    /* the composer grows with a long draft, and the panel narrows when the side panel opens */
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    for (const el of [document.getElementById("session-panel"), document.querySelector("#session-panel [data-composer]")]) if (el) ro?.observe(el);
    return () => {
      window.removeEventListener("resize", measure);
      ro?.disconnect();
    };
  }, [active]);
  return lift;
}

export function Toaster() {
  const toasts = useToasts();
  const lift = useLift(toasts.length > 0);
  return (
    <section
      aria-label="Notifications"
      data-toaster
      style={lift ? { bottom: lift } : undefined}
      className="pointer-events-none fixed inset-x-0 top-[max(0.5rem,env(safe-area-inset-top))] z-[70] flex justify-center px-3 md:inset-x-auto md:top-auto md:right-4 md:bottom-4 md:px-0"
    >
      <ol
        aria-live="polite"
        className="flex w-full max-w-[420px] flex-col-reverse gap-2 md:w-[360px] md:flex-col"
        onPointerEnter={() => holdToasts(true)}
        onPointerLeave={() => holdToasts(false)}
        onFocus={() => holdToasts(true)}
        onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && holdToasts(false)}
      >
        {toasts.map((t) => (
          <Item key={`${t.id}`} t={t} />
        ))}
      </ol>
    </section>
  );
}
