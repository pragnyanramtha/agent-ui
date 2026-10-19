"use client";

import { useLayoutEffect, useState, type RefObject } from "react";
import { EditPencil } from "iconoir-react";

/** The folded composer (lib/client/useComposerCollapse.ts): one line with the draft or the placeholder. A tap puts
 * the caret back in the box. */
export function ComposerPill({ shown, composer, onOpen }: { shown: boolean; composer: RefObject<HTMLElement | null>; onOpen: () => void }) {
  const [label, setLabel] = useState("");
  useLayoutEffect(() => {
    if (!shown) return;
    const box = composer.current?.querySelector("textarea");
    setLabel(box?.value.trim().split("\n")[0] || box?.placeholder || "Write a message…");
  }, [shown, composer]);
  return (
    <div
      className="safe-bottom safe-x pointer-events-none absolute inset-x-0 bottom-0 z-10 px-3 pb-3 transition-[transform,opacity] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)]"
      style={{ opacity: shown ? 1 : 0, transform: shown ? "none" : "translateY(12px)" }}
      aria-hidden={!shown}
      inert={!shown}
    >
      <button
        type="button"
        onClick={() => {
          /* in the tap itself, so a phone opens its keyboard */
          composer.current?.querySelector("textarea")?.focus({ preventScroll: true });
          onOpen();
        }}
        className={`mx-auto flex h-11 w-full max-w-(--thread-w) items-center gap-2.5 rounded-full bg-surface px-4 text-left text-md text-ink-3 shadow-overlay ${shown ? "pointer-events-auto" : ""}`}
      >
        <EditPencil width={16} height={16} strokeWidth={1.8} className="shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{label}</span>
      </button>
    </div>
  );
}
