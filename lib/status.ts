/* Interactive claude processes report a status in ~/.claude/sessions/<pid>.json:
 * "idle" when waiting at the prompt, "busy" while the model works, "shell" while
 * a tool command runs. Anything that isn't idle counts as working. */
export const terminalBusy = (status: string | undefined | null) => Boolean(status) && status !== "idle" && status !== "unknown";

/** A web turn that failed: the run ended in an error, or it is back at the prompt with the last turn's error kept. */
export const runFailed = (run: { status: string; error: string | null } | null | undefined) =>
  Boolean(run) && (run!.status === "error" || (run!.status === "idle" && Boolean(run!.error)));
