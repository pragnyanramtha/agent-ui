"use client";

import { useEffect, useState } from "react";
import { chordParts } from "@/lib/keybindings";
import { isMac } from "@/lib/client/shortcuts";

/** Key caps for a shortcut ("Mod+K"), in this platform's notation. Mouse and trackpad devices only. */
export function Kbd({ chord, className = "" }: { chord: string; className?: string }) {
  /* the server can't know the platform; render after mount so Mac glyphs don't mismatch */
  const [mac, setMac] = useState<boolean | null>(null);
  useEffect(() => setMac(isMac()), []);
  if (mac === null) return null;
  return (
    <span className={`hidden shrink-0 items-center gap-0.5 pointer-fine:inline-flex ${className}`} aria-hidden>
      {chordParts(chord, mac).map((k, i) => (
        <kbd key={i} className="kbd">
          {k}
        </kbd>
      ))}
    </span>
  );
}
