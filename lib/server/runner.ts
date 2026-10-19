import { randomUUID } from "node:crypto";
import { query, type CanUseTool, type PermissionResult, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Entry, PendingAsk, PermissionMode, Question, RunState, StreamDelta } from "@/lib/types";

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
import { CLAUDE_BIN, IDLE_REAP_MS } from "./config";
import { LIMIT_ERROR, type ResolvedProfile } from "./profiles";

/** A profile's args for the SDK: "--flag value" / "--flag" pairs as extraArgs, and short flags ("-d x") as they are.
 * The SDK writes every extraArgs key as "--key", so short flags go in executableArgs, which it puts before its own
 * args when the CLI is a native binary (for a .js CLI they would go to node instead, so they are dropped there). */
export function profileArgs(args: string[], bin?: string | null): { extraArgs?: Record<string, string | null>; executableArgs?: string[] } {
  const extra: Record<string, string | null> = {};
  const short: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const [k, v] = args[i].slice(2).split(/=(.*)/s);
      if (v !== undefined) extra[k] = v;
      else if (args[i + 1] !== undefined && !args[i + 1].startsWith("--")) extra[k] = args[++i];
      else extra[k] = null;
    } else if (/^-[^-]/.test(args[i])) {
      short.push(args[i]);
      if (args[i + 1] !== undefined && !args[i + 1].startsWith("-")) short.push(args[++i]);
    }
  }
  const jsCli = /\.(m?js|jsx|tsx?)$/.test(bin ?? "");
  if (short.length && jsCli) console.warn(`profile args ${short.join(" ")} skipped: short flags need a native claude binary`);
  return {
    ...(Object.keys(extra).length ? { extraArgs: extra } : {}),
    ...(short.length && !jsCli ? { executableArgs: short } : {}),
  };
}

/* A web run drives one `claude` process through the Agent SDK in streaming
 * input mode, so a session can take many messages without respawning. The
 * transcript file stays the source of truth for history; a run only adds what
 * the file can't carry: token deltas, status, and pending approvals. */

export type RunEvent =
  | { type: "delta"; delta: StreamDelta }
  | { type: "run"; run: RunState }
  | { type: "redirect"; sessionId: string }
  /* output the transcript doesn't carry (slash command output, notices), replayed to late viewers */
  | { type: "entries"; entries: Entry[] };

/** the modes the web UI can show; others the CLI may report (e.g. "dontAsk") leave the current one */
const MODES: string[] = ["default", "acceptEdits", "bypassPermissions", "plan"] satisfies PermissionMode[];

type Decision = { allow: boolean; always?: boolean; answers?: Record<string, string>; message?: string };

/** Older CLIs don't send a prompt sentence with permission asks; write one in the same voice. */
function askTitle(toolName: string, input: Record<string, unknown>, displayName?: string) {
  const file = typeof input.file_path === "string" ? input.file_path.split("/").pop() : null;
  if ((toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") && file) return `Let Claude edit ${file}?`;
  if (toolName === "Bash") return "Let Claude run this command?";
  if (toolName === "WebFetch") return "Let Claude fetch this page?";
  return `Let Claude use ${displayName ?? toolName}?`;
}

/** What a failed turn says. Limit hits must read as one (LIMIT_ERROR), or fallback profiles never take over. */
export function turnError(m: Extract<SDKMessage, { type: "result" }>): string {
  const said = (m.subtype === "success" ? m.result : (m.errors ?? []).join("; ")).trim().slice(0, 300);
  if (m.terminal_reason === "blocking_limit" || m.terminal_reason === "rapid_refill_breaker") {
    return LIMIT_ERROR.test(said) ? said : `Usage limit reached${said ? `: ${said}` : "."}`;
  }
  return said || (m.subtype === "success" ? "The turn failed." : `Turn ended: ${m.subtype.replace(/_/g, " ")}`);
}

class Inbox implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private done = false;

  push(message: SDKUserMessage) {
    this.queue.push(message);
    this.wake?.();
  }

  end() {
    this.done = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator]() {
    for (;;) {
      while (this.queue.length) yield this.queue.shift()!;
      if (this.done) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = null;
    }
  }
}

export class Run {
  readonly state: RunState;
  private q: Query;
  private inbox = new Inbox();
  private listeners = new Set<(e: RunEvent) => void>();
  /** server-side watchers (fallback); unlike viewers they don't keep an idle run alive */
  private observers = new Set<(e: RunEvent) => void>();
  readonly profile: ResolvedProfile | null;
  /** the last message sent, so a failed turn can be retried elsewhere */
  lastText = "";
  private decisions = new Map<string, { resolve: (d: Decision) => void; ask: PendingAsk; input: Record<string, unknown>; suggestions?: unknown[] }>();
  private blockKinds = new Map<number, "text" | "thinking">();
  private msgId = "";
  private reaper: NodeJS.Timeout | null = null;
  private ready: Promise<string>;
  private markReady!: (id: string) => void;
  private initialized = false;
  private ended = false;

  readonly cwd: string;

  constructor(opts: { resume?: string; fork?: boolean; cwd: string; model?: string; permissionMode: PermissionMode; profile?: ResolvedProfile | null }) {
    this.cwd = opts.cwd;
    this.profile = opts.profile ?? null;
    const p = this.profile;
    const model = opts.model ?? p?.defaultModel;
    this.state = {
      status: "starting",
      model: model ?? null,
      permissionMode: opts.permissionMode,
      slashCommands: [],
      pending: [],
      error: null,
      costUsd: null,
      sessionId: opts.resume ?? "",
    };
    this.ready = new Promise((resolve) => (this.markReady = resolve));
    this.q = query({
      prompt: this.inbox,
      options: {
        cwd: opts.cwd,
        resume: opts.resume,
        forkSession: opts.fork,
        model,
        permissionMode: opts.permissionMode,
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        promptSuggestions: true,
        settingSources: ["user", "project", "local"],
        systemPrompt: { type: "preset", preset: "claude_code" },
        pathToClaudeCodeExecutable: (p?.bin ? p.binPath : null) ?? CLAUDE_BIN,
        ...(p && Object.keys(p.env).length ? { env: { ...process.env, ...p.env } } : {}),
        ...(p?.args.length ? profileArgs(p.args, (p.bin ? p.binPath : null) ?? CLAUDE_BIN) : {}),
        canUseTool: this.canUseTool,
        stderr: (data) => process.stderr.write(`[claude ${this.state.sessionId.slice(0, 8)}] ${data}`),
      },
    });
    void this.loop();
  }

  /** Resolves with the session id once the CLI reports it (new sessions and forks get a fresh one), or "" if it ended first. */
  sessionId() {
    return this.ready;
  }

  get live() {
    return !this.ended;
  }

  send(text: string) {
    if (this.ended) return;
    this.lastText = text;
    clearFailure(this.state.sessionId);
    this.inbox.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    } as SDKUserMessage);
    this.update({ status: "running", error: null, suggestion: null });
  }

  subscribe(fn: (e: RunEvent) => void) {
    this.listeners.add(fn);
    this.scheduleReap();
    return () => {
      this.listeners.delete(fn);
      this.scheduleReap();
    };
  }

  observe(fn: (e: RunEvent) => void) {
    this.observers.add(fn);
    return () => void this.observers.delete(fn);
  }

  /** A line in the thread that isn't in the transcript (e.g. "continuing on another profile"). */
  notice(text: string, tone: "info" | "warn" = "info") {
    this.extra({ kind: "notice", id: randomUUID(), ts: new Date().toISOString(), tone, text });
  }

  respond(requestId: string, decision: Decision) {
    const waiting = this.decisions.get(requestId);
    if (!waiting) return false;
    waiting.resolve(decision);
    return true;
  }

  async interrupt() {
    await this.q.interrupt().catch(() => undefined);
  }

  async setPermissionMode(mode: PermissionMode) {
    await this.q.setPermissionMode(mode);
    this.update({ permissionMode: mode });
  }

  async setModel(model: string | undefined) {
    await this.q.setModel(model);
    this.update({ model: model ?? null });
  }

  close() {
    this.end({ status: "closed" });
  }

  /** Runs once, whichever comes first: close(), the process exiting, or the SDK throwing. */
  private end(patch: Partial<RunState>) {
    if (this.ended) return;
    this.ended = true;
    if (registry().get(this.state.sessionId) === this) registry().delete(this.state.sessionId);
    this.inbox.end();
    this.decisions.forEach(({ resolve }) => resolve({ allow: false, message: "Session closed" }));
    try {
      this.q.close();
    } catch {
      /* already gone */
    }
    this.update(patch);
    /* the run is gone but the session's list row, the inbox and push still have to say the last turn failed */
    if (this.state.error && this.state.sessionId) recordFailure(this.state.sessionId, { ...this.state, status: "error", pending: [], suggestion: null });
    this.markReady(this.initialized ? this.state.sessionId : "");
  }

  private emit(e: RunEvent) {
    this.listeners.forEach((fn) => fn(e));
    this.observers.forEach((fn) => fn(e));
  }

  /** Entries only this run knows (kept for viewers who connect later; the newest 50). */
  readonly extras: Entry[] = [];
  private extra(e: Entry) {
    this.extras.push(e);
    if (this.extras.length > 50) this.extras.shift();
    this.emit({ type: "entries", entries: [e] });
  }

  private update(patch: Partial<RunState>) {
    Object.assign(this.state, patch);
    this.emit({ type: "run", run: { ...this.state, pending: [...this.state.pending] } });
    this.scheduleReap();
  }

  /* Idle runs with nobody watching are shut down; the next message resumes the session. */
  private scheduleReap() {
    if (this.reaper) clearTimeout(this.reaper);
    this.reaper = null;
    if (this.ended || this.listeners.size > 0) return;
    this.reaper = setTimeout(() => {
      if (this.state.status !== "running" && this.state.pending.length === 0 && this.listeners.size === 0) this.close();
      else this.scheduleReap();
    }, IDLE_REAP_MS);
  }

  private canUseTool: CanUseTool = (toolName, input, options) =>
    new Promise<PermissionResult>((resolve) => {
      if (this.ended || options.signal.aborted) return resolve({ behavior: "deny", message: "Cancelled" });
      const requestId = randomUUID();
      const ask: PendingAsk =
        toolName === "AskUserQuestion"
          ? { kind: "question", requestId, questions: (input.questions as Question[]) ?? [] }
          : {
              kind: "permission",
              requestId,
              toolName,
              title: options.title ?? askTitle(toolName, input, options.displayName),
              description: options.description ?? (options.decisionReason?.includes(" ") ? options.decisionReason : null),
              input,
              canAlwaysAllow: !options.suppressAlwaysAllowRule && Boolean(options.suggestions?.length),
            };
      const finish = (result: PermissionResult) => {
        if (!this.decisions.delete(requestId)) return;
        this.update({ pending: this.state.pending.filter((p) => p.requestId !== requestId) });
        resolve(result);
      };
      this.decisions.set(requestId, {
        ask,
        input,
        suggestions: options.suggestions,
        resolve: (d) => {
          if (!d.allow) return finish({ behavior: "deny", message: d.message ?? "The user declined this from the web UI." });
          if (ask.kind === "question") return finish({ behavior: "allow", updatedInput: { ...input, answers: d.answers ?? {} } });
          finish({ behavior: "allow", updatedInput: input, updatedPermissions: d.always ? options.suggestions : undefined });
        },
      });
      options.signal.addEventListener("abort", () => finish({ behavior: "deny", message: "Cancelled" }), { once: true });
      this.update({ pending: [...this.state.pending, ask] });
    });

  private rekey(id: string) {
    const previous = this.state.sessionId;
    if (previous === id) return;
    /* a fork starts out labelled with its source id but was never registered under it */
    if (previous && registry().get(previous) === this) registry().delete(previous);
    /* never leave two live processes writing one transcript */
    const clash = registry().get(id);
    if (clash && clash !== this) clash.close();
    this.state.sessionId = id;
    if (previous) this.emit({ type: "redirect", sessionId: id });
    register(id, this);
  }

  private handle(m: SDKMessage) {
    if (this.ended) return;
    if (m.type === "system" && m.subtype === "init") {
      this.initialized = true;
      this.rekey(m.session_id);
      const hidden = new Set(m.terminal_slash_commands ?? []);
      this.update({
        model: m.model,
        permissionMode: (MODES.includes(m.permissionMode) ? m.permissionMode : this.state.permissionMode) as PermissionMode,
        slashCommands: m.slash_commands.filter((c) => !hidden.has(c)),
      });
      this.markReady(m.session_id);
      return;
    }
    /* /context, /usage, /cost and friends answer outside the transcript */
    if (m.type === "system" && m.subtype === "local_command_output") {
      this.extra({ kind: "text", id: m.uuid, ts: new Date().toISOString(), msgId: m.uuid, text: m.content.replace(ANSI, "") });
      return;
    }
    if (m.type === "system" && m.subtype === "informational" && (m.level === "warning" || m.level === "suggestion")) {
      this.extra({ kind: "notice", id: m.uuid, ts: new Date().toISOString(), tone: m.level === "warning" ? "warn" : "info", text: m.content.replace(ANSI, "") });
      return;
    }
    if (m.type === "system" && m.subtype === "commands_changed") {
      this.update({ slashCommands: m.commands.map((c) => c.name) });
      return;
    }
    if (m.type === "prompt_suggestion") {
      this.update({ suggestion: m.suggestion });
      return;
    }
    /* the mode can change inside the CLI (plan mode accepted, Shift+Tab, a hook); keep the composer in step */
    if (m.type === "system" && m.subtype === "status") {
      if (m.permissionMode && m.permissionMode !== this.state.permissionMode && MODES.includes(m.permissionMode)) this.update({ permissionMode: m.permissionMode as PermissionMode });
      return;
    }
    if (m.type === "system" && m.subtype === "session_state_changed") {
      this.update({ status: m.state === "idle" ? "idle" : "running" });
      return;
    }
    if (m.type === "stream_event" && !m.parent_tool_use_id) {
      const ev = m.event;
      if (ev.type === "message_start") {
        this.msgId = ev.message.id;
        this.blockKinds.clear();
      } else if (ev.type === "content_block_start") {
        if (ev.content_block.type === "text" || ev.content_block.type === "thinking") this.blockKinds.set(ev.index, ev.content_block.type);
      } else if (ev.type === "content_block_delta") {
        const kind = this.blockKinds.get(ev.index);
        const text = ev.delta.type === "text_delta" ? ev.delta.text : ev.delta.type === "thinking_delta" ? ev.delta.thinking : "";
        if (kind && text) this.emit({ type: "delta", delta: { msgId: this.msgId, index: ev.index, kind, text } });
      }
      return;
    }
    if (m.type === "result") {
      /* a deliberate Stop isn't a failure */
      const stopped = m.terminal_reason === "aborted_streaming" || m.terminal_reason === "aborted_tools";
      this.update({
        /* sends queued mid-turn run next without new input: still busy until session_state_changed says idle */
        status: m.queued_turn_count ? "running" : "idle",
        costUsd: m.total_cost_usd ?? this.state.costUsd,
        error: !m.is_error || stopped ? null : turnError(m),
      });
    }
  }

  private async loop() {
    try {
      for await (const m of this.q) this.handle(m);
      this.end(this.initialized ? { status: "closed" } : { status: "error", error: this.state.error ?? "Claude exited before it started." });
    } catch (err) {
      this.end({ status: "error", error: err instanceof Error ? err.message : String(err) });
    }
  }
}

const g = globalThis as typeof globalThis & { __claudeUiRuns?: Map<string, Run>; __claudeUiRunWatchers?: Set<(id: string) => void> };
const registry = () => (g.__claudeUiRuns ??= new Map());
const watchers = () => (g.__claudeUiRunWatchers ??= new Set());

function register(id: string, run: Run) {
  registry().set(id, run);
  watchers().forEach((fn) => fn(id));
}

/** Called whenever a run takes over a session id, so viewers attach before a fast failure is over. */
export function onRunRegistered(fn: (id: string) => void) {
  watchers().add(fn);
  return () => void watchers().delete(fn);
}

/** Only live runs: one that closed or failed is gone, and the next message starts a fresh one. */
export const getRun = (id: string) => {
  const run = registry().get(id);
  return run?.live ? run : null;
};

export const activeRuns = () => [...registry().values()].filter((r) => r.live);

/* The final state of runs that ended on a failure, kept until the session's next message or terminal launch. */
const FAILURES_MAX = 200;
const failures = () => ((g as { __agentuRunFailures?: Map<string, RunState> }).__agentuRunFailures ??= new Map());

function recordFailure(id: string, state: RunState) {
  failures().delete(id);
  failures().set(id, state);
  for (const old of failures().keys()) {
    if (failures().size <= FAILURES_MAX) break;
    failures().delete(old);
  }
}

export const clearFailure = (id: string) => void failures().delete(id);

/** How the last run of a session ended, when it ended on a failure and nothing was sent since (status "error"). */
export const lastFailure = (id: string): RunState | null => failures().get(id) ?? null;

export function startRun(opts: ConstructorParameters<typeof Run>[0]) {
  const run = new Run(opts);
  /* forks are aliased under the source id until init re-keys them, so viewers of the source get the redirect */
  if (opts.resume) {
    getRun(opts.resume)?.close();
    clearFailure(opts.resume);
    register(opts.resume, run);
  }
  return run;
}
