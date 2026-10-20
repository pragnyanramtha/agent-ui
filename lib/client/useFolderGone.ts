"use client";

import { useCallback, useEffect, useState } from "react";

/** Whether `dir` was moved or deleted on the server: true only on a clear "not there" (404), never on a network blip
 * or a permission error. Checked when `dir` changes, when the tab comes back, and on `check()`. */
export function useFolderGone(dir: string) {
  const [gone, setGone] = useState(false);
  const [checking, setChecking] = useState(false);

  const check = useCallback(async () => {
    if (!dir) return setGone(false);
    setChecking(true);
    try {
      const res = await fetch(`/api/fs?stat=1&path=${encodeURIComponent(dir)}`, { cache: "no-store" });
      await res.text().catch(() => "");
      if (res.ok) setGone(false);
      else if (res.status === 404) setGone(true);
    } catch {
      /* offline: say nothing new */
    } finally {
      setChecking(false);
    }
  }, [dir]);

  useEffect(() => {
    setGone(false);
    void check();
    const onShow = () => document.visibilityState === "visible" && void check();
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, [check]);

  return { gone, checking, check };
}
