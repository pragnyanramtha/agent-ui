"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Folder } from "iconoir-react";
import { monogram, monogramColors } from "@/lib/project-identity";

/* A project folder's mark in the sidebar: the repository's favicon when it has one (found on the server, read through
 * /api/files/raw), else two letters on a tint from its name. Lookups are batched and kept for the page's life. */

const icons = new Map<string, string | null>();
const asked = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
let queued = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;

const notify = () => {
  version++;
  for (const l of listeners) l();
};

function flush() {
  timer = undefined;
  const dirs = [...queued];
  queued = new Set();
  if (!dirs.length) return;
  const qs = dirs.map((d) => `dir=${encodeURIComponent(d)}`).join("&");
  fetch(`/api/projects?${qs}`)
    .then((r) => (r.ok ? (r.json() as Promise<{ icons?: Record<string, string | null> }>) : null))
    .then((d) => {
      for (const dir of dirs) icons.set(dir, d?.icons?.[dir] ?? null);
      notify();
    })
    /* offline: ask again the next time the list changes */
    .catch(() => dirs.forEach((dir) => asked.delete(dir)));
}

function want(dirs: readonly string[]) {
  for (const d of dirs) {
    if (!d || asked.has(d)) continue;
    asked.add(d);
    queued.add(d);
  }
  if (queued.size && !timer) timer = setTimeout(flush, 30);
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => void listeners.delete(cb);
};

/** The favicon path of each folder, once known (undefined while asking, null when it has none). */
export function useProjectIcons(dirs: readonly string[]): ReadonlyMap<string, string | null> {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
  const key = dirs.join("\0");
  useEffect(() => {
    want(key ? key.split("\0") : []);
  }, [key]);
  return icons;
}

/* ── branch, for the hover card ─────────────────────────── */

const BRANCH_TTL_MS = 30_000;
const branches = new Map<string, { at: number; value: Promise<string | null> }>();

function branchOf(dir: string): Promise<string | null> {
  const hit = branches.get(dir);
  if (hit && Date.now() - hit.at < BRANCH_TTL_MS) return hit.value;
  const value = fetch(`/api/projects?branch=${encodeURIComponent(dir)}`)
    .then((r) => (r.ok ? (r.json() as Promise<{ branch?: string | null }>) : null))
    .then((d) => d?.branch ?? null)
    .catch(() => {
      branches.delete(dir);
      return null;
    });
  branches.set(dir, { at: Date.now(), value });
  if (branches.size > 200) branches.delete(branches.keys().next().value!);
  return value;
}

/** The branch checked out in a folder: undefined while asking, null when there's none. */
export function useBranch(dir: string | null): string | null | undefined {
  const [got, setGot] = useState<{ dir: string; branch: string | null } | null>(null);
  useEffect(() => {
    if (!dir) return;
    let live = true;
    void branchOf(dir).then((branch) => live && setGot({ dir, branch }));
    return () => {
      live = false;
    };
  }, [dir]);
  if (!dir) return null;
  return got?.dir === dir ? got.branch : undefined;
}

/* ── the mark ─────────────────────────────────────────────── */

export function ProjectIcon({ name, icon, size = 14, className = "" }: { name: string; icon: string | null | undefined; size?: number; className?: string }) {
  const [broken, setBroken] = useState<string | null>(null);
  if (icon && broken !== icon) {
    return (
      <img
        src={`/api/files/raw?path=${encodeURIComponent(icon)}`}
        alt=""
        width={size}
        height={size}
        draggable={false}
        onError={() => setBroken(icon)}
        className={`shrink-0 rounded-[3px] object-contain ${className}`}
        style={{ width: size, height: size }}
      />
    );
  }
  const text = monogram(name);
  if (!text) return <Folder width={size} height={size} strokeWidth={1.8} aria-hidden className={`shrink-0 ${className}`} />;
  return (
    <span
      aria-hidden
      translate="no"
      className={`inline-flex shrink-0 items-center justify-center rounded-[4px] font-semibold leading-none tracking-[-0.02em] select-none ${className}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.5), ...monogramColors(name) }}
    >
      {text}
    </span>
  );
}
