import { statSync, watch, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Entry } from "@/lib/types";
import { parseLines, readLines } from "./transcript";

/* One tailer per transcript file, shared by every viewer. inotify drives
 * reads; a slow poll covers missed events and files that don't exist yet
 * (a brand-new session before its first line lands). */

/** `end`: the byte offset these entries were read up to, so a reconnecting viewer can resume there. */
type Listener = (entries: Entry[], end: number) => void;
/** bytes [from, to) a catch-up skipped: the viewer missed whatever was written there and should load history afresh */
export type Gap = { from: number; to: number };
type Sub = { fn: Listener; from: number; joined: boolean; onGap?: (gap: Gap) => void };

/** most bytes read at once, for catching a viewer up or following the file */
const STEP = 8 * 1024 * 1024;

class Tail {
  private offset: number;
  private subs = new Set<Sub>();
  private watcher: FSWatcher | null = null;
  private poll: NodeJS.Timeout;
  private reading = false;
  private dirty = false;
  private closed = false;

  constructor(private file: string, offset: number) {
    this.offset = offset;
    this.attach();
    this.poll = setInterval(() => {
      if (!this.watcher) this.attach();
      void this.read();
    }, 1500);
  }

  private attach() {
    try {
      const watcher = watch(this.file, () => void this.read());
      watcher.on("error", () => {
        watcher.close();
        if (this.watcher === watcher) this.watcher = null;
      });
      this.watcher = watcher;
    } catch {
      this.watcher = null;
    }
  }

  /* Serialised: catch-up reads for new viewers and forward reads never interleave, so each viewer sees entries in file order. */
  private async read() {
    if (this.closed) return;
    if (this.reading) {
      this.dirty = true;
      return;
    }
    this.reading = true;
    try {
      do {
        this.dirty = false;
        for (const sub of this.subs) {
          if (sub.joined) continue;
          sub.joined = true;
          if (sub.from >= this.offset) continue;
          /* a viewer far behind (an old tab reconnecting) gets the recent part, not hundreds of MB at once */
          const start = Math.max(sub.from, this.offset - STEP);
          const caught = await readLines(this.file, start, this.offset);
          if (start > sub.from && this.subs.has(sub)) sub.onGap?.({ from: sub.from, to: caught.begin });
          const entries = parseLines(caught.lines);
          if (entries.length && this.subs.has(sub)) sub.fn(entries, this.offset);
        }
        const stat = await fs.stat(this.file).catch(() => null);
        if (!stat || this.closed) break;
        if (stat.size < this.offset) this.offset = 0;
        if (stat.size === this.offset) continue;
        const { lines, end } = await readLines(this.file, this.offset, Math.min(stat.size, this.offset + STEP));
        if (end > this.offset) {
          this.offset = end;
          if (end < stat.size) this.dirty = true;
        } else if (stat.size - this.offset >= STEP) {
          /* a full step with no newline: one line longer than a step can't be read in pieces; skip past it */
          this.offset += STEP;
          this.dirty = true;
        }
        const entries = parseLines(lines);
        if (entries.length) this.subs.forEach((sub) => sub.joined && sub.fn(entries, end));
      } while (this.dirty && !this.closed);
    } catch {
      /* the file vanished mid-read; the next poll retries */
    } finally {
      this.reading = false;
    }
  }

  /** Viewers join at the offset their history page ended at; the shared tail only ever moves forward. */
  subscribe(fn: Listener, from: number, onGap?: (gap: Gap) => void) {
    const sub: Sub = { fn, from, joined: false, onGap };
    this.subs.add(sub);
    void this.read();
    return () => {
      if (!this.subs.delete(sub)) return;
      if (this.subs.size === 0) this.close();
    };
  }

  private close() {
    this.closed = true;
    clearInterval(this.poll);
    this.watcher?.close();
    this.watcher = null;
    if (tails().get(this.file) === this) tails().delete(this.file);
  }
}

const tails = () => {
  const g = globalThis as typeof globalThis & { __claudeUiTails?: Map<string, Tail> };
  return (g.__claudeUiTails ??= new Map());
};

export function tailFile(file: string, from: number, fn: Listener, onGap?: (gap: Gap) => void) {
  const key = path.resolve(file);
  /* an offset past the end (a stale or made-up resume point) would look like a truncated file and replay it all */
  let size = 0;
  try {
    size = statSync(key).size;
  } catch {
    /* not written yet */
  }
  from = Math.min(Math.max(0, Number.isFinite(from) ? from : 0), size);
  let tail = tails().get(key);
  if (!tail) {
    tail = new Tail(key, from);
    tails().set(key, tail);
  }
  return tail.subscribe(fn, from, onGap);
}
