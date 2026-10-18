"use client";

import { useEffect, useState } from "react";
import { isMac, keyLabels } from "@/lib/client/shortcuts";

/** Key caps for a shortcut, in this platform's notation. Mouse and trackpad devices only. */
export function Kbd({ keys, className = "" }: { keys: string[]; className?: string }) {
  /* the server can't know the platform; render after mount so Mac glyphs don't mismatch */
  const [mac, setMac] = useState<boolean | null>(null);
  useEffect(() => setMac(isMac()), []);
  if (mac === null) return null;
  return (
    <span className={`hidden shrink-0 items-center gap-0.5 pointer-fine:inline-flex ${className}`} aria-hidden>
      {keyLabels(keys, mac).map((k, i) => (
        <kbd
          key={i}
          className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border border-line bg-field px-1 font-sans text-[11px] leading-none text-ink-3 tabular-nums"
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}
