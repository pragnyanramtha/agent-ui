export async function register() {
  /* an `if` block, not an early return: webpack only drops the Node-only imports from the Edge bundle inside a constant-false branch */
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { installShutdown } = await import("./lib/server/shutdown");
    installShutdown();
    const { startNotify } = await import("./lib/server/notify");
    startNotify();
  }
}
