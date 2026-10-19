"use client";

import { Fragment, useEffect, useState } from "react";
import { Sheet } from "./Sheet";
import { OPEN_SHORTCUTS_EVENT } from "@/lib/client/events";
import { Kbd } from "@/components/atoms/Kbd";
import { COMMAND_GROUPS, COMMANDS, isCustom, keysFor, type CommandId } from "@/lib/keybindings";
import { isCommand, isTyping, useBindings } from "@/lib/client/shortcuts";

const TABS = ["tab1", "tab2", "tab3", "tab4", "tab5", "tab6", "tab7", "tab8"] as const satisfies readonly CommandId[];

/** Every command and its current keys, read-only. */
export function ShortcutList() {
  const bindings = useBindings();
  /* "Go to tab 1" to "8" read as one row while they're the defaults */
  const tabsFolded = TABS.every((id) => !isCustom(id, bindings));
  return (
    <div className="flex flex-col gap-5">
      {COMMAND_GROUPS.map((g) => (
        <section key={g}>
          <h3 className="mb-1 text-[12px] font-medium text-ink-3">{g}</h3>
          <ul className="divide-y divide-line">
            {COMMANDS.filter((c) => c.group === g && !(tabsFolded && TABS.includes(c.id as (typeof TABS)[number]) && c.id !== "tab1")).map((c) => {
              const keys = keysFor(c.id, bindings);
              const folded = tabsFolded && c.id === "tab1";
              return (
                <li key={c.id} className="flex min-h-9 items-center justify-between gap-3 py-1.5 text-[13px] text-ink">
                  <span className="min-w-0">{folded ? "Go to tab 1 to 8" : c.label}</span>
                  <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-ink-3">
                    {folded ? (
                      <>
                        <Kbd chord={keys[0]} className="!inline-flex" />
                        <span aria-hidden>to</span>
                        <Kbd chord={keysFor("tab8", bindings)[0]} className="!inline-flex" />
                      </>
                    ) : keys.length ? (
                      keys.map((k, i) => (
                        <Fragment key={k}>
                          {i > 0 && <span aria-hidden>or</span>}
                          <Kbd chord={k} className="!inline-flex" />
                        </Fragment>
                      ))
                    ) : (
                      <span>None</span>
                    )}
                  </span>
                </li>
              );
            })}
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
      if (e.defaultPrevented || isTyping(e.target) || !isCommand(e, "shortcuts")) return;
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
      <p className="pt-4 text-[12px] text-ink-3">Change them in Settings, under Keyboard.</p>
    </Sheet>
  );
}
