import type { PermissionMode } from "@/lib/types";
import { askUser, killGroup, liveStream, startTurn, type Run } from "./cli-run";
import { errorText } from "./codex-parse";

/* One web-driven Codex turn over `codex app-server` (JSON-RPC 2.0, one JSON
 * object per line on stdio). Unlike `codex exec --json`, which only reports
 * finished items, the app server streams the reply as it is written:
 *
 *   -> initialize {clientInfo}            <- result
 *   -> initialized (notification)
 *   -> thread/start {cwd, sandbox, approvalPolicy, model} | thread/resume {threadId, ...}
 *   -> turn/start {threadId, input: [{type: "text", text}]}
 *   <- item/agentMessage/delta {itemId, delta}            live text
 *   <- item/reasoning/summaryTextDelta {itemId, delta, summaryIndex}, item/reasoning/textDelta   live thinking
 *   <- error {error, willRetry}, turn/completed {turn: {status, error}}
 *
 * The thread is persisted to the usual rollout file, which stays the source of
 * truth for history. Stdin is closed once the turn completes, which ends the
 * process. */

type Msg = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message?: string } };

export type AppTurnOptions = {
  key: string;
  bin: string;
  cwd: string;
  text: string;
  model?: string;
  mode: PermissionMode;
  /** resume this thread; omitted starts a new one */
  threadId?: string;
  /** Responses API items put into a new thread's history before the first turn (a conversation moved from another agent) */
  inject?: unknown[];
  /** the thread id, as soon as the app server reports it (before the model answers) */
  onThread?: (id: string) => void;
};

/* Ask first: Codex asks before anything it doesn't trust. Accept edits: it works inside the folder and asks only to
 * step outside the sandbox. Plan: read-only, nothing to ask. Bypass: no sandbox, no questions. */
export function threadSettings(mode: PermissionMode, model?: string) {
  const sandbox = mode === "bypassPermissions" ? "danger-full-access" : mode === "plan" ? "read-only" : "workspace-write";
  const approvalPolicy = mode === "default" ? "untrusted" : mode === "acceptEdits" ? "on-request" : "never";
  return { approvalPolicy, sandbox, ...(model ? { model } : {}) };
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown) => (typeof v === "string" ? v : "");

export function appServerTurn(o: AppTurnOptions): Run {
  let nextId = 0;
  const replies = new Map<number, (m: Msg) => void>();
  let failure: string | null = null;
  let threadId: string | null = o.threadId ?? null;
  let done = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  /* reasoning items that streamed a summary (raw reasoning text for them is skipped), and their last summary index */
  const summaries = new Map<string, number>();

  const run = startTurn(o.key, { cmd: o.bin, args: ["app-server"], cwd: o.cwd, keepStdin: true }, (line) => onLine(line));
  const live = liveStream(run);

  function write(m: object) {
    const stdin = run.child.stdin;
    if (stdin && !stdin.destroyed && stdin.writable) stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  }
  function request(method: string, params: unknown, then: (m: Msg) => void) {
    const id = ++nextId;
    replies.set(id, then);
    write({ id, method, params });
  }
  /** ends the turn: closing stdin makes the app server exit; a stuck one is terminated */
  function finish(err?: string | null) {
    if (err && !failure) failure = err;
    if (done) return;
    done = true;
    run.child.stdin?.end();
    killTimer = setTimeout(() => {
      if (run.child.exitCode === null && run.child.signalCode === null) killGroup(run.child);
    }, 5000);
  }
  const fail = (m: Msg, what: string) => finish(errorText(m.error?.message || what));

  function onLine(line: string) {
    if (!line.startsWith("{")) return;
    let m: Msg;
    try {
      m = JSON.parse(line) as Msg;
    } catch {
      return;
    }
    if (m.id !== undefined && m.method === undefined) {
      const then = replies.get(Number(m.id));
      replies.delete(Number(m.id));
      then?.(m);
    } else if (m.id !== undefined && m.method) answer(m);
    else if (m.method) notify(m.method, obj(m.params));
  }

  /** Server-initiated requests: approvals become cards in the session; anything else is refused. */
  function answer(m: Msg) {
    const p = obj(m.params);
    const v2 = m.method === "item/commandExecution/requestApproval" || m.method === "item/fileChange/requestApproval";
    const legacy = m.method === "execCommandApproval" || m.method === "applyPatchApproval";
    if (!v2 && !legacy) return write({ id: m.id, error: { code: -32601, message: `${m.method} isn't supported by agent-u` } });
    if (typeof p.threadId === "string" && threadId && p.threadId !== threadId) return write({ id: m.id, result: { decision: v2 ? "decline" : "denied" } });
    const command = Array.isArray(p.command) ? p.command.map(String).join(" ") : str(p.command);
    const isCommand = m.method === "item/commandExecution/requestApproval" || m.method === "execCommandApproval";
    const reason = str(p.reason) || null;
    askUser(
      run,
      {
        kind: "permission",
        requestId: `codex-${String(m.id)}`,
        toolName: isCommand ? "Bash" : "Edit",
        title: isCommand ? (command ? `Run ${command.length > 120 ? `${command.slice(0, 119)}…` : command}` : "Run a command") : str(p.grantRoot) ? `Write outside the folder, in ${str(p.grantRoot)}` : "Edit files",
        description: reason,
        input: isCommand ? { command, ...(str(p.cwd) ? { cwd: str(p.cwd) } : {}) } : { ...(str(p.grantRoot) ? { grantRoot: str(p.grantRoot) } : {}) },
        canAlwaysAllow: true,
      },
      (a) => {
        const decision = v2 ? (a.allow ? (a.always ? "acceptForSession" : "accept") : "decline") : a.allow ? (a.always ? "approved_for_session" : "approved") : "denied";
        write({ id: m.id, result: { decision } });
      },
    );
  }

  function notify(method: string, p: Record<string, unknown>) {
    /* subagents run on threads of their own; only the session's thread counts */
    if (typeof p.threadId === "string" && threadId && p.threadId !== threadId) return;
    const item = str(p.itemId);
    switch (method) {
      case "item/agentMessage/delta":
        live.push(item, "text", str(p.delta));
        break;
      case "item/reasoning/summaryTextDelta": {
        const index = Number(p.summaryIndex) || 0;
        const prev = summaries.get(item);
        summaries.set(item, index);
        live.push(item, "thinking", `${prev !== undefined && prev !== index ? "\n\n" : ""}${str(p.delta)}`);
        break;
      }
      case "item/reasoning/textDelta":
        if (!summaries.has(item)) live.push(`${item}:raw`, "thinking", str(p.delta));
        break;
      case "error":
        if (p.willRetry !== true) failure = errorText(str(obj(p.error).message) || "Codex reported an error");
        break;
      case "turn/completed": {
        const turn = obj(p.turn);
        finish(turn.status === "failed" ? errorText(str(obj(turn.error).message) || failure || "Codex turn failed.") : null);
        break;
      }
    }
  }

  run.child.on("exit", () => {
    clearTimeout(killTimer);
    if (!failure) return;
    /* cli-run's own exit handler already ran (registered first); replace its outcome with the turn's error */
    run.state = { ...run.state, status: "error", error: failure };
    run.listeners.forEach((fn) => fn(run.state));
  });

  request("initialize", { clientInfo: { name: "agent-u", title: "agent-u", version: "1.0.0" }, capabilities: null }, (m) => {
    if (m.error) return fail(m, "Couldn't start Codex.");
    write({ method: "initialized" });
    const onThreadReady = (r: Msg) => {
      if (r.error) return fail(r, o.threadId ? "Couldn't resume the session." : "Couldn't start the session.");
      threadId = str(obj(obj(r.result).thread).id) || threadId;
      if (!threadId) return finish("Codex didn't start a session.");
      o.onThread?.(threadId);
      const turn = () =>
        request("turn/start", { threadId, input: [{ type: "text", text: o.text, text_elements: [] }] }, (t) => {
          if (t.error) fail(t, "Couldn't start the turn.");
        });
      if (o.inject?.length && !o.threadId) request("thread/inject_items", { threadId, items: o.inject }, (r) => (r.error ? fail(r, "Couldn't import history.") : turn()));
      else turn();
    };
    if (o.threadId) request("thread/resume", { threadId: o.threadId, excludeTurns: true, ...threadSettings(o.mode, o.model) }, onThreadReady);
    else request("thread/start", { cwd: o.cwd, ...threadSettings(o.mode, o.model) }, onThreadReady);
  });

  return run;
}
