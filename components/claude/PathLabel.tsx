"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { OpenNewWindow } from "iconoir-react";
import { splitPath } from "@/lib/client/tools";
import { useEditorLink, type EditorLink } from "@/lib/client/useEditorLink";

/** A file path that truncates its directory first so the file name stays readable on narrow screens. */
export function PathLabel({ path, line, className = "" }: { path: string; line?: number; className?: string }) {
  const { dir, base } = splitPath(path);
  const editor = useEditorLink();
  return (
    <span title={path} translate="no" className={`flex min-w-0 font-mono ${className}`}>
      {dir && <span className="min-w-0 truncate text-ink-3">{dir}</span>}
      <span className="max-w-full shrink-0 truncate text-ink-2">{base}</span>
      {editor && path.startsWith("/") && <OpenInEditor editor={editor} path={path} line={line} name={base} />}
    </span>
  );
}

/* a link can't sit inside the buttons some lists wrap paths in, so it only shows where the path isn't one */
function OpenInEditor({ editor, path, line, name }: { editor: EditorLink; path: string; line?: number; name: string }) {
  const probe = useRef<HTMLSpanElement>(null);
  const [free, setFree] = useState<boolean | null>(null);
  useLayoutEffect(() => setFree(!probe.current?.parentElement?.closest("button, a, [role='button'], [role='link']")), []);
  const href = editor.href(path, line);
  if (free === null) return <span ref={probe} hidden />;
  if (!free || !href) return null;
  return (
    <a
      href={href}
      aria-label={`Open ${name} in ${editor.name}`}
      title={editor.label}
      onClick={(e) => e.stopPropagation()}
      className="tap relative ml-1.5 inline-flex shrink-0 items-center self-center rounded-[4px] text-ink-3 hover:text-ink pointer-coarse:hidden"
    >
      <OpenNewWindow width={12} height={12} strokeWidth={1.9} aria-hidden />
    </a>
  );
}
