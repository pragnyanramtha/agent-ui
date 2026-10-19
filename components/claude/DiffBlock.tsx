import { useMemo } from "react";
import { compact, lineDiff } from "@/lib/client/diff";
import { highlight, isPlainText } from "@/lib/client/highlight";
import { PathLabel } from "./PathLabel";
import "./diff.css";

const HATCH = "repeating-linear-gradient(45deg, var(--red) 0, var(--red) 1.5px, transparent 1.5px, transparent 3px)";

/** Beautiful UI's CodeBlock diff view: one gutter, tinted rows, green bar for adds, hatched red for removals. */
export function DiffBlock({ before, after, file, plain = isPlainText(file) }: { before: string; after: string; file?: string; plain?: boolean }) {
  const { rows, added, removed, widest } = useMemo(() => {
    const lines = lineDiff(before, after);
    return {
      rows: compact(lines),
      added: lines.filter((l) => l.tone === "add").length,
      removed: lines.filter((l) => l.tone === "del").length,
      widest: lines.reduce((m, l) => Math.max(m, l.old ?? l.cur ?? 0), 1),
    };
  }, [before, after]);
  const cols = { gridTemplateColumns: `calc(${String(widest).length}ch + 18px) minmax(0,1fr)` };

  return (
    <div className="diff-tone w-full overflow-hidden rounded-card bg-surface shadow-card">
      {file && (
        <div className="flex h-9 items-center gap-2 border-b border-line px-3 font-mono text-xs">
          <PathLabel path={file} />
          <span className="ml-auto shrink-0 tabular-nums">
            <span className="text-green">+{added}</span> <span className="text-red">-{removed}</span>
          </span>
        </div>
      )}
      <div tabIndex={0} translate="no" className="max-h-[26rem] overflow-auto overscroll-x-contain py-1.5 font-mono text-xs leading-[1.65] text-ink-2 focus-visible:[outline-offset:-2px]!">
        <div className="relative min-w-fit">
          {rows.map((r, i) =>
            "gap" in r ? (
              <div key={i} className="py-0.5 pl-10 font-sans text-2xs text-ink-3">
                {r.gap} unchanged {r.gap === 1 ? "line" : "lines"}
              </div>
            ) : (
              <div key={i} style={cols} className={`relative grid items-start ${r.tone === "add" ? "bg-green-tint" : r.tone === "del" ? "bg-red-tint" : ""}`}>
                {r.tone !== "ctx" && <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: r.tone === "add" ? "var(--green)" : HATCH }} />}
                <span className={`select-none pr-2 text-right text-2xs tabular-nums ${r.tone === "add" ? "text-green" : r.tone === "del" ? "text-red" : "text-ink-3"}`}>
                  {r.tone === "del" ? r.old : r.cur}
                </span>
                <code className="pr-4 pl-2 whitespace-pre">{plain ? r.text : highlight(r.text)}</code>
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}
