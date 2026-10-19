/* Links that open a folder or file of this server in a desktop editor over SSH (Settings > General > Open in editor).
 * The browser hands the URL to the editor installed on the user's computer; its SSH remote does the rest. */

export type Editor = "vscode" | "cursor" | "zed";

export const EDITOR_LABEL: Record<Editor, string> = { vscode: "VS Code", cursor: "Cursor", zed: "Zed" };

/** an ssh destination as typed in ~/.ssh/config or on the command line: alias, host, user@host, host:port, [v6] */
export const SSH_HOST = /^[A-Za-z0-9._~@:%[\]-]*$/;

export const isEditor = (v: unknown): v is Editor => v === "vscode" || v === "cursor" || v === "zed";

/* each segment escaped (spaces, #, ?) but the slashes kept */
const encodePath = (p: string) =>
  p
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");

/** The editor URL for an absolute path on the server, or null when there's no host, it isn't usable, or the path is
 * relative. `line` (and `column`) only make sense for files. */
export function editorUrl(editor: Editor, host: string, path: string, line?: number, column?: number): string | null {
  const h = host.trim();
  if (!h || !SSH_HOST.test(h) || !path.startsWith("/")) return null;
  const clean = path.replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1");
  const at = line && line > 0 ? `:${Math.floor(line)}${column && column > 0 ? `:${Math.floor(column)}` : ""}` : "";
  const rest = `${encodePath(clean)}${at}`;
  if (editor === "zed") return `zed://ssh/${h}${rest}`;
  return `${editor}://vscode-remote/ssh-remote+${h}${rest}`;
}
