import fs from "node:fs/promises";
import path from "node:path";
import { terminalBusy } from "@/lib/status";
import { TRANSCRIPT_DELETABLE } from "@/lib/types";
import { PROJECTS_DIR } from "./config";
import { getRun } from "./runner";
import { isSessionId, liveTerminals } from "./sessions";
import { adapterFor, parseSessionKey, sessionKey } from "./agents";
import { markSessionDeleted } from "./profiles";

/* Deleting a session from the list: it's hidden for good in agent-u's own state, and, only when asked, its one
 * transcript file goes from the agent's own store. Never a session that's running, never a file outside that store. */

export type DeleteResult = { ok: true; removed: string | null } | { ok: false; status: number; error: string };

const fail = (status: number, error: string): DeleteResult => ({ ok: false, status, error });

const isPlainFile = (f: string) => fs.lstat(f).then((s) => s.isFile(), () => false);

/** Every `<id>.jsonl` under ~/.claude/projects/<project>/ (one, unless the same id sits in two projects). */
async function claudeFiles(id: string): Promise<string[]> {
  if (!isSessionId(id)) return [];
  const dirs = await fs.readdir(PROJECTS_DIR, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const f = path.join(PROJECTS_DIR, d.name, `${id}.jsonl`);
    if (await isPlainFile(f)) out.push(f);
  }
  return out;
}

/** Removes `file` only when it's a plain file (not a link) whose real path lies inside one of `roots`. */
export async function removeInside(file: string, roots: string[]): Promise<boolean> {
  if (!path.isAbsolute(file) || !(await isPlainFile(file))) return false;
  const real = await fs.realpath(file).catch(() => null);
  if (!real) return false;
  for (const root of roots) {
    const top = await fs.realpath(root).catch(() => null);
    if (!top) continue;
    const rel = path.relative(top, real);
    if (!rel || path.isAbsolute(rel) || rel.split(path.sep)[0] === "..") continue;
    await fs.unlink(real);
    return true;
  }
  return false;
}

export async function deleteSession(raw: string, opts: { transcript: boolean }): Promise<DeleteResult> {
  const key = parseSessionKey(raw);
  if (!key) return fail(404, "Session not found.");
  const k = sessionKey(key.agent, key.native);
  if (opts.transcript && !TRANSCRIPT_DELETABLE.includes(key.agent)) return fail(400, "This agent keeps history in its own storage.");

  let target: { files: string[]; roots: string[] } = { files: [], roots: [] };
  if (key.agent === "claude") {
    const run = getRun(key.native);
    const terminal = (await liveTerminals(0)).get(key.native);
    if (run && (run.state.status === "running" || run.state.status === "starting" || run.state.pending.length)) return fail(409, "Stop the session first.");
    if (terminal && terminalBusy(terminal.status)) return fail(409, "Stop the session first.");
    if (opts.transcript) {
      if (terminal) return fail(409, "It's open in a terminal. Close it there first.");
      target = { files: await claudeFiles(key.native), roots: [PROJECTS_DIR] };
    }
  } else {
    const a = await adapterFor(key.agent);
    if (!a) return fail(404, "Session not found.");
    const st = a.runState(key.native);
    if (st && (st.status === "running" || st.pending?.length)) return fail(409, "Stop the session first.");
    if (opts.transcript) {
      if ((await a.liveProcesses?.().catch(() => null))?.has(key.native)) return fail(409, "It's open in a terminal. Close it there first.");
      target = (await a.transcriptFiles?.(key.native)) ?? target;
    }
  }

  let removed: string | null = null;
  if (opts.transcript) {
    if (target.files.length !== 1) return fail(409, target.files.length ? "Found more than one transcript file. Nothing was deleted." : "Couldn't find the transcript file.");
    /* an idle web run still holds the session open; it would write the file again */
    if (key.agent === "claude") getRun(key.native)?.close();
    try {
      if (!(await removeInside(target.files[0], target.roots))) return fail(409, "The transcript isn't in the agent's session folder. Nothing was deleted.");
    } catch (err) {
      return fail(500, `Couldn't delete the transcript: ${err instanceof Error ? err.message : String(err)}`);
    }
    removed = target.files[0];
  }
  try {
    markSessionDeleted(k);
  } catch (err) {
    return fail(500, `Couldn't save: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { ok: true, removed };
}
