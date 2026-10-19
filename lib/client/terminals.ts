import { OPEN_TERMINAL_EVENT } from "./events";

/** Shows a terminal the server keeps (from /api/terminals) in the web terminal. */
export function openServerTerminal(t: { id: string; backing: "tmux" | "pty" | string }, label: string) {
  window.dispatchEvent(new CustomEvent(OPEN_TERMINAL_EVENT, { detail: t.backing === "tmux" ? { tmux: t.id, label } : { term: t.id, label } }));
}
