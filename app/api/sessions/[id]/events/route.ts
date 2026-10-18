import path from "node:path";
import type { NextRequest } from "next/server";
import type { ServerEvent, TerminalInfo } from "@/lib/types";
import { projectDirFor } from "@/lib/server/config";
import { parseMode, readJson, sessionContext } from "@/lib/server/http";
import { getRun, onRunRegistered, type RunEvent } from "@/lib/server/runner";
import { isSessionId, terminalFor } from "@/lib/server/sessions";
import { tailFile } from "@/lib/server/tail";
import { metaTitle, readHistory } from "@/lib/server/transcript";
import { parseSessionKey } from "@/lib/server/agents";
import { agentEvents } from "@/lib/server/agents/routes";
import { onSessionEvent } from "@/lib/server/fallback";
import { pickProfile } from "@/lib/server/profiles";

export const dynamic = "force-dynamic";

/* One SSE stream per open session: the latest history page, then new
 * transcript entries as they're appended, plus web-run deltas/status and the
 * terminal (zellij/tmux) liveness of the session. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  /* on auto-reconnect the browser sends the last event id (a byte offset), which beats the original ?from */
  return route(req, id, req.headers.get("last-event-id") || req.nextUrl.searchParams.get("from"));
}

function route(req: NextRequest, raw: string, from: string | null) {
  const key = parseSessionKey(decodeURIComponent(raw));
  if (!key) return new Response("Not found", { status: 404 });
  return key.agent === "claude" ? stream(req, key.native, from) : agentEvents(req, key.agent, key.native, from);
}

/* Same stream over POST: Cloudflare quick tunnels buffer GET event streams until they close, POST streams flow. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const from = (await readJson(req)).from;
  return route(req, id, typeof from === "number" || typeof from === "string" ? String(from) : null);
}

async function stream(req: NextRequest, id: string, fromParam: string | null) {
  if (!isSessionId(id)) return new Response("Not found", { status: 404 });

  const ctx = await sessionContext(id);
  const run = getRun(id);
  const initialTerminal = await terminalFor(id, Boolean(run));
  const cwd = ctx?.cwd ?? run?.cwd ?? initialTerminal?.cwd;
  if (!ctx && !cwd) return new Response("Session not found.", { status: 404 });

  const file = ctx?.file ?? path.join(projectDirFor(cwd!), `${id}.jsonl`);
  /* `from`: the client already loaded history over a plain fetch (large SSE frames stall behind some proxies) */
  const from = fromParam === null ? NaN : Math.max(0, Math.floor(Number(fromParam)));
  const history = Number.isFinite(from)
    ? { entries: [], cursor: null, end: from }
    : ctx
      ? await readHistory(ctx.file)
      : { entries: [], cursor: null, end: 0 };
  if (req.signal.aborted) return new Response(null, { status: 499 });
  const encoder = new TextEncoder();
  const cleanups: (() => void)[] = [];
  let closed = false;
  /* abort and cancel can both fire; tear down exactly once */
  const cleanup = () => {
    if (closed) return;
    closed = true;
    cleanups.splice(0).forEach((fn) => fn());
  };

  const body = new ReadableStream({
    start(controller) {
      const write = (event: ServerEvent, offset?: number) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${offset === undefined ? "" : `id: ${offset}\n`}data: ${JSON.stringify(event)}\n\n`));
        } catch {
          cleanup();
        }
      };
      /* keep frames small: a batch of big entries goes out one entry per frame */
      const send = (event: ServerEvent, offset?: number) => {
        if (event.type === "entries" && event.entries.length > 1 && JSON.stringify(event).length > 48_000) {
          event.entries.forEach((e, i) => write({ type: "entries", entries: [e] }, i === event.entries.length - 1 ? offset : undefined));
        } else write(event, offset);
      };

      /* the web run can appear (a message sent from another tab) or end while we're connected;
       * re-read it here since it may have ended during the awaits above */
      let watchedRun = getRun(id);
      const onRun = (e: RunEvent) => send(e.type === "run" ? { type: "run", run: e.run } : e);
      let unsubRun = watchedRun ? watchedRun.subscribe(onRun) : null;
      const syncRun = () => {
        const current = getRun(id);
        if (closed || current === watchedRun) return;
        const failed = watchedRun?.state.status === "error";
        unsubRun?.();
        watchedRun = current;
        unsubRun = current ? current.subscribe(onRun) : null;
        /* a failed run already sent its final state; leave its error on screen until something replaces it */
        if (current || !failed) send({ type: "run", run: current ? current.state : null });
      };
      const unwatchRuns = onRunRegistered((rid) => rid === id && syncRun());
      const unwatchBus = onSessionEvent(id, (e) => send(e));

      /* subscriptions deliver asynchronously, so registering them before the history event keeps the order */
      const unsubTail = tailFile(file, history.end, (entries, end) => send({ type: "entries", entries }, end));

      const firstTerminal = watchedRun ? null : initialTerminal;
      let lastTerminal = JSON.stringify(firstTerminal);
      let checking = false;
      const tick = setInterval(async () => {
        syncRun();
        if (checking || closed) return;
        checking = true;
        const t: TerminalInfo | null = await terminalFor(id, Boolean(watchedRun)).finally(() => (checking = false));
        const key = JSON.stringify(t);
        if (key !== lastTerminal) {
          lastTerminal = key;
          send({ type: "terminal", terminal: t });
        }
      }, 2000);
      const ping = setInterval(() => send({ type: "ping" }), 15_000);

      cleanups.push(() => {
        clearInterval(tick);
        clearInterval(ping);
        unsubTail();
        unwatchRuns();
        unwatchBus();
        unsubRun?.();
        unsubRun = null;
      });
      req.signal.addEventListener(
        "abort",
        () => {
          cleanup();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        },
        { once: true },
      );

      send({
        type: "history",
        entries: [],
        cursor: history.cursor,
        terminal: firstTerminal,
        run: watchedRun ? watchedRun.state : null,
        title: (ctx && metaTitle(ctx.meta)) ?? "New session",
        cwd: cwd ?? "",
        permissionMode: parseMode(ctx?.meta.permissionMode),
        profile: (watchedRun?.profile ?? pickProfile("claude", null, id)).id,
      });
      /* what the run said outside the transcript (slash command output) */
      if (watchedRun?.extras.length) send({ type: "entries", entries: watchedRun.extras });
      /* history entries follow in small frames (older clients without ?from still work behind Cloudflare) */
      for (let i = 0; i < history.entries.length; i += 20) send({ type: "entries", entries: history.entries.slice(i, i + 20) });
      if (req.signal.aborted) cleanup();
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
