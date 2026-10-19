"use client";

import { ChatBubble, EditPencil, Search } from "iconoir-react";
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

const ROWS = ["Theme switch without a flash", "Fix flaky checkout test", "Migrate styles to Tailwind v4"];

/** The sidebar as it looks in the app: search, a project and a few sessions, the first one open. */
function MiniSidebar() {
  return (
    <div className="hidden w-44 shrink-0 flex-col gap-0.5 border-r border-line bg-sidebar p-2 min-[520px]:flex">
      <div className="flex h-7 items-center gap-2 px-2 text-sm font-semibold text-ink">
        agent-u
        <EditPencil width={14} height={14} strokeWidth={1.6} className="ml-auto text-ink-3" aria-hidden />
      </div>
      <div className="mb-2 flex h-7 items-center gap-2 rounded-control bg-sidebar-hover px-2 text-xs text-ink-3">
        <Search width={13} height={13} strokeWidth={1.8} aria-hidden />
        Search
        <span className="kbd ml-auto h-4 min-w-4">⌘K</span>
      </div>
      <div className="px-2 pb-1 text-xs font-medium text-ink-3">acme-web</div>
      {ROWS.map((r, i) => (
        <div key={r} aria-current={i === 0 ? "page" : undefined} className="side-row h-7 gap-2 px-2 text-xs">
          {i === 0 ? <span className="size-1.5 shrink-0 rounded-full bg-accent" /> : <ChatBubble width={12} height={12} strokeWidth={1.8} className="shrink-0 text-ink-3" aria-hidden />}
          <span className={`truncate ${i === 0 ? "text-ink" : "text-ink-2"}`}>{r}</span>
        </div>
      ))}
    </div>
  );
}

/** A small session with real thread components, drawn with the current appearance settings. */
export function Preview() {
  const [timestamps] = useSetting("showTimestamps");
  return (
    <div aria-label="Preview" role="img" className="pointer-events-none flex overflow-hidden rounded-card border border-line bg-page select-none">
      <MiniSidebar />
      <div className="flex min-w-0 flex-1 flex-col gap-(--thread-gap) px-4 pt-4 pb-3 sm:px-5" inert>
        <div className={ACTIONS_GAP}>
          <div className={`flex flex-col items-end pl-10 ${ACTIONS_PAD}`}>
            <div className="max-w-full rounded-window bg-field px-3.5 py-2 text-base leading-relaxed text-ink">Make the theme switch without a flash.</div>
            <MessageActions text="Make the theme switch without a flash." ts={TS} align="end" />
          </div>
        </div>
        <ToolRun items={ITEMS} results={RESULTS} active={false} />
        <div className={ACTIONS_HOST}>
          <Markdown text={REPLY} />
          <MessageActions text={REPLY} ts={timestamps ? TS : undefined} />
        </div>
        <div className="hidden sm:block">
          <DiffBlock file="app/layout.tsx" before={'const d = stored ?? "dark";\n'} after={'const d = stored ?? systemTheme();\n'} />
        </div>
        <div className="flex items-center justify-end gap-2">
          <span className="inline-flex h-7 items-center rounded-control px-2.5 text-xs font-medium text-ink shadow-btn">Undo</span>
          <span className="inline-flex h-7 items-center rounded-control bg-primary px-2.5 text-xs font-medium text-primary-foreground">Commit</span>
        </div>
      </div>
    </div>
  );
}
