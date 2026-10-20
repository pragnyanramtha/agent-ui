/* The login password and the cookie signing key are the app's alone: an agent, a git hook or a web shell that could
 * read them could sign its own session. Every process the app starts gets its environment from here.
 * server/pty.mjs drops the same keys from its own environment at startup. */

export const APP_SECRETS = ["UI_SECRET", "UI_PASSWORD", "UI_PASSWORD_HASH"] as const;

/** process.env plus `extra`, without the app's secrets (also when `extra` names them) */
export function childEnv(...extra: (Record<string, string | undefined> | undefined)[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.assign({}, process.env, ...extra.filter(Boolean));
  for (const k of APP_SECRETS) delete env[k];
  return env;
}
