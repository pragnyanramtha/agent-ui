/** True when `pos` sits on the first line of `text` (no newline before it). */
export const onFirstLine = (text: string, pos: number) => !text.slice(0, pos).includes("\n");

/** True when `pos` sits on the last line of `text` (no newline after it). */
export const onLastLine = (text: string, pos: number) => !text.slice(pos).includes("\n");
