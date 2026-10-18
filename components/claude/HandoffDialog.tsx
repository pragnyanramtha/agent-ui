"use client";

import { useMemo, useState } from "react";
import { AGENT_IDS, AGENT_LABEL, type AgentId, type PermissionMode } from "@/lib/types";
import { ApiError } from "@/lib/client/api";
import { newClientId, postReliably } from "@/lib/client/send";
import { useProfiles } from "@/lib/client/useProfiles";
import { area, field, primaryBtn, secondaryBtn, Sheet } from "./Sheet";

/* Moves a conversation to another agent, account, proxy or model. The original stays as it is;
 * the new session starts with its history (natively for Claude and Codex, as context otherwise). */
export function HandoffDialog({
  id,
  agent,
  current,
  mode,
  onClose,
  onOpen,
}: {
  id: string;
  agent: AgentId;
  current: string | null;
  mode: PermissionMode;
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  const { profiles } = useProfiles();
  const choices = useMemo(() => (profiles ?? []).filter((p) => !p.hidden && p.installed && p.id !== (current ?? agent)), [profiles, current, agent]);
  const [pick, setPick] = useState<string>("");
  const chosen = choices.find((p) => p.id === pick) ?? choices[0];
  const [model, setModel] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientId] = useState(newClientId);

  const go = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const target = chosen.agent;
      const r = await postReliably<{ id: string }>(
        `/api/sessions/${id}/handoff`,
        { profile: chosen.id, model: model.trim() || undefined, text, permissionMode: target === "claude" ? mode : "bypassPermissions" },
        clientId,
      );
      onOpen(r.id);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reach the server.");
      setBusy(false);
    }
  };

  return (
    <Sheet
      title="Continue in another agent"
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className={secondaryBtn}>
            Cancel
          </button>
          <button type="button" onClick={go} disabled={!chosen || busy} className={primaryBtn}>
            {busy ? `Starting ${chosen?.label ?? ""}…` : "Continue"}
          </button>
        </>
      }
    >
      <p className="pb-3 text-[13px] text-ink-3">Starts a new session with this history. This one is kept.</p>
      {profiles === null ? (
        <p className="py-4 text-[13px] text-ink-3">Loading profiles…</p>
      ) : choices.length === 0 ? (
        <p className="py-4 text-[13px] text-ink-3">No other profiles. Add one under Agents.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <div role="radiogroup" aria-label="Continue on" className="flex flex-col gap-0.5">
            {AGENT_IDS.flatMap((a) => choices.filter((p) => p.agent === a)).map((p) => (
              <label key={p.id} className={`flex min-h-10 cursor-pointer items-center gap-3 rounded-[9px] px-2.5 text-[13.5px] hover:bg-hover ${chosen?.id === p.id ? "bg-hover" : ""}`}>
                <input
                  type="radio"
                  name="handoff-profile"
                  checked={chosen?.id === p.id}
                  onChange={() => {
                    setPick(p.id);
                    setModel("");
                  }}
                  className="accent-[var(--color-ink)]"
                />
                <span className="min-w-0 flex-1 truncate text-ink">{p.label}</span>
                {p.id !== p.agent && <span className="shrink-0 text-[12px] text-ink-3">{AGENT_LABEL[p.agent]}</span>}
              </label>
            ))}
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-ink-3">Model (optional)</span>
            <input value={model} onChange={(e) => setModel(e.target.value)} list="handoff-models" placeholder={chosen?.defaultModel ?? "Default"} className={field} autoComplete="off" spellCheck={false} />
            <datalist id="handoff-models">{chosen?.models.map((m) => <option key={m} value={m} />)}</datalist>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-ink-3">Next message (optional)</span>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="Carry on where it left off" className={area} />
          </label>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-3 rounded-[10px] bg-red-tint px-3 py-2 text-[13px] text-red-ink">
          {error}
        </p>
      )}
    </Sheet>
  );
}
