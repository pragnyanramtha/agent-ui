/* Long pastes in the composer (Settings > Composer > Long pastes). */

export const lineCount = (text: string) => (text ? text.split(/\r\n|\r|\n/).length : 0);

/** What a paste of `text` does under the setting: go in as text, go in but ask before sending, or become a file. */
export function pasteAction(text: string, mode: "text" | "confirm" | "attach", limit: number): "text" | "flag" | "attach" {
  if (mode === "text" || lineCount(text) <= limit) return "text";
  return mode === "attach" ? "attach" : "flag";
}

/** The pasted text as a file the attachments upload like any other. */
export const pasteFile = (text: string) => new File([text], "pasted.txt", { type: "text/plain" });
