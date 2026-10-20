import type { Entry } from "@/lib/types";
import { toolEdits } from "./file-edits";
import { editsIn, splitTurns, undoCheckpoint, type CheckpointRef } from "./turns";

/* Edit from here and Fork from here, the parts a browser decides: what an edit would put back, and which messages
 * the palette's rows act on. */

export type EditPlan = {
  /** files the agent changed from this prompt on (in the loaded part of the conversation) */
  files: number;
  /** the checkpoint that has the files as they were before this prompt, when it's known for sure */
  checkpoint: string | null;
};

/** What Edit from here on prompt `entryId` does to the files: nothing when no turn since changed any, else a rewind to
 * the checkpoint before it (null when there isn't one that's certain, and the files stay as they are). */
export function editPlan(entries: readonly Entry[], checkpoints: readonly CheckpointRef[], entryId: string): EditPlan {
  const turns = splitTurns(entries as Entry[]);
  const target = turns.findIndex((t) => t.user?.id === entryId);
  if (target < 0) return { files: 0, checkpoint: null };
  const paths = new Set(turns.slice(target).flatMap((t) => editsIn(t.entries).flatMap((e) => toolEdits(e).map((ed) => ed.path))));
  if (!paths.size) return { files: 0, checkpoint: null };
  const refs = turns.map((t) => ({ text: t.user?.text ?? "", ts: t.user?.ts ?? "", edits: editsIn(t.entries).length > 0 }));
  return { files: paths.size, checkpoint: undoCheckpoint([...checkpoints], refs, target) };
}

/** The newest prompt, for the palette's Edit your last message. */
export function lastPrompt(entries: readonly Entry[]): Extract<Entry, { kind: "user" }> | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind === "user") return e;
  }
  return null;
}

/** The answer that closes the newest finished turn (the one a reply's Fork acts on); while the agent is on the last
 * turn, the one before it. */
export function lastReply(entries: readonly Entry[], busy: boolean): Extract<Entry, { kind: "text" }> | null {
  let end = entries.length;
  if (busy) {
    const p = lastPrompt(entries);
    end = p ? entries.indexOf(p) : 0;
  }
  for (let i = end - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind === "user") return null;
    if (e.kind === "text" && e.text.trim()) return e;
  }
  return null;
}

/** What the confirm before a rewinding edit says. */
export function editBody(plan: EditPlan): string {
  const n = `${plan.files} ${plan.files === 1 ? "file" : "files"}`;
  return `${n} the agent changed since this message go back to how they were before it. The conversation continues in a new session from just before this message, with your edited text. This session stays as it is, and the files as they are now are saved as a checkpoint first, so you can get them back from Git.`;
}
