import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import readline from "node:readline";
import type { AgentId, PermissionMode } from "@/lib/types";
import { AGENT_LABEL } from "@/lib/types";
import { parseEffort } from "@/lib/agent-traits";
import { adapterFor, parseSessionKey, sessionKey } from "./agents";
import { beforeTurn, turnRunning } from "./checkpoints";
import { guardTurn } from "./fallback";
import { copyCheckpoints, moveCheckpoints, rewind } from "./git";
import { handoff, loadSource } from "./handoff";
import { folderGone, parseMode, sessionContext } from "./http";
import { pickProfile, setSessionMeta, setSessionProfile, withProfile, type ResolvedProfile } from "./profiles";
import { startRun } from "./runner";
import { metaTitle } from "./transcript";
import { branchTitle, claudeCutter, rewriteRecord, truncateSource, type BranchKind, type BranchRequest } from "./branch-shape";

/* A new session from part of an existing one; the source is never touched.
 *  - Claude: a native transcript holding the kept records under a new id, resumed when there's a message to send
 *  - the other agents can't cut their own history, so the kept turns are handed off into a new session of the same
 *    agent and profile (Codex gets them as injected history, the rest in the first prompt)
 * Edit from here can first put the files back to the checkpoint taken before the edited prompt. */

export class BranchError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const START_MS = 90_000;
const NO_MESSAGE = "That message isn't in this session any more.";

type Opts = BranchRequest & { effort: string | null | undefined };

/** Copies the Claude transcript `file` up to where the cut says into a new session file next to it. */
async function cutClaudeTranscript(file: string, entryId: string, kind: BranchKind, title: string) {
  const cut = claudeCutter(entryId, kind);
  const id = randomUUID();
  const out = path.join(path.dirname(file), `${id}.jsonl`);
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const sink = createWriteStream(out, { mode: 0o600 });
  const write = async (s: string) => {
    if (!sink.write(`${s}\n`)) await once(sink, "drain");
  };
  try {
    for await (const line of lines) {
      if (!cut.take(line)) break;
      const rec = line ? rewriteRecord(line, id) : null;
      if (rec) await write(rec);
    }
    await write(JSON.stringify({ type: "custom-title", customTitle: branchTitle(title, kind), sessionId: id }));
  } finally {
    lines.close();
    input.destroy();
    sink.end();
    await once(sink, "close").catch(() => undefined);
  }
  if (!cut.found) {
    await fs.rm(out, { force: true });
    throw new BranchError(NO_MESSAGE, 404);
  }
  if (kind === "edit" && cut.kept === 0) {
    await fs.rm(out, { force: true });
    return { id: null, stopTs: cut.stopTs };
  }
  return { id, stopTs: cut.stopTs };
}

const timeout = <T>(p: Promise<T>, what: string) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new BranchError(`${what} didn't start in time.`, 502)), START_MS))]);

/** Puts the files back first when asked; a failure here leaves everything as it was. */
async function rewindFirst(key: string, cwd: string, checkpoint: string | null) {
  if (!checkpoint) return;
  await rewind(cwd, key, checkpoint);
}

async function claudeBranch(native: string, kind: BranchKind, o: Opts): Promise<string> {
  const key = native;
  const ctx = await sessionContext(native);
  if (!ctx) throw new BranchError("Session not found.", 404);
  if (await folderGone(ctx.cwd)) throw new BranchError("This session's folder is gone.", 409);
  const profile = pickProfile("claude", o.profile, key);
  if (o.text && profile.bin && !profile.binPath) throw new BranchError(`${profile.label} isn't installed.`);
  const mode = o.mode ?? parseMode(ctx.meta.permissionMode) ?? "default";
  const model = o.model ?? undefined;
  const { id, stopTs } = await cutClaudeTranscript(ctx.file, o.entryId, kind, metaTitle(ctx.meta) ?? "");
  const until = Date.parse(stopTs ?? "");
  if (kind === "edit") {
    try {
      await rewindFirst(key, ctx.cwd, o.checkpoint);
    } catch (err) {
      if (id) await fs.rm(path.join(path.dirname(ctx.file), `${id}.jsonl`), { force: true });
      throw err;
    }
  }
  if (id) {
    await copyCheckpoints(ctx.cwd, key, id, Number.isFinite(until) ? until : Infinity).catch(() => 0);
    setSessionProfile(id, profile.id);
    if (!o.text) return id;
    await beforeTurn(id, o.text, ctx.cwd);
    const run = startRun({ resume: id, cwd: ctx.cwd, model, effort: o.effort, permissionMode: mode, profile });
    run.send(o.text);
    guardTurn({ key: id, text: o.text, mode, model, effort: o.effort, profile });
    return id;
  }
  /* editing the first prompt: nothing earlier to keep, so it's a new session in the same folder */
  const provisional = `pending-${randomUUID()}`;
  await beforeTurn(provisional, o.text, ctx.cwd);
  const run = startRun({ cwd: ctx.cwd, model, effort: o.effort, permissionMode: mode, profile });
  run.send(o.text);
  const started = await Promise.race([run.sessionId(), new Promise<string>((r) => setTimeout(() => r(""), START_MS))]);
  if (!started) {
    run.close();
    throw new BranchError(run.state.error ?? "Claude didn't start in time.", 502);
  }
  await moveCheckpoints(ctx.cwd, provisional, started).catch(() => undefined);
  setSessionProfile(started, profile.id);
  guardTurn({ key: started, text: o.text, mode, model, effort: o.effort, profile });
  return started;
}

async function agentBranch(agent: AgentId, native: string, kind: BranchKind, o: Opts): Promise<string> {
  const key = sessionKey(agent, native);
  const src = await loadSource(key);
  if (!src) throw new BranchError("Session not found.", 404);
  if (!src.cwd) throw new BranchError("This session has no folder.", 409);
  if (await folderGone(src.cwd)) throw new BranchError("This session's folder is gone.", 409);
  const cut = truncateSource(src, o.entryId, kind);
  if (!cut) throw new BranchError(NO_MESSAGE, 404);
  if (!o.text) throw new BranchError(`${AGENT_LABEL[agent]} can't copy part of a conversation without a message to start with.`);
  const profile: ResolvedProfile = pickProfile(agent, o.profile, key);
  if (profile.bin && !profile.binPath) throw new BranchError(`${profile.label} isn't installed.`);
  const mode: PermissionMode = o.mode ?? "default";
  const model = o.model ?? undefined;
  if (kind === "edit") await rewindFirst(key, src.cwd, o.checkpoint);
  const provisional = `pending-${randomUUID()}`;
  await beforeTurn(provisional, o.text, src.cwd);
  let next: string;
  if (cut.entries.some((e) => e.kind === "user" || e.kind === "text")) {
    next = await timeout(handoff(cut, { text: o.text, mode, model, profile }), profile.label);
  } else {
    const a = await adapterFor(agent);
    if (!a) throw new BranchError(`Unknown agent ${agent}.`);
    const { id } = await timeout(
      withProfile(profile, () => a.start({ cwd: src.cwd, text: o.text, model, mode, effort: o.effort ?? undefined })),
      profile.label,
    );
    next = sessionKey(agent, id);
    setSessionProfile(next, profile.id);
  }
  const until = Date.parse(src.entries[cut.entries.length]?.ts ?? "");
  await copyCheckpoints(src.cwd, key, next, Number.isFinite(until) ? until : Infinity).catch(() => 0);
  await moveCheckpoints(src.cwd, provisional, next).catch(() => undefined);
  setSessionMeta(next, { title: branchTitle(src.title, kind) });
  guardTurn({ key: next, text: o.text, mode, model, effort: o.effort, profile });
  return next;
}

/** Starts the fork or edited copy of session `raw`; resolves with the new session's key. */
export async function branch(raw: string, kind: BranchKind, req: BranchRequest, rawEffort?: unknown): Promise<string> {
  const k = parseSessionKey(raw);
  if (!k) throw new BranchError("Session not found.", 404);
  if (kind === "edit" && (await turnRunning(raw))) throw new BranchError("Stop the turn first.", 409);
  const o: Opts = { ...req, effort: parseEffort(k.agent, rawEffort) };
  return k.agent === "claude" ? claudeBranch(k.native, kind, o) : agentBranch(k.agent, k.native, kind, o);
}
