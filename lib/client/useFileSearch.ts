"use client";

import { useEffect, useRef, useState } from "react";

type Result = { files: string[]; truncated: boolean };

/** Files under `root` ranked for `query` (undefined: not searching). Keeps the last list on screen while the next one loads. */
export function useFileSearch(root: string | undefined, query: string | undefined) {
  const [state, setState] = useState<{ key: string; files: string[]; truncated: boolean; error: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const seen = useRef(new Map<string, Result>());

  useEffect(() => {
    seen.current.clear();
    setState(null);
  }, [root]);

  useEffect(() => {
    if (!root || query === undefined) return;
    const key = `${root}\n${query}`;
    const hit = seen.current.get(key);
    if (hit) {
      setState({ key, ...hit, error: false });
      setLoading(false);
      return;
    }
    const ctl = new AbortController();
    setLoading(true);
    /* a short pause so fast typing sends one request, not one per key */
    const t = setTimeout(() => {
      fetch(`/api/files/search?cwd=${encodeURIComponent(root)}&q=${encodeURIComponent(query)}&limit=50`, { signal: ctl.signal })
        .then((r) => (r.ok ? (r.json() as Promise<Result>) : Promise.reject(new Error(String(r.status)))))
        .then((d) => {
          const res = { files: d.files ?? [], truncated: Boolean(d.truncated) };
          seen.current.set(key, res);
          if (seen.current.size > 100) seen.current.delete(seen.current.keys().next().value!);
          setState({ key, ...res, error: false });
        })
        .catch(() => !ctl.signal.aborted && setState({ key, files: [], truncated: false, error: true }))
        .finally(() => !ctl.signal.aborted && setLoading(false));
    }, 60);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [root, query]);

  const current = state && root && query !== undefined && state.key === `${root}\n${query}`;
  return { files: state?.files ?? [], truncated: state?.truncated ?? false, error: Boolean(current && state?.error), loading: loading || !current };
}
