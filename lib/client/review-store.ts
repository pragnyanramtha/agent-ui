"use client";

import { useSyncExternalStore } from "react";
import { loadLocal, REVIEW_PREFIX, saveLocal } from "./storage";
import { commentLabel, relToRoot, reviewBlock, sortComments, stillMatches, type ReviewComment } from "./review";

/* A session's review comments, shared by the diff (where they're written) and the pill over the composer (where they
 * go out with the next message). Kept in localStorage so a reload or another tab keeps them. */

const NONE: ReviewComment[] = [];
const cache = new Map<string, ReviewComment[]>();
const listeners = new Set<() => void>();
const key = (session: string) => `${REVIEW_PREFIX}${session}`;

const valid = (c: unknown): c is ReviewComment => {
  const x = c as ReviewComment;
  return Boolean(x) && typeof x.id === "string" && typeof x.file === "string" && typeof x.path === "string" && typeof x.body === "string" && Array.isArray(x.lines) && x.lines.length > 0;
};

export function loadReview(session: string): ReviewComment[] {
  const hit = cache.get(session);
  if (hit) return hit;
  let list = NONE;
  try {
    const raw = JSON.parse(loadLocal(key(session)) ?? "[]") as unknown;
    if (Array.isArray(raw)) list = raw.filter(valid);
  } catch {}
  cache.set(session, list);
  return list;
}

function store(session: string, list: ReviewComment[]) {
  const next = list.length ? sortComments(list) : NONE;
  cache.set(session, next);
  saveLocal(key(session), next.length ? JSON.stringify(next) : null);
  for (const l of listeners) l();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key.startsWith(REVIEW_PREFIX)) {
      cache.clear();
      cb();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

export function useReviewComments(session: string): ReviewComment[] {
  return useSyncExternalStore(
    subscribe,
    () => loadReview(session),
    () => NONE,
  );
}

export function addReview(session: string, c: Omit<ReviewComment, "id" | "at">): ReviewComment {
  const full: ReviewComment = { ...c, id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: Date.now() };
  store(session, [...loadReview(session), full]);
  return full;
}

export function editReview(session: string, id: string, body: string) {
  store(
    session,
    loadReview(session).map((c) => (c.id === id ? { ...c, body } : c)),
  );
}

export function removeReview(session: string, id: string) {
  store(
    session,
    loadReview(session).filter((c) => c.id !== id),
  );
}

export const clearReview = (session: string) => store(session, []);

const READ_BYTES = 8 * 1024 * 1024;

/** The file's text, null when it's gone, undefined when it couldn't be read (then its comments go out unchecked). */
async function readFile(path: string): Promise<string | null | undefined> {
  try {
    const r = await fetch(`/api/files/raw?path=${encodeURIComponent(path)}`, { cache: "no-store", headers: { Range: `bytes=0-${READ_BYTES - 1}` } });
    if (r.status === 404) return null;
    if (!r.ok) return undefined;
    return await r.text();
  } catch {
    return undefined;
  }
}

/** Takes the session's comments for a message: the block for the ones whose lines are still there, and how many were
 * left out because the file changed under them. Clears them either way. */
export async function takeReview(session: string, root: string | null | undefined): Promise<{ block: string; sent: number; dropped: number }> {
  const list = loadReview(session);
  if (!list.length) return { block: "", sent: 0, dropped: 0 };
  const files = new Map<string, Promise<string | null | undefined>>();
  for (const c of list) if (!files.has(c.file)) files.set(c.file, readFile(c.file));
  const kept: ReviewComment[] = [];
  for (const c of list) {
    const text = await files.get(c.file)!;
    if (text === undefined || stillMatches(c, text)) kept.push(c);
  }
  clearReview(session);
  const block = reviewBlock(kept.map((c) => ({ label: commentLabel(relToRoot(c.file, root), c.lines), lines: c.lines, body: c.body })));
  return { block, sent: kept.length, dropped: list.length - kept.length };
}
