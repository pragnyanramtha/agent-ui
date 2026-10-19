"use client";

import { useEffect, useReducer, type ComponentType, type ReactNode } from "react";

export type LazyComponent<P> = ComponentType<P> & { preload: () => Promise<void> };

/**
 * A component whose code loads on first use (or on `preload()`), without Suspense: once the module is in memory it
 * renders straight away, where next/dynamic and React.lazy suspend at least once and React then holds the content
 * back behind its fallback for about 300 ms. A failed load is retried on the next mount.
 */
export function lazyComponent<P extends object>(load: () => Promise<ComponentType<P>>, fallback: () => ReactNode = () => null): LazyComponent<P> {
  let Loaded: ComponentType<P> | null = null;
  let pending: Promise<void> | null = null;
  const preload = () =>
    (pending ??= load().then(
      (C) => {
        Loaded = C;
      },
      (err: unknown) => {
        pending = null;
        throw err;
      },
    ));
  function Lazy(props: P) {
    const [, rerender] = useReducer((n: number) => n + 1, 0);
    const C = Loaded;
    useEffect(() => {
      if (C) return;
      let live = true;
      preload().then(
        () => live && rerender(),
        () => undefined,
      );
      return () => {
        live = false;
      };
    }, [C]);
    return C ? <C {...props} /> : fallback();
  }
  return Object.assign(Lazy, { preload });
}
