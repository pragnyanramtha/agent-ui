"use client";

import { useEffect, useRef } from "react";
import { parseShareParam, type Shared } from "@/lib/share";
import { toast } from "./toast";

/* A share from another app lands on `/?s=new&share=<id>`. The landing fetches it once and hands it to the
 * new-session composer, which may mount before or after the fetch ends. */

const SHARED_EVENT = "agent-u:shared";
let waiting: Shared | null = null;

/** Reads `?share=` on the first load (before the tabs rewrite the address) and opens a new session with it. */
export function useShareLanding(openNew: () => void) {
  const open = useRef(openNew);
  open.current = openNew;
  useEffect(() => {
    const want = parseShareParam(window.location.search);
    if (!want) return;
    if ("error" in want) {
      toast({ title: "That's too large to share here.", body: "Upload it in Files instead.", tone: "error" });
      return;
    }
    let gone = false;
    fetch(`/api/share?id=${want.id}`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<Shared>) : null))
      .catch(() => null)
      .then((shared) => {
        if (gone) return;
        if (!shared) return void toast({ title: "Couldn't load what was shared.", tone: "error" });
        waiting = shared;
        open.current();
        window.dispatchEvent(new Event(SHARED_EVENT));
      });
    return () => {
      gone = true;
    };
  }, []);
}

/** In the new-session composer: takes a waiting share (now or when it arrives) and puts it in the box. */
export function useSharedDraft(enabled: boolean, apply: (shared: Shared) => void) {
  const fn = useRef(apply);
  fn.current = apply;
  useEffect(() => {
    if (!enabled) return;
    const take = () => {
      const shared = waiting;
      waiting = null;
      if (shared) fn.current(shared);
    };
    take();
    window.addEventListener(SHARED_EVENT, take);
    return () => window.removeEventListener(SHARED_EVENT, take);
  }, [enabled]);
}
