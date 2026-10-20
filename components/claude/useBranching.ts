"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AGENT_LABEL, type AgentId, type Entry, type PermissionMode } from "@/lib/types";
import { api } from "@/lib/client/api";
import { editBody, editPlan, lastPrompt, lastReply } from "@/lib/client/branching";
import { usePaletteSource } from "@/lib/client/palette-actions";
import { toast } from "@/lib/client/toast";
import type { GitInfo } from "@/lib/client/useGitInfo";
import { confirmAsk, promptAsk } from "./Ask";

const clientId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const failure = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Edit from here (a prompt's text goes into the composer; sending it continues the conversation from just before it,
 * in a new session, files put back first when a checkpoint has them) and Fork from here (a reply's conversation so far
 * in a new session, opened in its own tab). The source session is never changed.
 */
export function useBranching(o: {
  id: string;
  agent: AgentId;
  entries: Entry[];
  git: GitInfo | null;
  busy: boolean;
  /** the session can take a new turn (it exists and has a folder) */
  ready: boolean;
  mode: PermissionMode;
  model: string | null;
  profile: string;
  effort: string;
  onNavigate: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const latest = useRef(o);
  latest.current = o;
  const [editing, setEditing] = useState<{ entryId: string; text: string } | null>(null);
  useEffect(() => setEditing(null), [o.id]);

  const startEdit = useCallback((entryId: string) => {
    const e = latest.current.entries.find((x) => x.kind === "user" && x.id === entryId);
    if (e?.kind === "user") setEditing({ entryId, text: e.text });
  }, []);

  const fork = useCallback(async (entryId: string) => {
    const { id, agent, mode, model, profile, effort } = latest.current;
    let text = "";
    if (agent !== "claude") {
      const t = await promptAsk({
        title: "Fork from here",
        body: `${AGENT_LABEL[agent]} can't copy part of a conversation, so the new session starts with the turns so far as context and this message.`,
        confirm: "Fork",
      });
      if (!t) return;
      text = t;
    }
    const key = `fork:${id}`;
    toast({ title: "Forking…", key, duration: 0 });
    try {
      const r = await api<{ id: string }>(`/api/sessions/${id}/fork`, { entryId, text: text || undefined, permissionMode: mode, model: model ?? undefined, profile, effort: effort || undefined, clientId: clientId() });
      toast({ title: "Forked into a new tab.", key, tone: "success" });
      latest.current.onOpen(r.id);
    } catch (err) {
      toast({ title: "Couldn't fork.", body: failure(err), key, tone: "error" });
    }
  }, []);

  const sendEdit = useCallback(
    async (text: string) => {
      if (!editing) return false;
      const { id, entries, git, mode, model, profile, effort, onNavigate } = latest.current;
      const plan = editPlan(entries, git?.checkpoints ?? [], editing.entryId);
      if (plan.checkpoint) {
        const ok = await confirmAsk({ title: "Put the files back and send?", body: editBody(plan), confirm: "Put back and send", danger: true });
        if (!ok) return false;
      }
      try {
        const r = await api<{ id: string }>(`/api/sessions/${id}/edit`, {
          entryId: editing.entryId,
          text,
          checkpoint: plan.checkpoint ?? undefined,
          permissionMode: mode,
          model: model ?? undefined,
          profile,
          effort: effort || undefined,
          clientId: clientId(),
        });
        setEditing(null);
        toast({ title: plan.checkpoint ? "Files put back. Continuing from your edit." : "Continuing from your edit.", key: `edit:${id}`, tone: "success" });
        onNavigate(r.id);
        return true;
      } catch (err) {
        toast({ title: "Couldn't edit from here.", body: failure(err), key: `edit:${id}`, tone: "error" });
        return false;
      }
    },
    [editing],
  );

  const plan = useMemo(() => (editing ? editPlan(o.entries, o.git?.checkpoints ?? [], editing.entryId) : null), [editing, o.entries, o.git]);
  const note = editing
    ? {
        label: plan && plan.files && !plan.checkpoint ? "Editing from here. Files stay as they are." : "Editing from here",
        placeholder: "Edit your message…",
        text: editing.text,
        tone: "accent" as const,
        cancelLabel: "Cancel editing",
        onSend: sendEdit,
        onCancel: () => setEditing(null),
      }
    : null;

  const canEdit = o.ready && !o.busy;
  const actions = useMemo(() => ({ onEdit: canEdit ? startEdit : undefined, onFork: o.ready ? (entryId: string) => void fork(entryId) : undefined }), [canEdit, o.ready, startEdit, fork]);

  usePaletteSource("branch", () => {
    const { entries, busy, ready } = latest.current;
    const prompt = ready && !busy ? lastPrompt(entries) : null;
    const reply = ready ? lastReply(entries, busy) : null;
    return {
      actions: [
        ...(prompt ? [{ id: "edit-last", label: "Edit your last message", keywords: "edit rewind redo retry change prompt message from here", icon: "edit" as const, takesFocus: true, run: () => startEdit(prompt.id) }] : []),
        ...(reply ? [{ id: "fork-last", label: "Fork from the last reply", keywords: "fork branch copy duplicate new session from here", icon: "fork" as const, takesFocus: true, run: () => void fork(reply.id) }] : []),
      ],
    };
  });

  return { actions, note, editing: Boolean(editing) };
}
