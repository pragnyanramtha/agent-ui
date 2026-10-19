"use client";

import { Markdown } from "../Markdown";
import { ACTIONS_GAP, ACTIONS_HOST, ACTIONS_PAD, MessageActions } from "../MessageActions";
import { ToolRun, type RunItem } from "../ToolRun";
import { DiffBlock } from "../DiffBlock";
import { useSetting } from "@/lib/client/settings";
import type { ToolResult } from "@/lib/types";

const TS = new Date(Date.now() - 4 * 60_000).toISOString();

const ITEMS: RunItem[] = [
  { kind: "tool", id: "p1", ts: TS, msgId: "m", toolUseId: "t1", name: "Read", input: { file_path: "lib/client/settings.ts" } },
  { kind: "tool", id: "p2", ts: TS, msgId: "m", toolUseId: "t2", name: "Bash", input: { command: "pnpm typecheck" } },
];
const RESULTS: Record<string, ToolResult> = {
  t1: { text: "export function useSetting() {}", isError: false, truncated: false },
  t2: { text: "Done in 2.1s", isError: false, truncated: false },
};

const REPLY = "The theme is read before the first paint, so `applyTheme()` only has to swap a class:\n\n```ts\nconst dark = theme === \"system\" ? prefersDark() : theme === \"dark\";\nroot.classList.toggle(\"dark\", dark);\n```";

/** A small session with real thread components, drawn with the current appearance settings. */
export function Preview() {
  const [timestamps] = useSetting("showTimestamps");
  return (
    <div aria-label="Preview" role="img" className="pointer-events-none overflow-hidden rounded-card border border-line bg-page select-none">
      <div className="flex flex-col gap-(--thread-gap) px-4 pt-4 pb-3 sm:px-5" inert>
        <div className={ACTIONS_GAP}>
          <div className={`flex flex-col items-end pl-10 ${ACTIONS_PAD}`}>
            <div className="max-w-full rounded-window bg-field px-3.5 py-2 text-[13.5px] leading-relaxed text-ink shadow-hairline">Make the theme switch without a flash.</div>
            <MessageActions text="Make the theme switch without a flash." ts={TS} align="end" />
          </div>
        </div>
        <ToolRun items={ITEMS} results={RESULTS} active={false} />
        <div className={ACTIONS_HOST}>
          <Markdown text={REPLY} />
          <MessageActions text={REPLY} ts={timestamps ? TS : undefined} />
        </div>
        <DiffBlock file="app/layout.tsx" before={'const d = stored ?? "dark";\n'} after={'const d = stored ?? systemTheme();\n'} />
      </div>
    </div>
  );
}
