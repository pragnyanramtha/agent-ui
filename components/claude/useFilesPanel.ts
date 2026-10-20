"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { OPEN_FILE_PANEL_EVENT, type OpenFilePanel } from "@/lib/client/events";
import { isCommand, isTyping, modalOpen, terminalOwns } from "@/lib/client/shortcuts";
import { usePaletteSource } from "@/lib/client/palette-actions";
import type { FileTarget } from "./FilesPanel";

/** The session's Files panel: which file it shows (links and "Go to file" point it somewhere), and the Mod+P picker. */
export function useFilesPanel(cwd: string, open: () => void) {
  const [target, setTarget] = useState<FileTarget | null>(null);
  const [picking, setPicking] = useState(false);
  const latest = useRef({ cwd, open });
  latest.current = { cwd, open };

  useEffect(() => {
    setTarget(null);
    setPicking(false);
  }, [cwd]);

  const show = useCallback((d: OpenFilePanel) => {
    setTarget({ path: d.path, line: d.line, endLine: d.endLine, n: Date.now() });
    latest.current.open();
  }, []);

  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<OpenFilePanel>).detail;
      if (!d?.path || !latest.current.cwd) return;
      e.preventDefault();
      show(d);
    };
    window.addEventListener(OPEN_FILE_PANEL_EVENT, on);
    return () => window.removeEventListener(OPEN_FILE_PANEL_EVENT, on);
  }, [show]);

  /* Mod+P instead of printing, but not from a field other than the composer, nor from a terminal */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !latest.current.cwd || !isCommand(e, "quickOpen") || terminalOwns(e) || modalOpen()) return;
      if (isTyping(e.target) && !(e.target as Element).closest("[data-composer]")) return;
      e.preventDefault();
      setPicking(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  usePaletteSource("files", () =>
    latest.current.cwd
      ? {
          actions: [
            { id: "quick-open", label: "Go to file…", keywords: "files open find fuzzy search path", icon: "file", command: "quickOpen", takesFocus: true, run: () => setPicking(true) },
            { id: "files", label: "Files", keywords: "files browse folder tree panel", icon: "file", run: () => latest.current.open() },
          ],
        }
      : { actions: [] },
  );

  const pick = useCallback(
    (rel: string, line?: number) => show({ path: `${latest.current.cwd.replace(/\/+$/, "")}/${rel.replace(/^\.\//, "")}`, line }),
    [show],
  );
  const browse = useCallback(() => {
    setTarget(null);
    latest.current.open();
  }, []);
  return {
    target,
    picking,
    browse,
    openPicker: useCallback(() => setPicking(true), []),
    closePicker: useCallback(() => setPicking(false), []),
    pick,
    show,
  };
}
