"use client";

import { useMemo } from "react";
import { EDITOR_LABEL, editorUrl, isEditor } from "@/lib/editor-links";
import { useSetting } from "./settings";

export type EditorLink = { name: string; label: string; href: (path: string, line?: number) => string | null };

/** Settings > General > Open in editor, ready to link with; null while it's off or has no host. */
export function useEditorLink(): EditorLink | null {
  const [editor] = useSetting("editorLink");
  const [host] = useSetting("editorHost");
  return useMemo(() => {
    if (!isEditor(editor) || !host.trim()) return null;
    const name = EDITOR_LABEL[editor];
    return { name, label: `Open in ${name}`, href: (path, line) => editorUrl(editor, host, path, line) };
  }, [editor, host]);
}
