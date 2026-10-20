"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { OPEN_FILE_PANEL_EVENT, type OpenFilePanel } from "@/lib/client/events";
import { findFileRefs, refLines, resolveRef, type FileRef } from "@/lib/client/file-refs";

/** The open session's folder: paths in its messages and tool calls open in its Files panel. Null elsewhere. */
export const FileRoot = createContext<string | null>(null);

export const useFileRoot = () => useContext(FileRoot);

export function openFilePanel(detail: OpenFilePanel) {
  window.dispatchEvent(new CustomEvent<OpenFilePanel>(OPEN_FILE_PANEL_EVENT, { detail }));
}

const LINK = "cursor-pointer rounded-[3px] text-left underline decoration-current/25 decoration-dotted underline-offset-[3px] transition-colors duration-100 hover:text-accent-ink hover:decoration-solid";

/** `children` as a link that shows the file in the Files panel (at its lines), or as they are outside a session.
 * `base`: the folder relative paths start from, when it isn't the session's. */
export function FileLink({ file, base, children, className = "" }: { file: FileRef; base?: string; children: ReactNode; className?: string }) {
  const root = useFileRoot();
  const abs = root ? resolveRef(file.path, base || root) : null;
  if (!abs) return <>{children}</>;
  const lines = refLines(file);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        openFilePanel({ path: abs, line: file.line, endLine: file.endLine });
      }}
      title={`Show ${abs}${lines ? ` at ${lines.includes("-") ? "lines" : "line"} ${lines}` : ""}`}
      translate="no"
      className={`${LINK} ${className}`}
    >
      {children}
    </button>
  );
}

/** Plain text with the file paths in it as links (a message someone typed). */
export function LinkedText({ text }: { text: string }) {
  const root = useFileRoot();
  const refs = useMemo(() => (root ? findFileRefs(text) : []), [root, text]);
  if (!refs.length) return <>{text}</>;
  const out: ReactNode[] = [];
  let at = 0;
  for (const r of refs) {
    if (r.start > at) out.push(text.slice(at, r.start));
    out.push(
      <FileLink key={r.start} file={r}>
        {text.slice(r.start, r.end)}
      </FileLink>,
    );
    at = r.end;
  }
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}
