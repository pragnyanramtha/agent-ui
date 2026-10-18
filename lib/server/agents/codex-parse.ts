import type { Entry, ToolResult } from "@/lib/types";

/* Codex rollout records (~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl)
 * mapped to the UI's Entry stream. Each line is {timestamp, type, payload}.
 * `response_item` lines are the model-visible conversation and are the only
 * source for messages and tools; `event_msg` item_completed lines repeat the
 * same items for clients and are ignored (that is the dedupe). Tool calls get
 * Claude-like names so the existing tool renderers apply. */

const RESULT_MAX = 8_000;
const INPUT_STRING_MAX = 24_000;
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

type Part = { type?: string; text?: string };
type Payload = Record<string, unknown> & { type?: string };
export type CodexRecord = { timestamp?: string; type?: string; payload?: Payload };

/** Parse state carried across lines (and across reads of a live tail). */
export type ParseCtx = { model: string; lastTotal?: string };

const str = (v: unknown) => (typeof v === "string" ? v : "");
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function clip(text: string, max = RESULT_MAX) {
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}

/* encrypted payloads (inter-agent messages, reasoning) are opaque base64 blobs */
const ENCRYPTED = /^gAAAAA[A-Za-z0-9_=-]{40,}$/;

function trimInput(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    if (ENCRYPTED.test(value)) return "[encrypted]";
    return value.length > INPUT_STRING_MAX ? `${value.slice(0, INPUT_STRING_MAX)}\n…` : value;
  }
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => trimInput(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trimInput(v, depth + 1)]));
}

const asInput = (v: unknown) => trimInput(obj(v)) as Record<string, unknown>;

function jsonOr(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** Codex errors often wrap the API's JSON body in the message: surface the human part. */
export function errorText(message: string): string {
  const parsed = obj(jsonOr(message.trim()));
  const inner = str(obj(parsed.error).message) || str(parsed.message);
  return (inner || message).trim();
}

/* ---------- user messages ---------- */

/* context Codex injects as "user" turns; not typed by anyone */
const INJECTED = /^(<environment_context>|<user_instructions>|<permissions instructions>|<collaboration_mode>|<skills_instructions>|<apps_instructions>|# AGENTS\.md instructions|<INSTRUCTIONS>)/;

function userEntries(p: Payload, id: string, ts: string): Entry[] {
  const parts = Array.isArray(p.content) ? (p.content as Part[]) : [];
  const texts: string[] = [];
  let images = 0;
  for (const part of parts) {
    if ((part.type === "input_text" || part.type === "text") && part.text) texts.push(part.text);
    else if (part.type === "input_image" || part.type === "image") images += 1;
  }
  const text = texts.join("\n\n").trim();
  if (!text && !images) return [];
  if (INJECTED.test(text)) return [];
  if (text.startsWith("<turn_aborted>")) return [{ kind: "notice", id, ts, tone: "warn", text: "Stopped" }];
  const shell = /^<user_shell_command>([\s\S]*?)<\/user_shell_command>/.exec(text);
  if (shell) {
    const cmd = /<command>([\s\S]*?)<\/command>/.exec(shell[1])?.[1]?.trim();
    return cmd ? [{ kind: "user", id, ts, text: `! ${cmd}`, images: 0 }] : [];
  }
  /* image placeholders Codex inlines around attachments */
  const clean = text.replace(/<\/?image[^>]*>/g, "").trim();
  return clean || images ? [{ kind: "user", id, ts, text: clean, images }] : [];
}

/** First human-typed text of a record, for titles (null when injected context or not a user message). */
export function userTitle(rec: CodexRecord): string | null {
  const p = rec.payload;
  if (rec.type !== "response_item" || p?.type !== "message" || p.role !== "user") return null;
  const e = userEntries(p, "", "");
  return e[0]?.kind === "user" && e[0].text ? e[0].text : null;
}

/* ---------- code mode scripts (custom tool "exec") ---------- */

/** A lenient reader for the JS literals the model writes as tool arguments (bare keys, ', ", ` strings). */
function readLiteral(src: string, start: number): { value: unknown; end: number } {
  let i = start;
  const ws = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src.startsWith("//", i)) {
        const nl = src.indexOf("\n", i);
        i = nl === -1 ? src.length : nl + 1;
      } else if (src.startsWith("/*", i)) {
        const close = src.indexOf("*/", i + 2);
        i = close === -1 ? src.length : close + 2;
      } else return;
    }
  };
  const fail = (): never => {
    throw new Error("unsupported literal");
  };
  const readString = (): string => {
    const q = src[i];
    if (q === '"') {
      /* JSON-compatible: let JSON.parse handle escapes */
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      const raw = src.slice(i, j + 1);
      i = j + 1;
      const v = jsonOr(raw);
      return typeof v === "string" ? v : fail();
    }
    let out = "";
    i++;
    while (i < src.length && src[i] !== q) {
      const c = src[i];
      if (q === "`" && c === "$" && src[i + 1] === "{") fail();
      if (c === "\\") {
        const n = src[i + 1];
        out += n === "n" ? "\n" : n === "t" ? "\t" : n === "r" ? "\r" : n === "0" ? "\0" : n === "\n" ? "" : n;
        i += 2;
      } else {
        out += c;
        i++;
      }
    }
    if (i >= src.length) fail();
    i++;
    return out;
  };
  const value = (depth: number): unknown => {
    if (depth > 20) fail();
    ws();
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") return readString();
    if (c === "{") {
      i++;
      const out: Record<string, unknown> = {};
      for (;;) {
        ws();
        if (src[i] === "}") {
          i++;
          return out;
        }
        let key: string;
        if (src[i] === '"' || src[i] === "'") key = readString();
        else {
          const m = /^[A-Za-z_$][\w$]*|^\d+/.exec(src.slice(i, i + 200));
          if (!m) fail();
          key = m![0];
          i += key.length;
        }
        ws();
        if (src[i] !== ":") fail();
        i++;
        out[key] = value(depth + 1);
        ws();
        if (src[i] === ",") i++;
        else if (src[i] !== "}") fail();
      }
    }
    if (c === "[") {
      i++;
      const out: unknown[] = [];
      for (;;) {
        ws();
        if (src[i] === "]") {
          i++;
          return out;
        }
        out.push(value(depth + 1));
        ws();
        if (src[i] === ",") i++;
        else if (src[i] !== "]") fail();
      }
    }
    const m = /^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null|undefined)/.exec(src.slice(i, i + 40));
    if (!m) fail();
    i += m![0].length;
    const t = m![0];
    return t === "true" ? true : t === "false" ? false : t === "null" || t === "undefined" ? null : Number(t);
  };
  const v = value(0);
  return { value: v, end: i };
}

/** `args` is null when they aren't plain literals; [start, end) spans `tools.x(...)` */
type ScriptCall = { name: string; args: unknown[] | null; start: number; end: number };

/** `tools.<name>(<literal>, ...)` calls in a script, skipping string contents. */
export function scriptCalls(code: string): ScriptCall[] {
  const calls: ScriptCall[] = [];
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < code.length && code[i] !== c) i += code[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (c === "t" && code.startsWith("tools.", i) && !/[\w$.]/.test(code[i - 1] ?? "")) {
      const m = /^tools\.([A-Za-z_$][\w$]*)\s*\(/.exec(code.slice(i, i + 200));
      if (m) {
        let j = i + m[0].length;
        let args: unknown[] | null = [];
        try {
          for (;;) {
            while (/\s/.test(code[j] ?? "")) j++;
            if (code[j] === ")") break;
            const r = readLiteral(code, j);
            args.push(r.value);
            j = r.end;
            while (/\s/.test(code[j] ?? "")) j++;
            if (code[j] === ",") j++;
            else if (code[j] !== ")") throw new Error("expression");
          }
        } catch {
          args = null;
        }
        if (args) {
          /* skip past the parsed arguments: their strings are already consumed */
          calls.push({ name: m[1], args, start: i, end: j + 1 });
          i = j + 1;
        } else {
          calls.push({ name: m[1], args, start: i, end: i + m[0].length });
          i += m[0].length;
        }
        continue;
      }
    }
    i++;
  }
  return calls;
}

type Tool = { name: string; input: Record<string, unknown> };

const shellJoin = (argv: string[]) => argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");

/** argv like ["bash","-lc","<script>"] is just the script. */
function commandText(cmd: unknown): string {
  if (typeof cmd === "string") return cmd;
  if (!Array.isArray(cmd)) return "";
  const argv = cmd.map(String);
  if (argv.length === 3 && /(^|\/)(ba|z)?sh$/.test(argv[0]) && /^-l?c$/.test(argv[1])) return argv[2];
  return shellJoin(argv);
}

function bash(command: string, description?: string): Tool {
  return { name: "Bash", input: description ? { command, description } : { command } };
}

function todoWrite(args: Record<string, unknown>): Tool {
  const plan = Array.isArray(args.plan) ? (args.plan as Record<string, unknown>[]) : [];
  const todos = plan.map((s) => {
    const st = str(s.status);
    return { content: str(s.step) || str(s.content), status: st === "completed" ? "completed" : st === "in_progress" ? "in_progress" : "pending" };
  });
  return { name: "TodoWrite", input: str(args.explanation) ? { todos, explanation: args.explanation } : { todos } };
}

/** One named tool with object arguments (classic Codex function tools and code-mode tools share names). */
function namedTool(name: string, a: Record<string, unknown>): Tool {
  switch (name) {
    case "shell":
    case "container.exec":
    case "local_shell":
    case "shell_command":
      return bash(commandText(a.command ?? a.cmd), str(a.justification) || undefined);
    case "exec_command":
      return bash(commandText(a.cmd ?? a.command), str(a.justification) || undefined);
    case "apply_patch":
      return { name: "ApplyPatch", input: { patch: str(a.input) || str(a.patch) } };
    case "update_plan":
      return todoWrite(a);
    case "read_file":
      return { name: "Read", input: { file_path: str(a.file_path) || str(a.path), ...(typeof a.offset === "number" ? { offset: a.offset } : {}), ...(typeof a.limit === "number" ? { limit: a.limit } : {}) } };
    case "view_image":
      return { name: "Read", input: { file_path: str(a.path) } };
    case "grep_files":
      return { name: "Grep", input: { pattern: str(a.pattern), path: str(a.path), ...(str(a.include) ? { glob: a.include } : {}) } };
    case "list_dir":
      return { name: "Glob", input: { pattern: "*", path: str(a.dir_path) || str(a.path) } };
    case "web__run":
    case "web_search": {
      const q = Array.isArray(a.search_query) ? str(obj(a.search_query[0]).q) : str(a.query) || str(a.q);
      return q ? { name: "WebSearch", input: { query: q } } : { name, input: asInput(a) };
    }
    default:
      return { name, input: asInput(a) };
  }
}

function callTool(c: ScriptCall): Tool {
  const a = c.args ?? [];
  if (c.name === "apply_patch") return { name: "ApplyPatch", input: { patch: typeof a[0] === "string" ? a[0] : str(obj(a[0]).input) } };
  if (c.name === "write_stdin") return { name: "BashOutput", input: asInput(a[0]) };
  return namedTool(c.name, typeof a[0] === "string" ? { input: a[0] } : obj(a[0]));
}

/* What's left of a script once its tool calls are cut out, for the two shapes the model writes almost always:
 * `text(await tools.a(..)); text(await tools.b(..));` and
 * `const rs = await Promise.allSettled([tools.a(..), tools.b(..)]); for (let i = 0; i < rs.length; i++) text({i, result: rs[i]});` */
const SEQUENCE = /^(text\(await@\);?)+$/;
const ALL_SETTLED = /^const([\w$]+)=awaitPromise\.allSettled\(\[@(,@)*,?\]\);?for\(let([\w$]+)=0;\3<\1\.length;\3\+\+\)\{?text\(\{\3,result:\1\[\3\]\}\);?\}?;?$/;

/**
 * A code-mode script as tools. When each call prints exactly one output part
 * (the two shapes above), every call becomes its own tool with toolUseId
 * `${callId}:${i}`, paired with the matching output part; otherwise the script
 * is one tool: shell-only work reads as Bash, else the raw code.
 */
export function scriptTools(code: string): { tools: Tool[]; split: boolean } {
  const calls = scriptCalls(code);
  const parsed = calls.length > 0 && calls.every((c) => c.args !== null);
  if (parsed) {
    let residue = "";
    let at = 0;
    for (const c of calls) {
      residue += `${code.slice(at, c.start)}@`;
      at = c.end;
    }
    residue = (residue + code.slice(at)).replace(/\s+/g, "");
    if (SEQUENCE.test(residue) || ALL_SETTLED.test(residue)) {
      const tools = calls.map(callTool);
      return { tools, split: tools.length > 1 };
    }
    const execs = calls.filter((c) => c.name === "exec_command");
    if (execs.length && calls.every((c) => c.name === "exec_command" || c.name === "write_stdin") && !/ALL_TOOLS/.test(residue)) {
      const cmds = execs.map((c) => commandText(obj(c.args![0]).cmd));
      const why = execs.map((c) => str(obj(c.args![0]).justification)).find(Boolean);
      return { tools: [bash(cmds.join("\n"), why)], split: false };
    }
  }
  return { tools: [{ name: "exec", input: { code: trimInput(code) } }], split: false };
}

/* ---------- tool output ---------- */

type Unwrapped = { text: string; error: boolean };

/** Code-mode results are JSON per text() call: unwrap to the command output. */
function unwrapValue(v: unknown): Unwrapped {
  if (typeof v === "string") return { text: v, error: false };
  if (Array.isArray(v)) {
    const parts = v.map(unwrapValue);
    return { text: parts.map((p) => p.text).join("\n"), error: parts.some((p) => p.error) };
  }
  const o = obj(v);
  if (typeof o.output === "string") {
    const code = typeof o.exit_code === "number" ? o.exit_code : obj(o.metadata).exit_code;
    const failed = typeof code === "number" && code !== 0;
    return { text: o.output + (failed && !o.output.trim() ? `Exit code ${code}` : ""), error: failed };
  }
  if ("result" in o && obj(o.result).status) {
    const r = obj(o.result);
    if (r.status === "rejected") return { text: errorText(str(obj(r.reason).message) || JSON.stringify(r.reason ?? "")), error: true };
    return unwrapValue(r.value);
  }
  if (Array.isArray(o.content)) {
    const t = (o.content as Part[]).map((p) => (p.type === "text" ? p.text ?? "" : "")).filter(Boolean).join("\n");
    return { text: t, error: o.isError === true };
  }
  if (v === null || v === undefined) return { text: "", error: false };
  return { text: JSON.stringify(v, null, 2), error: false };
}

function outputText(output: unknown, codeMode: boolean): Unwrapped {
  const parts: string[] =
    typeof output === "string" ? [output] : Array.isArray(output) ? (output as Part[]).map((p) => (p.type === "input_image" ? "[image]" : p.text ?? "")) : [JSON.stringify(output ?? "")];
  let error = false;
  const texts: string[] = [];
  parts.forEach((raw, i) => {
    if (codeMode && i === 0 && Array.isArray(output)) {
      /* "Script completed\nWall time 4.0 seconds\nOutput:\n" header */
      const ok = /^Script completed\b/.test(raw);
      if (!ok) error = true;
      const rest = raw.replace(/^Script \w+\nWall time [^\n]*\n(Output:\n)?/, "");
      if (!ok || rest.trim()) texts.push(ok ? rest : raw);
      return;
    }
    const trimmed = raw.trim();
    const parsed = trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith('"') ? jsonOr(trimmed) : undefined;
    if (parsed === undefined) {
      texts.push(raw);
      return;
    }
    const u = unwrapValue(parsed);
    error ||= u.error;
    texts.push(u.text);
  });
  return { text: texts.join("\n").replace(ANSI, "").replace(/\n{3,}/g, "\n\n"), error };
}

function result(id: string, ts: string, callId: string, output: unknown, codeMode: boolean, failed = false): Entry {
  const u = outputText(output, codeMode);
  const c = clip(u.text);
  const r: ToolResult = { text: c.text, truncated: c.truncated, isError: u.error || failed };
  return { kind: "result", id, ts, toolUseId: callId, result: r };
}

/* ---------- records ---------- */

/** Entries for one rollout line. `id` is a stable per-line base (its byte offset). */
export function parseRecord(rec: CodexRecord, base: string, ctx: ParseCtx): Entry[] {
  const ts = rec.timestamp ?? "";
  const p = rec.payload ?? {};
  const pt = p.type;

  if (rec.type === "turn_context") {
    if (str(p.model)) ctx.model = str(p.model);
    return [];
  }
  if (rec.type === "compacted") return [{ kind: "notice", id: base, ts, tone: "info", text: "Context compacted" }];

  if (rec.type === "event_msg") {
    if (pt === "thread_settings_applied") {
      const m = str(obj(p.thread_settings).model);
      if (m) ctx.model = m;
      return [];
    }
    if (pt === "token_count") {
      const info = obj(p.info);
      const u = obj(info.last_token_usage);
      if (!Object.keys(u).length) return [];
      /* Codex re-emits the same counts (e.g. at turn end): an unchanged running total is not a new request */
      const total = JSON.stringify(info.total_token_usage ?? null);
      if (total !== "null" && total === ctx.lastTotal) return [];
      ctx.lastTotal = total;
      const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
      const cached = n("cached_input_tokens");
      const window = typeof info.model_context_window === "number" && info.model_context_window > 0 ? info.model_context_window : undefined;
      return [{ kind: "usage", id: `${base}:usage`, ts, model: ctx.model, input: Math.max(0, n("input_tokens") - cached), cacheRead: cached, cacheWrite: n("cache_write_input_tokens"), output: n("output_tokens"), ...(window ? { window } : {}) }];
    }
    if (pt === "task_complete") {
      const msg = str(obj(p.error).message);
      return msg ? [{ kind: "notice", id: base, ts, tone: "warn", text: errorText(msg) }] : [];
    }
    if (pt === "error" || pt === "stream_error") {
      const msg = str(p.message);
      return msg && pt === "error" ? [{ kind: "notice", id: base, ts, tone: "warn", text: errorText(msg) }] : [];
    }
    if (pt === "turn_aborted") return [{ kind: "notice", id: base, ts, tone: "warn", text: "Stopped" }];
    return [];
  }

  if (rec.type !== "response_item") return [];
  const msgId = str(p.id) || base;

  if (pt === "message") {
    if (p.role === "user") return userEntries(p, base, ts);
    if (p.role !== "assistant") return [];
    const parts = Array.isArray(p.content) ? (p.content as Part[]) : [];
    return parts.flatMap((part, i): Entry[] =>
      (part.type === "output_text" || part.type === "text") && part.text?.trim() ? [{ kind: "text", id: `${base}:${i}`, ts, msgId, text: part.text }] : [],
    );
  }

  if (pt === "reasoning") {
    const summary = Array.isArray(p.summary) ? (p.summary as Part[]) : [];
    const content = Array.isArray(p.content) ? (p.content as Part[]) : [];
    const text = (summary.length ? summary : content).map((s) => s.text ?? "").filter(Boolean).join("\n\n").trim();
    return text ? [{ kind: "thinking", id: base, ts, msgId, text }] : [];
  }

  if (pt === "function_call" || pt === "custom_tool_call") {
    const callId = str(p.call_id) || msgId;
    const name = str(p.name) || "tool";
    let tool: Tool;
    if (pt === "custom_tool_call") {
      const input = str(p.input);
      if (name === "exec") {
        /* a script of several calls becomes one tool per call, each paired with its own output part */
        const { tools, split } = scriptTools(input);
        if (split) return tools.map((t, i): Entry => ({ kind: "tool", id: `${base}:${i}`, ts, msgId, toolUseId: `${callId}:${i}`, name: t.name, input: t.input }));
        tool = tools[0];
      } else tool = namedTool(name, { input });
    } else {
      const raw = str(p.arguments);
      const args = jsonOr(raw);
      tool = args && typeof args === "object" ? namedTool(name, obj(args)) : { name, input: raw ? { arguments: trimInput(raw) } : {} };
    }
    return [{ kind: "tool", id: base, ts, msgId, toolUseId: callId, name: tool.name, input: tool.input }];
  }

  if (pt === "function_call_output" || pt === "custom_tool_call_output") {
    const callId = str(p.call_id);
    if (!callId) return [];
    const out = p.output;
    /* classic outputs may be {content, success} objects */
    const o = obj(out);
    if (typeof o.content === "string") return [result(base, ts, callId, o.content, false, o.success === false)];
    const whole = result(base, ts, callId, out, pt === "custom_tool_call_output");
    /* code-mode output is [header, one part per text() call]: part j answers split call j-1 (unmatched ids are ignored by the UI) */
    if (pt !== "custom_tool_call_output" || !Array.isArray(out) || out.length < 3) return [whole];
    const parts = (out as Part[]).slice(1).map((part, j) => result(`${base}:${j + 1}`, ts, `${callId}:${j}`, part.text ?? "", false, whole.kind === "result" && whole.result.isError && /^Script (failed|error)/.test(String((out as Part[])[0]?.text ?? ""))));
    return [whole, ...parts];
  }

  if (pt === "local_shell_call") {
    const callId = str(p.call_id) || msgId;
    const action = obj(p.action);
    return [{ kind: "tool", id: base, ts, msgId, toolUseId: callId, name: "Bash", input: { command: commandText(action.command) } }];
  }

  if (pt === "web_search_call") {
    const action = obj(p.action);
    const q = str(action.query) || (Array.isArray(action.queries) ? String(action.queries[0] ?? "") : "");
    return q ? [{ kind: "tool", id: base, ts, msgId, toolUseId: msgId, name: "WebSearch", input: { query: q } }] : [];
  }

  if (pt === "agent_message") {
    const author = str(p.author);
    return author ? [{ kind: "notice", id: base, ts, tone: "info", text: `Message from ${author}` }] : [];
  }

  return [];
}

export function safeParse(line: string): CodexRecord | null {
  try {
    const v = JSON.parse(line);
    return v && typeof v === "object" ? (v as CodexRecord) : null;
  } catch {
    return null;
  }
}

/** Lines with their byte offsets -> entries (ids `${offset}` / `${offset}:${i}`, stable across pages). */
export function parseLines(lines: { off: number; line: string }[], ctx: ParseCtx): Entry[] {
  const out: Entry[] = [];
  for (const { off, line } of lines) {
    const rec = safeParse(line);
    if (rec) out.push(...parseRecord(rec, String(off), ctx));
  }
  return out;
}
