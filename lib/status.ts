/* Interactive claude processes report a status in ~/.claude/sessions/<pid>.json:
 * "idle" when waiting at the prompt, "busy" while the model works, "shell" while
 * a tool command runs. Anything that isn't idle counts as working. */
export const terminalBusy = (status: string | undefined | null) => Boolean(status) && status !== "idle" && status !== "unknown";

/** A web run whose last turn failed: it ended on an error, or it's still open and the turn ended with one. */
export const runFailed = (run: { status: string; error: string | null } | null | undefined) =>
  Boolean(run && (run.status === "error" || (run.status === "idle" && run.error)));
