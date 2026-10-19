"use client";

import { useEffect, useRef } from "react";
import type { AgentId, PermissionMode, SessionSummary } from "@/lib/types";
import type { CommandId } from "@/lib/keybindings";
import { effortLabel, effortOptions } from "@/lib/agent-traits";
import { actionFor, openPalettePicker, usePaletteSource, type PaletteAction, type PalettePicker } from "@/lib/client/palette-actions";
import { commandFor, isMac, isTyping, modalOpen, terminalOwns } from "@/lib/client/shortcuts";
import { getSetting } from "@/lib/client/settings";
import { sessionStatus } from "@/lib/client/session-status";
import { nextNeedingYou, sidebarOrder, stepIn, type Attention, type RecentsGroup } from "@/lib/client/sidebar";
import { patchSession } from "@/lib/client/useSessions";
import type { Finished } from "@/lib/client/useFinished";
import { toast } from "@/lib/client/toast";
import { confirmAsk, promptAsk } from "./Ask";
import { MODES, modelLabel } from "./Composer";
import { isAsleep } from "./SessionList";

const KEYS = ["gitPanel", "changesPanel", "prevSession", "nextSession", "nextNeedsYou", "pin", "archive", "back", "forward", "modelPicker", "modePicker", "effortPicker"] as const satisfies readonly CommandId[];

const PICKERS: Partial<Record<CommandId, string>> = { modelPicker: "model", modePicker: "mode", effortPicker: "effort" };

const stored = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

/** The sessions in the sidebar's order right now (its view, sort, grouping and agent filter). */
function listedOrder(sessions: readonly SessionSummary[]): SessionSummary[] {
  const agent = stored("cui:agent");
  const rows = agent && agent !== "all" && sessions.some((s) => s.agent === agent) ? sessions.filter((s) => s.agent === (agent as AgentId)) : sessions;
  const group = stored("cui:recentsGroup");
  const now = Date.now();
  return sidebarOrder(rows, {
    view: getSetting("sidebarGroup"),
    sort: getSetting("sidebarSort"),
    group: group === "time" || group === "agent" ? (group as RecentsGroup) : "none",
    asleep: (s) => isAsleep(s, now),
    now,
  });
}

function attentionOf(s: SessionSummary | undefined, finished: Finished): Attention {
  if (!s) return null;
  const st = sessionStatus(s, Boolean(finished[s.id]));
  return st === "approval" || st === "input" ? "now" : st === "failed" || st === "unread" ? "later" : null;
}

const failed = (what: string) => (err: unknown) => toast({ title: `Couldn't ${what}.`, body: err instanceof Error ? err.message : String(err), tone: "error" });

export function renameSession(s: SessionSummary) {
  void promptAsk({ title: "Rename session", confirm: "Rename", value: s.title }).then((t) => {
    const title = t?.replace(/\s+/g, " ").trim();
    if (title && title !== s.title) patchSession(s.id, { title }).catch(failed("rename the session"));
  });
}

export function togglePin(s: SessionSummary) {
  patchSession(s.id, { pinned: !s.pinned }).then(() => toast({ title: s.pinned ? "Unpinned." : "Pinned.", key: `pin:${s.id}` }), failed("save"));
}

/** Archives (asking first when Settings > Sidebar says so) with an Undo, or brings an archived session back. */
export async function toggleArchive(s: SessionSummary) {
  if (s.archived) return void patchSession(s.id, { archived: false }).catch(failed("restore the session"));
  if (getSetting("sidebarConfirm") === "both") {
    const ok = await confirmAsk({ title: "Archive session?", body: `${s.title} moves to Archived on every device. You can restore it from there.`, confirm: "Archive" });
    if (!ok) return;
  }
  const wasPinned = Boolean(s.pinned);
  patchSession(s.id, { archived: true }).catch(failed("archive the session"));
  toast({
    title: "Archived.",
    key: `archive:${s.id}`,
    action: { label: "Undo", run: () => void patchSession(s.id, wasPinned ? { archived: false, pinned: true } : { archived: false }).catch(failed("restore the session")) },
  });
}

/** App-wide session shortcuts (moving between sessions, history, pin and archive, the session's panels and pickers),
 * plus the palette rows that act on the open session's sidebar entry. */
export function useSessionCommands({ sessions, activeId, finished, onOpen }: { sessions: SessionSummary[] | null; activeId: string | null; finished: Finished; onOpen: (id: string) => void }) {
  const latest = useRef({ sessions, activeId, finished, onOpen });
  latest.current = { sessions, activeId, finished, onOpen };

  usePaletteSource("session-list", () => {
    const { sessions, activeId, finished, onOpen } = latest.current;
    const all = sessions ?? [];
    const s = activeId ? all.find((x) => x.id === activeId) : undefined;
    const actions: PaletteAction[] = [];
    if (s) {
      actions.push(
        { id: "rename", label: "Rename session…", keywords: "rename title name", icon: "rename", takesFocus: true, run: () => renameSession(s) },
        { id: "pin", label: s.pinned ? "Unpin session" : "Pin session", keywords: "pin unpin favorite top", icon: s.pinned ? "unpin" : "pin", command: "pin", run: () => togglePin(s) },
        { id: "archive", label: s.archived ? "Unarchive session" : "Archive session", keywords: "archive hide unarchive restore", icon: "archive", command: "archive", takesFocus: !s.archived && getSetting("sidebarConfirm") === "both", run: () => void toggleArchive(s) },
      );
    }
    const byId = new Map(all.map((x) => [x.id, x]));
    const order = listedOrder(all).map((x) => x.id);
    const seen = new Set(order);
    const next = nextNeedingYou([...order, ...all.filter((x) => !seen.has(x.id)).map((x) => x.id)], activeId, (id) => attentionOf(byId.get(id), finished));
    if (next) {
      actions.push({ id: "needs-you", label: "Next session that needs you", hint: byId.get(next)?.title, keywords: "needs you approval waiting inbox unread finished jump", icon: "needsYou", command: "nextNeedsYou", run: () => onOpen(next) });
    }
    return { actions };
  });

  useEffect(() => {
    const mac = isMac();
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || terminalOwns(e) || modalOpen()) return;
      const id = commandFor(e, KEYS, mac);
      if (!id) return;
      /* Option+Shift+arrows select text by paragraph in a Mac field */
      if (mac && e.altKey && e.key.startsWith("Arrow") && isTyping(e.target)) return;
      const { sessions, activeId, finished, onOpen } = latest.current;
      const all = sessions ?? [];
      if (id === "back" || id === "forward") {
        e.preventDefault();
        if (id === "back") window.history.back();
        else window.history.forward();
        return;
      }
      if (id === "prevSession" || id === "nextSession") {
        const to = stepIn(
          listedOrder(all).map((s) => s.id),
          activeId,
          id === "nextSession" ? 1 : -1,
        );
        e.preventDefault();
        if (to && to !== activeId) onOpen(to);
        return;
      }
      if (id === "nextNeedsYou") {
        e.preventDefault();
        const byId = new Map(all.map((s) => [s.id, s]));
        const order = listedOrder(all).map((s) => s.id);
        const seen = new Set(order);
        const to = nextNeedingYou([...order, ...all.filter((s) => !seen.has(s.id)).map((s) => s.id)], activeId, (sid) => attentionOf(byId.get(sid), finished));
        if (to) onOpen(to);
        else toast({ title: "Nothing needs you right now.", key: "needs-you" });
        return;
      }
      const picker = PICKERS[id];
      if (picker) {
        if (!activeId) return;
        e.preventDefault();
        if (!openPalettePicker(picker) && id === "effortPicker") toast({ title: "This agent has no effort levels.", key: "effort" });
        return;
      }
      const action = actionFor(id);
      if (!action) {
        if (id === "changesPanel" && activeId) {
          e.preventDefault();
          toast({ title: "No file changes in this session yet.", key: "changes" });
        }
        return;
      }
      e.preventDefault();
      if (action.picker) openPalettePicker(action.picker);
      else (action.onCommand ?? action.run)();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

type Panel = "changes" | "git" | "usage";

/** The open session's rows and pickers in the command palette; each one does what the screen's own button does. */
export function useSessionPalette(o: {
  id: string;
  agent: AgentId;
  agentName: string;
  openPanel: (p: Panel) => void;
  togglePanel: (p: Panel) => void;
  changes: number;
  hasFolder: boolean;
  exportable: boolean;
  onHandoff: (() => void) | null;
  onStop: (() => void) | null;
  models: { key: string; name: string }[];
  model: string | null;
  /** the model "Default" resolves to, when the profile names one */
  defaultModel: string | null;
  onModel: (m: string) => void;
  mode: PermissionMode;
  onMode: (m: PermissionMode) => void;
  effort: string;
  defaultEffort: string | null;
  onEffort: (e: string) => void;
}) {
  usePaletteSource("session", () => {
    const download = (format: "md" | "json") => () => {
      const a = document.createElement("a");
      a.href = `/api/sessions/${o.id}/export?format=${format}`;
      a.download = "";
      document.body.appendChild(a);
      a.click();
      a.remove();
    };
    const levels = effortOptions(o.agent);
    const currentMode = MODES.find((m) => m.key === o.mode);
    const nameOf = (m: string) => o.models.find((x) => x.key === m)?.name || modelLabel(m);
    const modelName = o.model ? nameOf(o.model) : o.defaultModel ? nameOf(o.defaultModel) : "Default";
    const effortName = effortLabel(o.agent, o.effort || o.defaultEffort) ?? "Default";
    const actions: PaletteAction[] = [
      ...(o.hasFolder
        ? [{ id: "git", label: "Git and checkpoints", keywords: "git branch commit push checkpoints rewind undo panel", icon: "git" as const, command: "gitPanel" as const, run: () => o.openPanel("git"), onCommand: () => o.togglePanel("git") }]
        : []),
      ...(o.changes > 0
        ? [{ id: "changes", label: "Changes", hint: `${o.changes} ${o.changes === 1 ? "file" : "files"}`, keywords: "changes diff files edits panel", icon: "changes" as const, command: "changesPanel" as const, run: () => o.openPanel("changes"), onCommand: () => o.togglePanel("changes") }]
        : []),
      { id: "usage", label: "Usage and cost", keywords: "usage cost tokens context limits panel", icon: "usage", run: () => o.openPanel("usage") },
      { id: "model", label: "Switch model…", hint: modelName, keywords: "model switch change opus sonnet haiku", icon: "model", command: "modelPicker", picker: "model", run: () => undefined },
      { id: "mode", label: "Switch approval mode…", hint: currentMode?.name, keywords: "mode approvals permissions plan bypass accept edits ask", icon: "mode", command: "modePicker", picker: "mode", run: () => undefined },
      ...(levels.length
        ? [{ id: "effort", label: "Switch reasoning effort…", hint: effortName, keywords: "effort reasoning thinking", icon: "effort" as const, command: "effortPicker" as const, picker: "effort", run: () => undefined }]
        : []),
      ...(o.onHandoff ? [{ id: "handoff", label: "Continue in another agent…", keywords: "handoff continue another agent switch codex claude", icon: "handoff" as const, takesFocus: true, run: o.onHandoff }] : []),
      ...(o.exportable
        ? [
            { id: "export-md", label: "Download as Markdown", keywords: "export download markdown md save", icon: "download" as const, run: download("md") },
            { id: "export-json", label: "Download JSON", keywords: "export download json save", icon: "download" as const, run: download("json") },
          ]
        : []),
      ...(o.onStop ? [{ id: "stop", label: "Stop the turn", keywords: "stop interrupt cancel turn", icon: "stop" as const, command: "stop" as const, run: o.onStop }] : []),
    ];
    const pickers: PalettePicker[] = [
      {
        id: "model",
        title: o.agent === "claude" ? "Model" : `${o.agentName} model`,
        placeholder: "Choose a model…",
        choices: o.models.map((m) => ({ value: m.key, label: m.name, hint: m.key === "" && m.name === "Default" && o.defaultModel ? nameOf(o.defaultModel) : undefined, current: (o.model ?? "") === m.key })),
        pick: o.onModel,
      },
      {
        id: "mode",
        title: "Approvals",
        placeholder: "Choose an approval mode…",
        choices: MODES.map((m) => ({ value: m.key, label: m.name, hint: m.desc, current: m.key === o.mode })),
        pick: (v) => o.onMode(v as PermissionMode),
      },
    ];
    if (levels.length) {
      pickers.push({
        id: "effort",
        title: "Reasoning effort",
        placeholder: "Choose a reasoning effort…",
        choices: [
          { value: "", label: "Default", hint: o.defaultEffort ? `Default: ${effortLabel(o.agent, o.defaultEffort) ?? o.defaultEffort}` : `${o.agentName} decides`, current: !o.effort },
          ...levels.map((l) => ({ value: l.key, label: l.name, hint: l.desc, current: l.key === o.effort })),
        ],
        pick: o.onEffort,
      });
    }
    return { actions, pickers };
  });
}
