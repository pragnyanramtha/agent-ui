export async function register() {
  /* an `if` block, not an early return: webpack only drops the Node-only imports from the Edge bundle inside a constant-false branch */
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { installShutdown } = await import("./lib/server/shutdown");
    installShutdown();
    const { startNotify } = await import("./lib/server/notify");
    startNotify();
    /* messages queued behind a running turn when the server went down */
    void import("./lib/server/agents/routes").then((m) => m.resumeQueues()).catch((err) => console.error("queue: resume failed", err));
  }
}
