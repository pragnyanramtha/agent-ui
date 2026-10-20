/* Words for empty and failed states, kept apart from the components so they read the same everywhere and can be tested. */

export type EmptyCopy = { title: string; body: string };

/** Error code the message routes answer with when a session's folder was moved or deleted. */
export const FOLDER_GONE = "folder_missing";

export const folderGoneCopy = (cwd: string): EmptyCopy => ({
  title: "This session's folder is gone",
  body: `${cwd} was moved or deleted. Put it back to keep going here, or start a new session in another folder.`,
});

/** The send error for a session whose folder is gone, as one sentence pair. */
export const folderGoneMessage = (cwd: string) => `This session's folder is gone: ${cwd}. Put it back, or start a new session in another folder.`;

/* fetch's own failures (each browser words it differently) and the gateway answers a tunnel gives while the app is down */
const UNREACHABLE = /failed to fetch|networkerror|load failed|network request failed|network connection was lost|\((502|503|504|52\d|530)\)/i;

export const isUnreachable = (message: string) => UNREACHABLE.test(message);

/** What the sidebar says when the session list won't load. */
export function sessionsErrorCopy(message: string, online = true): EmptyCopy {
  if (!online) return { title: "You're offline", body: "Sessions come back when you reconnect." };
  if (isUnreachable(message)) return { title: "Can't reach the server", body: "agent-u isn't answering. It may be restarting. Try again in a moment." };
  return { title: "Couldn't load sessions", body: /[.!?]$/.test(message.trim()) ? message.trim() : `${message.trim()}.` };
}

/** What Files says when a folder won't open: `status` is the server's answer, none when it didn't answer. */
export function folderErrorCopy(message: string, status?: number): EmptyCopy {
  if (status === undefined || isUnreachable(message)) return { title: "Can't reach the server", body: "agent-u isn't answering. It may be restarting. Try again in a moment." };
  if (status === 404) return { title: "That folder isn't there", body: `${message} It may have been moved or deleted.` };
  return { title: "Couldn't open this folder", body: message };
}

export type SidebarEmpty = "none" | "agent" | "snoozed";

/** Which empty sidebar this is: nothing at all, nothing for the chosen agent, or everything snoozed. */
export function sidebarEmpty(o: { shown: number; awake: number; filtered: boolean }): SidebarEmpty | null {
  if (!o.shown) return o.filtered ? "agent" : "none";
  return o.awake ? null : "snoozed";
}

export function sidebarEmptyCopy(kind: SidebarEmpty, agent = ""): EmptyCopy {
  if (kind === "agent") return { title: `No ${agent} sessions yet`, body: "Show all agents, or start one with New session." };
  if (kind === "snoozed") return { title: "Everything is snoozed", body: "Snoozed sessions come back on their own." };
  return { title: "No sessions yet", body: "Start one with New session. Sessions you run in a terminal show up here too." };
}

export const noMatchCopy = (query: string, hint: string): EmptyCopy => ({ title: `Nothing matches “${query.trim()}”`, body: hint });

type LauncherProfile = { installed: boolean; hidden?: boolean };

/** Why the Agents launcher has nothing to start, or null when something can start. */
export function launcherEmpty(profiles: LauncherProfile[] | null): EmptyCopy | null {
  if (!profiles) return null;
  const shown = profiles.filter((p) => !p.hidden);
  if (shown.some((p) => p.installed)) return null;
  if (!shown.length && profiles.length) return { title: "Every agent is hidden", body: "Turn off Hide from menus for one under Profiles below." };
  return { title: "No agents installed", body: "Install an agent's CLI on the server, for example from a shell here, then check again." };
}
