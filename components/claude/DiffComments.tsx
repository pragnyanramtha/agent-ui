"use client";

import { useEffect, useRef, useState } from "react";
import { EditPencil, Trash } from "iconoir-react";
import { chordLabel, composing } from "@/lib/keybindings";
import { hasMod, isMac } from "@/lib/client/shortcuts";
import type { ReviewComment } from "@/lib/client/review";

/* The pieces a diff shows under commented lines: the box a comment is written in, and the comment once saved. */

const BOX = "sticky left-2 my-1.5 w-[min(36rem,calc(var(--diff-w,100vw)-1rem))] rounded-[10px] bg-surface font-sans text-sm text-ink shadow-raised";
const BTN = "tap relative inline-flex h-8 items-center rounded-full px-3 text-sm font-medium sm:h-7";

/** Writing or editing a comment: Mod+Enter saves, Esc cancels. `onEmpty` says whether the box is empty, so a tap on
 * another line number can grow the range instead of starting over. */
export function CommentEditor({
  label,
  initial = "",
  onSave,
  onCancel,
  onEmpty,
}: {
  label: string;
  initial?: string;
  onSave: (body: string) => void;
  onCancel: () => void;
  onEmpty?: (empty: boolean) => void;
}) {
  const [text, setText] = useState(initial);
  const [mac, setMac] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    setMac(isMac());
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
    el.scrollIntoView({ block: "nearest" });
  }, []);
  useEffect(() => onEmpty?.(!text.trim()), [text, onEmpty]);
  const save = () => text.trim() && onSave(text.trim());
  return (
    <div className={`${BOX} p-2`} data-review-editor>
      <p className="truncate px-1 pb-1.5 font-mono text-2xs text-ink-3" translate="no">
        {label}
      </p>
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (composing(e.nativeEvent)) return;
          if (e.key === "Enter" && hasMod(e.nativeEvent) && !e.altKey && !e.shiftKey) {
            e.preventDefault();
            save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
        rows={3}
        aria-label={`Comment on ${label}`}
        placeholder="Leave a comment for the agent…"
        className="block max-h-60 min-h-20 w-full resize-y rounded-[8px] bg-inset px-2.5 py-2 text-[16px] leading-relaxed text-ink shadow-hairline outline-none placeholder:text-ink-3 focus-visible:ring-2 focus-visible:ring-accent/40 sm:text-sm"
      />
      <div className="flex items-center gap-1 pt-2">
        <span className="px-1 text-xs text-ink-3 pointer-coarse:hidden">{chordLabel("Mod+Enter", mac)} to save</span>
        <button type="button" onClick={onCancel} className={`${BTN} ml-auto text-ink-2 hover:bg-hover`}>
          Cancel
        </button>
        <button type="button" onClick={save} disabled={!text.trim()} className={`${BTN} bg-ink text-page disabled:opacity-40`}>
          {initial ? "Save" : "Comment"}
        </button>
      </div>
    </div>
  );
}

export function CommentCard({ comment, label, onEdit, onDelete }: { comment: ReviewComment; label: string; onEdit: () => void; onDelete: () => void }) {
  return (
    <div className={`${BOX} flex items-start gap-2 py-2 pr-1.5 pl-3`} data-review-comment>
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-2xs text-ink-3" translate="no">
          {label}
        </p>
        <p className="mt-0.5 whitespace-pre-wrap [overflow-wrap:anywhere]">{comment.body}</p>
      </div>
      <button type="button" onClick={onEdit} aria-label={`Edit comment on ${label}`} data-tip="Edit" className="icon-btn">
        <EditPencil width={14} height={14} strokeWidth={1.8} />
      </button>
      <button type="button" onClick={onDelete} aria-label={`Delete comment on ${label}`} data-tip="Delete" className="icon-btn">
        <Trash width={14} height={14} strokeWidth={1.8} />
      </button>
    </div>
  );
}
