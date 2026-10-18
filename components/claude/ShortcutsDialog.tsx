"use client";

import { useEffect, useState } from "react";
import { Sheet } from "./Sheet";
import { OPEN_SHORTCUTS_EVENT } from "./CommandPalette";
import { Kbd } from "@/components/atoms/Kbd";
import { isTyping, SHORTCUTS, type Shortcut } from "@/lib/client/shortcuts";

const GROUPS: Shortcut["group"][] = ["General", "Sessions", "Panels", "Composer"];

export function ShortcutList() {
  return (
    <div className="flex flex-col gap-5">
      {GROUPS.map((g) => (
        <section key={g}>
          <h3 className="mb-1 text-[12px] font-medium text-ink-3">{g}</h3>
          <ul className="divide-y divide-line">
            {SHORTCUTS.filter((s) => s.group === g).map((s) => (
              <li key={s.id} className="flex min-h-9 items-center justify-between gap-3 py-1.5 text-[13px] text-ink">
                <span className="min-w-0">{s.label}</span>
                <Kbd keys={s.keys} className="!inline-flex" />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** The shortcuts sheet: "?" outside a text field, or from the palette. */
export function ShortcutsDialog() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "?" || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || isTyping(e.target)) return;
      e.preventDefault();
      setOpen((o) => !o);
    };
    window.addEventListener(OPEN_SHORTCUTS_EVENT, show);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener(OPEN_SHORTCUTS_EVENT, show);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  if (!open) return null;
  return (
    <Sheet title="Keyboard shortcuts" onClose={() => setOpen(false)}>
      <ShortcutList />
    </Sheet>
  );
}
