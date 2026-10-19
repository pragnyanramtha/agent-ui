"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import type { AgentId, Entry, PermissionMode, RunState, ServerEvent, StreamDelta, TerminalInfo, ToolResult } from "@/lib/types";
import { api, ApiError } from "./api";
import { carryOver, load, save } from "./storage";

type Stream = { msgId: string; index: number; kind: StreamDelta["kind"]; text: string };
/** A message the user sent that isn't in the transcript yet. Kept in sessionStorage so it survives remounts. */
export type Pending = {
  localId: string;
  text: string;
  /** when the first attempt went out; retries keep it, so a transcript entry from that attempt still matches */
  at: number;
  /** when the server confirmed it */
  sentAt?: number;
  state: "sending" | "sent" | "failed";
  via?: "terminal" | "web" | "queued";
  error?: string;
  /** the server took it (so its client id is spent) but it never ran: a retry must go out as a new send */
  resend?: boolean;
  /** the client id the server knows it by (a fresh retry gets a new one) */
  sentAs?: string;
};

export const serverId = (p: Pending) => p.sentAs ?? p.localId;

/* the terminal path flattens newlines, and Claude Code trims; compare on collapsed whitespace */
const norm = (s: string) => s.replace(/\s+/g, " ").trim().replace(/^!\s+/, "!");
/** restoring a saved bubble: an older entry with the same text is an earlier message, not this one (clock skew allowed) */
const landedAfter = (e: Entry, p: Pending) => !e.ts || Date.parse(e.ts) >= p.at - 60_000;
const pendingKey = (id: string) => `pending:${id}`;

/** waits `ms`, or less when the network comes back or the tab is shown again */
const wake = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(t);
      window.removeEventListener("online", done);
      document.removeEventListener("visibilitychange", onVisible);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const onVisible = () => document.visibilityState === "visible" && done();
    const t = setTimeout(done, ms);
    window.addEventListener("online", done);
    document.addEventListener("visibilitychange", onVisible);
    signal.addEventListener("abort", done, { once: true });
  });

/* Live text of non-Claude agents (Codex, OpenCode, Cursor, Devin) arrives under msgIds
 * "live:<key>:<turn>:<segment>" that persisted entries never share. A persisted text/thinking
 * entry takes over the live streams it matches: one whose id ends in the entry's id, else
 * those whose text it contains, else the oldest one that begins the same way. Replaced
 * streams ignore later deltas. A stream that ran on past the entry (one stdout stream for
 * several messages) only loses the persisted part. The server replays a running turn's text
 * on every (re)connect, so a history event clears live streams first. */
const isLive = (msgId: string) => msgId.startsWith("live:");
const streamKey = (s: { msgId: string; index: number }) => `${s.msgId}\0${s.index}`;
/** a replayed live stream longer than this that is already on screen as an entry isn't shown again */
const REPLAY_MIN = 40;
const HEAD = 24;

type TextEntry = Extract<Entry, { kind: "text" | "thinking" }>;

/** live streams the entry replaces, and ones it only trims */
function liveMatches(streams: Stream[], e: TextEntry): { gone: Stream[]; trimmed: Map<Stream, string> } {
  const none = { gone: [], trimmed: new Map<Stream, string>() };
  const live = streams.filter((s) => isLive(s.msgId) && s.kind === e.kind);
  if (!live.length) return none;
  const ids = [e.msgId, e.id].filter((id) => id.length >= 8);
  const exact = live.filter((s) => ids.some((id) => s.msgId.endsWith(`:${id}`)));
  if (exact.length) return { ...none, gone: exact };
  const text = norm(e.text);
  /* the oldest stream the entry contains, plus any other long ones (a pause split one message); a
   * short later stream ("The") inside an older message is the next message starting, so it stays */
  const contained = live.filter((s) => text.includes(norm(s.text)));
  if (contained.length) return { ...none, gone: contained.filter((s, i) => i === 0 || norm(s.text).length >= REPLAY_MIN) };
  const raw = e.text.trim();
  const head = Math.min(HEAD, text.length);
  for (const s of live) {
    const body = s.text.trimStart();
    if (raw && body.startsWith(raw)) return { ...none, trimmed: new Map([[s, body.slice(raw.length)]]) };
    const t = norm(body);
    if (head && t.length >= head && t.slice(0, head) === text.slice(0, head)) return { ...none, gone: [s] };
  }
  return none;
}

export type SessionView = {
  status: "connecting" | "open" | "reconnecting" | "missing";
  entries: Entry[];
  ids: Set<string>;
  results: Record<string, ToolResult>;
  cursor: number | null;
  loadingOlder: boolean;
  terminal: TerminalInfo | null;
  run: RunState | null;
  title: string;
  cwd: string;
  permissionMode: PermissionMode | null;
  /** the agent profile the session last ran on */
  profile: string | null;
  streams: Stream[];
  /** live streams (see isLive) already replaced by persisted entries */
  dropped: Set<string>;
  pending: Pending[];
  /** ids of messages the server holds until the running turn ends (non-Claude agents) */
  queue: string[];
};

export type Action =
  | { type: "event"; event: ServerEvent; initial?: boolean }
  | { type: "older"; entries: Entry[]; cursor: number | null }
  | { type: "loadingOlder" }
  | { type: "olderFailed" }
  | { type: "status"; status: SessionView["status"] }
  | { type: "pending"; pending: Pending }
  | { type: "updatePending"; localId: string; patch: Partial<Pending> }
  | { type: "restorePending"; pending: Pending[] }
  | { type: "dropPending"; localId: string };

export const initial = (): SessionView => ({
  status: "connecting",
  entries: [],
  ids: new Set(),
  results: {},
  cursor: null,
  loadingOlder: false,
  terminal: null,
  run: null,
  title: "",
  cwd: "",
  permissionMode: null,
  profile: null,
  streams: [],
  dropped: new Set(),
  pending: [],
  queue: [],
});

/* Folds a batch into the view: tool results attach by id, everything else is
 * de-duplicated by entry id (reconnects and overlapping reads both resend). */
function merge(state: SessionView, batch: Entry[], where: "append" | "prepend", live = true): SessionView {
  const ids = new Set(state.ids);
  let results = state.results;
  let streams = state.streams;
  let dropped = state.dropped;
  let pending = state.pending;
  const fresh: Entry[] = [];
  for (const e of batch) {
    if (e.kind === "result") {
      if (results === state.results) results = { ...results };
      results[e.toolUseId] = e.result;
      continue;
    }
    if (ids.has(e.id)) continue;
    ids.add(e.id);
    fresh.push(e);
    if (e.kind === "text" || e.kind === "thinking") {
      /* the persisted block replaces the oldest live stream of the same kind for that message */
      const i = streams.findIndex((s) => s.msgId === e.msgId && s.kind === e.kind);
      if (i !== -1) streams = streams.filter((_, j) => j !== i);
      else if (where === "append") {
        /* other agents' live streams (see isLive) */
        const { gone, trimmed } = liveMatches(streams, e);
        if (e.kind === "text" && gone.length) {
          /* reasoning that streamed before this text is done too (some agents never persist it) */
          const at = streams.indexOf(gone[0]);
          gone.push(...streams.slice(0, at).filter((s) => isLive(s.msgId) && s.kind === "thinking"));
        }
        if (gone.length) {
          streams = streams.filter((s) => !gone.includes(s));
          dropped = new Set(dropped);
          gone.forEach((s) => dropped.add(streamKey(s)));
        }
        if (trimmed.size) streams = streams.map((s) => (trimmed.has(s) ? { ...s, text: trimmed.get(s)! } : s));
      }
    }
    if (e.kind === "user" && pending.length && where === "append") {
      /* an entry arriving live is new, whatever its timestamp says; a full history load holds old ones too */
      const i = pending.findIndex((p) => norm(p.text) === norm(e.text) && (live || landedAfter(e, p)));
      if (i !== -1) pending = pending.filter((_, j) => j !== i);
    }
  }
  if (!fresh.length && results === state.results) return state;
  return {
    ...state,
    ids,
    results,
    streams,
    dropped,
    pending,
    entries: where === "append" ? [...state.entries, ...fresh] : [...fresh, ...state.entries],
  };
}

/** a run that failed won't read what it was handed: those bubbles get Retry (same client id, so no double send) */
function failDelivered(pending: Pending[], run: RunState | null): Pending[] {
  if (run?.status !== "error" || !pending.some((p) => p.state === "sent" && p.via === "web")) return pending;
  return pending.map((p) => (p.state === "sent" && p.via === "web" ? { ...p, state: "failed" as const, resend: true, error: run.error ?? "Not delivered. The turn ended first." } : p));
}

export function reducer(state: SessionView, action: Action): SessionView {
  switch (action.type) {
    case "event": {
      const e = action.event;
      if (e.type === "history") {
        /* the first load (by GET) replaces everything; later history events (stream reconnects) only add */
        const first = action.initial === true;
        const merged = merge(first ? { ...state, entries: [], ids: new Set(), results: {}, dropped: new Set() } : state, e.entries, "append", !first);
        return {
          ...merged,
          /* deltas sent while disconnected are gone, so text on screen can't be continued; other agents' servers
           * replay a running turn's live text after every history event, and a finished block lands as an entry */
          streams: merged.streams.length ? [] : merged.streams,
          /* the run may have ended (or crashed) while the stream was down */
          pending: failDelivered(merged.pending, e.run),
          status: "open",
          cursor: first ? e.cursor : state.cursor,
          terminal: e.terminal,
          run: e.run,
          title: e.title,
          cwd: e.cwd,
          permissionMode: e.permissionMode,
          profile: e.profile ?? state.profile,
        };
      }
      if (e.type === "entries") return merge(state, e.entries, "append");
      if (e.type === "terminal") return { ...state, terminal: e.terminal };
      if (e.type === "title") return { ...state, title: e.title };
      if (e.type === "queue") return { ...state, queue: e.items.map((q) => q.id) };
      if (e.type === "unsent") {
        const lost = new Map(e.items.map((u) => [u.id, u.error]));
        if (!state.pending.some((p) => p.state === "sent" && lost.has(serverId(p)))) return state;
        return { ...state, pending: state.pending.map((p) => (p.state === "sent" && lost.has(serverId(p)) ? { ...p, state: "failed" as const, resend: true, error: lost.get(serverId(p)) } : p)) };
      }
      if (e.type === "run") {
        const ended = !e.run || e.run.status === "idle" || e.run.status === "closed" || e.run.status === "error";
        return { ...state, run: e.run, streams: ended ? [] : state.streams, pending: failDelivered(state.pending, e.run) };
      }
      if (e.type === "delta") {
        const d = e.delta;
        const i = state.streams.findIndex((s) => s.msgId === d.msgId && s.index === d.index);
        let text = d.text;
        if (isLive(d.msgId)) {
          /* only while the turn runs, and never again once a persisted entry took over */
          if ((state.run?.status !== "running" && state.run?.status !== "starting") || state.dropped.has(streamKey(d))) return state;
          /* a replay (after a reload) of text that already landed as entries of this turn */
          if (i === -1 && norm(text).length >= REPLAY_MIN) {
            const from = state.entries.findLastIndex((x) => x.kind === "user") + 1;
            for (const x of state.entries.slice(from)) {
              if (x.kind !== d.kind) continue;
              if (norm(x.text).includes(norm(text))) return { ...state, dropped: new Set(state.dropped).add(streamKey(d)) };
              const raw = x.text.trim();
              if (raw && text.trimStart().startsWith(raw)) text = text.trimStart().slice(raw.length);
            }
          }
        }
        const streams = i === -1 ? [...state.streams, { ...d, text }] : state.streams.map((s, j) => (j === i ? { ...s, text: s.text + text } : s));
        return { ...state, streams };
      }
      return state;
    }
    case "older":
      return { ...merge(state, action.entries, "prepend"), cursor: action.cursor, loadingOlder: false };
    case "loadingOlder":
      return { ...state, loadingOlder: true };
    case "olderFailed":
      return { ...state, loadingOlder: false };
    case "status":
      return { ...state, status: action.status };
    case "pending":
      return { ...state, pending: [...state.pending, action.pending] };
    case "updatePending":
      return { ...state, pending: state.pending.map((p) => (p.localId === action.localId ? { ...p, ...action.patch } : p)) };
    case "restorePending": {
      const have = new Set(state.pending.map((p) => p.localId));
      const landed = (p: Pending) => state.entries.some((e) => e.kind === "user" && norm(e.text) === norm(p.text) && landedAfter(e, p));
      return { ...state, pending: [...state.pending, ...action.pending.filter((p) => !have.has(p.localId) && !landed(p))] };
    }
    case "dropPending":
      return { ...state, pending: state.pending.filter((p) => p.localId !== action.localId) };
  }
}

export function useSession(id: string | null, onRedirect: (id: string) => void) {
  const [view, dispatch] = useReducer(reducer, undefined, initial);
  const redirectRef = useRef(onRedirect);
  redirectRef.current = onRedirect;
  const pendingNow = useRef(view.pending);
  pendingNow.current = view.pending;

  useEffect(() => {
    if (!id) return;
    dispatch({ type: "status", status: "connecting" });
    const abort = new AbortController();
    /* a phone back from sleep, or a network that changed, usually holds a stream that is already dead; drop it now
     * instead of waiting out the stall timer */
    let kick: (() => void) | undefined;
    let hiddenAt = 0;
    const onVisible = () => {
      if (document.visibilityState === "hidden") hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > 20_000) kick?.();
    };
    const onOnline = () => kick?.();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    /* history over a plain fetch, then a live stream from where it ended. The stream is a POST
     * read with fetch (not EventSource): some tunnels buffer GET event streams until they close. */
    (async () => {
      let from: string | number = 0;
      /* only a 404 means the session is gone; anything else is the network, so keep trying */
      for (let attempt = 0; ; attempt++) {
        try {
          const first = await api<Extract<ServerEvent, { type: "history" }> & { end: string | number; agent?: AgentId }>(`/api/sessions/${id}`);
          if (abort.signal.aborted) return;
          dispatch({ type: "event", event: first, initial: true });
          from = first.end;
          break;
        } catch (err) {
          if (abort.signal.aborted) return;
          if (err instanceof ApiError && (err.status === 404 || err.status === 400)) {
            dispatch({ type: "status", status: "missing" });
            return;
          }
          if (attempt === 1) dispatch({ type: "status", status: "reconnecting" });
          await wake(Math.min(8000, 500 * 2 ** attempt), abort.signal);
        }
      }
      for (let attempt = 0; !abort.signal.aborted; attempt++) {
        try {
          const res = await fetch(`/api/sessions/${id}/events`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ from }),
            signal: abort.signal,
            cache: "no-store",
          });
          if (res.status === 401) {
            window.location.href = "/login";
            return;
          }
          if (res.status === 404) {
            dispatch({ type: "status", status: "missing" });
            return;
          }
          if (!res.ok || !res.body) throw new Error(String(res.status));
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          let buf = "";
          for (;;) {
            /* the server pings every 15s; silence well past that means a dead connection the browser didn't notice */
            let stall: ReturnType<typeof setTimeout> | undefined;
            const timeout = new Promise<never>((_, reject) => {
              stall = setTimeout(() => reject(new Error("stalled")), 40_000);
              kick = () => reject(new Error("woke"));
            });
            const { value, done } = await Promise.race([reader.read(), timeout]).finally(() => {
              clearTimeout(stall);
              kick = undefined;
            }).catch((err) => {
              void reader.cancel().catch(() => undefined);
              throw err;
            });
            if (done) break;
            buf += value;
            let cut;
            while ((cut = buf.indexOf("\n\n")) !== -1) {
              const frame = buf.slice(0, cut);
              buf = buf.slice(cut + 2);
              let data = "";
              for (const line of frame.split("\n")) {
                if (line.startsWith("id: ")) from = line.slice(4).trim() || from;
                else if (line.startsWith("data: ")) data += line.slice(6);
              }
              if (!data) continue;
              attempt = 0;
              const event = JSON.parse(data) as ServerEvent;
              if (event.type === "redirect") {
                carryOver(id, event.sessionId, pendingNow.current);
                redirectRef.current(event.sessionId);
              }
              else if (event.type !== "ping") dispatch({ type: "event", event });
            }
          }
        } catch {
          if (abort.signal.aborted) return;
        }
        dispatch({ type: "status", status: "reconnecting" });
        await wake(Math.min(8000, 500 * 2 ** attempt), abort.signal);
      }
    })();
    return () => {
      abort.abort();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [id]);

  const cursorRef = useRef(view.cursor);
  cursorRef.current = view.cursor;
  const loadingRef = useRef(false);

  const loadOlder = useCallback(async () => {
    if (!id || cursorRef.current === null || loadingRef.current) return;
    loadingRef.current = true;
    dispatch({ type: "loadingOlder" });
    try {
      const page = await api<{ entries: Entry[]; cursor: number | null }>(`/api/sessions/${id}?before=${cursorRef.current}`);
      dispatch({ type: "older", entries: page.entries, cursor: page.cursor });
    } catch {
      dispatch({ type: "olderFailed" });
    } finally {
      loadingRef.current = false;
    }
  }, [id]);

  /* unsent messages survive reloads and remounts; restored once history has loaded, so ones that landed are skipped */
  const restored = useRef(false);
  useEffect(() => {
    if (!id || restored.current || view.status === "connecting") return;
    restored.current = true;
    try {
      const saved = JSON.parse(load(pendingKey(id)) ?? "[]") as Pending[];
      if (saved.length) dispatch({ type: "restorePending", pending: saved.map((p) => (p.state === "sending" ? { ...p, state: "failed", error: "Not confirmed. Retry is safe." } : p)) });
    } catch {
      /* corrupt entry: ignore */
    }
  }, [id, view.status]);
  useEffect(() => {
    if (!id || !restored.current) return;
    save(pendingKey(id), view.pending.length ? JSON.stringify(view.pending) : null);
  }, [id, view.pending]);

  const addPending = useCallback((text: string) => {
    const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    dispatch({ type: "pending", pending: { localId, text, at: Date.now(), state: "sending" } });
    return localId;
  }, []);

  const updatePending = useCallback((localId: string, patch: Partial<Pending>) => dispatch({ type: "updatePending", localId, patch }), []);
  const dropPending = useCallback((localId: string) => dispatch({ type: "dropPending", localId }), []);

  return { view, loadOlder, addPending, updatePending, dropPending };
}
