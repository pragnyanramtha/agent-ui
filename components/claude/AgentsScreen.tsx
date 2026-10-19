"use client";

import { confirmAsk, promptAsk } from "./Ask";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Menu, Plus, Terminal, Trash } from "iconoir-react";
import { AGENT_IDS, AGENT_LABEL, type AgentId, type ProfileInfo, type ServerTerminal } from "@/lib/types";
import { effortOptions } from "@/lib/agent-traits";
import { api, ApiError, shortPath, timeAgo } from "@/lib/client/api";
import { openServerTerminal } from "@/lib/client/terminals";
import { setProfilesCache, useProfiles } from "@/lib/client/useProfiles";
import { OPEN_TERMINAL_EVENT } from "./CommandPalette";
import { FolderPicker } from "./FolderPicker";
import { AGENT_TONE } from "./SessionList";
import { area as areaBase, field, primaryBtn, secondaryBtn, Sheet } from "./Sheet";

/* Agents on the server: what's running in kept terminals (they carry on with every browser closed),
 * starting an agent's own TUI there, and the profiles (accounts, proxies, wrappers) agents run on. */

export function AgentsScreen({ onMenu, extra, onOpenSession, projects }: { onMenu: () => void; extra?: ReactNode; onOpenSession: (id: string) => void; projects: string[] }) {
  return (
    <section className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="on-page safe-top safe-x flex shrink-0 items-center bg-page">
        <div className="flex h-14 w-full min-w-0 items-center gap-1 px-1.5 sm:px-3 lg:h-[52px]">
          <button type="button" onClick={onMenu} aria-label="Open sessions" aria-haspopup="dialog" data-drawer-opener className="icon-btn lg:hidden">
            <Menu width={19} height={19} strokeWidth={1.8} />
          </button>
          <h1 className="min-w-0 flex-1 truncate px-1.5 text-[15px] font-medium tracking-[-0.01em] text-ink sm:text-[14.5px]">Agents</h1>
          {extra}
        </div>
      </header>
      <div className="safe-x safe-bottom min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex w-full max-w-[820px] flex-col gap-8 px-3 pt-2 pb-16 sm:px-6">
          <Launcher projects={projects} />
          <Terminals onOpenSession={onOpenSession} />
          <Profiles />
        </div>
      </div>
    </section>
  );
}

function H({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 pb-2">
      <h2 className="min-w-0 flex-1 text-[13px] font-semibold text-ink">{children}</h2>
      {aside}
    </div>
  );
}

/* ── start one ─────────────────────────────────────────────── */

function Launcher({ projects }: { projects: string[] }) {
  const { profiles } = useProfiles();
  const usable = (profiles ?? []).filter((p) => !p.hidden);
  const [profile, setProfile] = useState("");
  const [cwd, setCwd] = useState("");
  const [model, setModel] = useState("");
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setCwd((c) => c || localStorage.getItem("cui:lastCwd") || projects[0] || "");
    setProfile((p) => p || localStorage.getItem("cui:launchProfile") || "claude");
  }, [projects]);
  const chosen = usable.find((p) => p.id === profile) ?? usable[0];

  const start = async () => {
    if (!chosen) return;
    if (!cwd) return setPicker(true);
    setBusy(true);
    setError(null);
    try {
      const t = await api<{ id: string; backing: string; label: string }>("/api/terminals", { profile: chosen.id, cwd, model: model.trim() || undefined });
      localStorage.setItem("cui:launchProfile", chosen.id);
      localStorage.setItem("cui:lastCwd", cwd);
      openServerTerminal(t, `${t.label} in ${cwd.split("/").pop()}`);
      window.dispatchEvent(new Event(TERMINALS_CHANGED));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="launch-h">
      <H>
        <span id="launch-h">Start an agent</span>
      </H>
      <div className="flex flex-col gap-2 rounded-[12px] bg-surface p-3 shadow-hairline sm:flex-row sm:items-end">
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[12px] font-medium text-ink-3">Agent</span>
          <select value={chosen?.id ?? ""} onChange={(e) => setProfile(e.target.value)} className={field}>
            {AGENT_IDS.flatMap((a) => usable.filter((p) => p.agent === a)).map((p) => (
              <option key={p.id} value={p.id} disabled={!p.installed}>
                {p.label}
                {p.installed ? "" : " (not installed)"}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-[1.4] flex-col gap-1">
          <span className="text-[12px] font-medium text-ink-3">Folder</span>
          <button type="button" onClick={() => setPicker(true)} className={`${field} truncate text-left`} translate="no">
            {cwd ? shortPath(cwd) : <span className="text-ink-3">Choose a folder</span>}
          </button>
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[12px] font-medium text-ink-3">Model</span>
          <input value={model} onChange={(e) => setModel(e.target.value)} list="launch-models" placeholder={chosen?.defaultModel ?? "Default"} className={field} autoComplete="off" spellCheck={false} />
          <datalist id="launch-models">{chosen?.models.map((m) => <option key={m} value={m} />)}</datalist>
        </label>
        <div className="flex gap-2">
          <button type="button" onClick={() => void start()} disabled={busy || !chosen?.installed} className={`${primaryBtn} flex-1 gap-1.5`}>
            <Terminal width={15} height={15} strokeWidth={1.9} />
            {busy ? "Starting…" : "Start"}
          </button>
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent(OPEN_TERMINAL_EVENT, { detail: { cwd: cwd || undefined, label: `Shell: ${shortPath(cwd || "~")}` } }))}
            className={secondaryBtn}
          >
            Shell
          </button>
        </div>
      </div>
      <p className="px-1 pt-1.5 text-[12px] text-ink-3">Keeps running after you close the tab.</p>
      {error && <p className="mt-2 rounded-[10px] bg-red-tint px-3 py-2 text-[13px] text-red-ink">{error}</p>}
      <FolderPicker open={picker} value={cwd} recent={projects} onPick={setCwd} onClose={() => setPicker(false)} />
    </section>
  );
}

/* ── what's running ────────────────────────────────────────── */

const TERMINALS_CHANGED = "agentu:terminals";

function Terminals({ onOpenSession }: { onOpenSession: (id: string) => void }) {
  const [data, setData] = useState<{ terminals: ServerTerminal[]; tmux: boolean; error?: string } | null>(null);
  const load = useCallback(() => api<{ terminals: ServerTerminal[]; tmux: boolean; error?: string }>("/api/terminals").then(setData, () => undefined), []);
  useEffect(() => {
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 5000);
    const on = () => setTimeout(() => void load(), 800);
    window.addEventListener(TERMINALS_CHANGED, on);
    return () => {
      clearInterval(t);
      window.removeEventListener(TERMINALS_CHANGED, on);
    };
  }, [load]);

  const stop = async (t: ServerTerminal) => {
    if (!t.exited && !(await confirmAsk({ title: `Stop ${t.label}?`, body: "Ends what's running. History stays.", confirm: "Stop", danger: true }))) return;
    await fetch("/api/terminals", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: t.id }) });
    void load();
  };

  const now = Date.now();
  return (
    <section aria-labelledby="terms-h">
      <H aside={data && !data.tmux ? <span className="text-[12px] text-ink-3">Install tmux so these survive restarts</span> : null}>
        <span id="terms-h">Running</span>
      </H>
      {data?.error && <p className="rounded-[10px] bg-red-tint px-3 py-2 text-[13px] text-red-ink">{data.error}</p>}
      {data === null ? (
        <p className="px-1 text-[13px] text-ink-3">Loading terminals…</p>
      ) : data.terminals.length === 0 ? (
        <p className="px-1 text-[13px] text-ink-3">Nothing running.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-[12px] bg-surface shadow-hairline">
          {data.terminals.map((t) => (
            <li key={t.id} className="flex min-h-12 items-center gap-3 px-3 py-2">
              <span className={`size-2 shrink-0 rounded-full ${t.exited ? "bg-line-strong" : "animate-pulse bg-green"}`} aria-hidden />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13.5px] text-ink">{t.label}</span>
                <span className="truncate text-[12px] text-ink-3" translate="no">
                  {[t.cwd && shortPath(t.cwd), t.exited ? `Exited (${t.exited.code})` : t.clients ? `${t.clients} watching` : "Running", t.createdAt ? timeAgo(t.createdAt, now) : ""].filter(Boolean).join(" · ")}
                </span>
              </div>
              {t.session && (
                <button type="button" onClick={() => onOpenSession(t.session!)} className="h-8 shrink-0 rounded-full px-2.5 text-[12.5px] font-medium text-ink-2 hover:bg-hover max-sm:hidden">
                  Session
                </button>
              )}
              <button type="button" onClick={() => openServerTerminal(t, t.label)} className="h-8 shrink-0 rounded-full px-3 text-[12.5px] font-medium text-ink shadow-btn hover:bg-hover">
                Open
              </button>
              <button type="button" onClick={() => void stop(t)} aria-label={t.exited ? `Remove ${t.label}` : `Stop ${t.label}`} className="icon-btn shrink-0 text-ink-3">
                <Trash width={15} height={15} strokeWidth={1.8} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ── profiles ──────────────────────────────────────────────── */

type Draft = { id: string; label: string; agent: AgentId; bin: string; args: string; env: string; models: string; defaultModel: string; defaultEffort: string; fallback: string; launchArgs: string; notes: string; hidden: boolean };

const toDraft = (p: ProfileInfo): Draft => ({
  id: p.id,
  label: p.label,
  agent: p.agent,
  bin: p.bin,
  args: p.args.join("\n"),
  env: Object.entries(p.env).map(([k, v]) => `${k}=${v}`).join("\n"),
  models: p.models.join(", "),
  defaultModel: p.defaultModel ?? "",
  defaultEffort: p.defaultEffort ?? "",
  fallback: p.fallback.join(", "),
  launchArgs: p.launchArgs.join("\n"),
  notes: p.notes,
  hidden: p.hidden,
});

const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
const commas = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

const fromDraft = (d: Draft) => ({
  id: d.id.trim(),
  label: d.label.trim() || d.id.trim(),
  agent: d.agent,
  bin: d.bin.trim() || undefined,
  args: lines(d.args),
  env: Object.fromEntries(lines(d.env).map((l) => [l.slice(0, l.indexOf("=") < 0 ? l.length : l.indexOf("=")).trim(), l.indexOf("=") < 0 ? "" : l.slice(l.indexOf("=") + 1)])),
  models: commas(d.models),
  defaultModel: d.defaultModel.trim() || undefined,
  defaultEffort: effortOptions(d.agent).some((o) => o.key === d.defaultEffort) ? d.defaultEffort : undefined,
  fallback: commas(d.fallback),
  launchArgs: lines(d.launchArgs),
  notes: d.notes,
  hidden: d.hidden || undefined,
});

const stored = (p: ProfileInfo) => fromDraft(toDraft(p));

function Profiles() {
  const { profiles, configPath } = useProfiles();
  const [edit, setEdit] = useState<{ draft: Draft; isNew: boolean; from?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (next: (ReturnType<typeof fromDraft> & { previousId?: string })[]) => {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/profiles", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profiles: next }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      setProfilesCache(d);
      setEdit(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save.");
    } finally {
      setSaving(false);
    }
  };

  const custom = (profiles ?? []).filter((p) => p.custom);
  const submit = () => {
    if (!edit) return;
    const p = fromDraft(edit.draft);
    const renamed = !edit.isNew && edit.from && edit.from !== p.id ? edit.from : null;
    if ((edit.isNew || renamed) && (profiles ?? []).some((x) => x.id === p.id && (x.custom || x.builtin))) return setError(`Profile ${p.id} already exists.`);
    /* a rename replaces the old entry; its masked secrets are looked up under the old id */
    const rest = custom.filter((c) => c.id !== p.id && c.id !== renamed).map(stored);
    void save([...rest, renamed ? { ...p, previousId: renamed } : p]);
  };
  const reset = async (p: ProfileInfo) => {
    const ok = await confirmAsk(p.builtin ? { title: `Reset ${p.label}?`, body: "Your changes will be lost.", confirm: "Reset" } : { title: `Delete ${p.label}?`, body: "Its sessions switch to the built-in profile.", confirm: "Delete", danger: true });
    if (!ok) return;
    void save(custom.filter((c) => c.id !== p.id).map(stored));
  };

  return (
    <section aria-labelledby="profiles-h">
      <H
        aside={
          <button
            type="button"
            onClick={() => setEdit({ isNew: true, draft: { id: "", label: "", agent: "codex", bin: "", args: "", env: "", models: "", defaultModel: "", defaultEffort: "", fallback: "", launchArgs: "", notes: "", hidden: false } })}
            className="inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-[12.5px] font-medium text-ink shadow-btn hover:bg-hover"
          >
            <Plus width={14} height={14} strokeWidth={2} /> Add profile
          </button>
        }
      >
        <span id="profiles-h">Profiles</span>
      </H>
      <p className="px-1 pb-2 text-[12px] text-ink-3">
        Accounts, proxies and wrappers per agent. Stored in{" "}
        <code className="font-mono" translate="no">
          {shortPath(configPath)}
        </code>
        .
      </p>
      {error && !edit && <p className="mb-2 rounded-[10px] bg-red-tint px-3 py-2 text-[13px] text-red-ink">{error}</p>}
      {profiles === null ? (
        <p className="px-1 text-[13px] text-ink-3">Loading profiles…</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-[12px] bg-surface shadow-hairline">
          {AGENT_IDS.flatMap((a) => profiles.filter((p) => p.agent === a)).map((p) => (
            <li key={p.id} className="flex min-h-12 items-center gap-3 px-3 py-2">
              <span className={`size-2 shrink-0 rounded-full ${AGENT_TONE[p.agent]} ${p.installed ? "" : "opacity-30"}`} aria-hidden />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className={`truncate text-[13.5px] ${p.hidden ? "text-ink-3" : "text-ink"}`}>
                  {p.label}
                  <span className="text-ink-3"> · {p.id === p.agent ? "Built-in" : AGENT_LABEL[p.agent]}</span>
                </span>
                <span className="truncate font-mono text-[11.5px] text-ink-3" translate="no">
                  {p.installed ? shortPath(p.binPath ?? p.bin ?? p.agent) : `${p.bin || p.agent} not found`}
                  {p.models.length ? ` · ${p.models.join(", ")}` : ""}
                  {p.fallback.length ? ` · then ${p.fallback.join(", ")}` : ""}
                </span>
              </div>
              {p.custom && (
                <button type="button" onClick={() => reset(p)} className="h-8 shrink-0 rounded-full px-2.5 text-[12.5px] font-medium text-ink-3 hover:bg-hover hover:text-ink">
                  {p.builtin ? "Reset" : "Delete"}
                </button>
              )}
              <button type="button" onClick={() => setEdit({ isNew: false, draft: toDraft(p), from: p.id })} className="h-8 shrink-0 rounded-full px-3 text-[12.5px] font-medium text-ink shadow-btn hover:bg-hover">
                Edit
              </button>
            </li>
          ))}
        </ul>
      )}
      {edit && <ProfileEditor edit={edit} setEdit={setEdit} onSave={submit} saving={saving} error={error} profiles={profiles ?? []} />}
    </section>
  );
}

function ProfileEditor({
  edit,
  setEdit,
  onSave,
  saving,
  error,
  profiles,
}: {
  edit: { draft: Draft; isNew: boolean; from?: string };
  setEdit: (e: { draft: Draft; isNew: boolean; from?: string } | null) => void;
  onSave: () => void;
  saving: boolean;
  error: string | null;
  profiles: ProfileInfo[];
}) {
  const d = edit.draft;
  const set = (patch: Partial<Draft>) => setEdit({ ...edit, draft: { ...d, ...patch } });
  const builtin = AGENT_IDS.includes(d.id as AgentId);
  const close = useCallback(() => setEdit(null), [setEdit]);
  const row = (label: string, hint: string, control: ReactNode) => (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] font-medium text-ink-2">{label}</span>
      {control}
      {hint && <span className="text-[11.5px] text-ink-3">{hint}</span>}
    </label>
  );
  const area = `${areaBase} font-mono sm:text-[12.5px]`;
  return (
    <Sheet
      title={edit.isNew ? "New profile" : `Edit ${d.label || d.id}`}
      onClose={close}
      wide
      footer={
        <>
          {error && <span className="mr-auto min-w-0 truncate text-[12.5px] text-red-ink">{error}</span>}
          <button type="button" onClick={close} className={secondaryBtn}>
            Cancel
          </button>
          <button type="button" onClick={onSave} disabled={saving || !d.id.trim()} className={primaryBtn}>
            {saving ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {row("Id", "Lowercase letters, digits, . _ -", <input value={d.id} onChange={(e) => set({ id: e.target.value })} disabled={!edit.isNew} className={field} placeholder="codex-proxy" spellCheck={false} autoCapitalize="off" />)}
        {row("Name", "", <input value={d.label} onChange={(e) => set({ label: e.target.value })} className={field} placeholder="Codex via proxy" />)}
        {row(
          "Agent",
          "",
          <select value={d.agent} onChange={(e) => set({ agent: e.target.value as AgentId })} disabled={builtin} className={field}>
            {AGENT_IDS.map((a) => (
              <option key={a} value={a}>
                {AGENT_LABEL[a]}
              </option>
            ))}
          </select>,
        )}
        {row("Binary", "Name on PATH or absolute path. Empty for default.", <input value={d.bin} onChange={(e) => set({ bin: e.target.value })} className={`${field} font-mono`} placeholder={d.agent === "cursor" ? "cursor-agent" : d.agent === "antigravity" ? "agy" : d.agent} spellCheck={false} autoCapitalize="off" />)}
        {row("Arguments", "One per line, before the agent's own", <textarea rows={3} value={d.args} onChange={(e) => set({ args: e.target.value })} className={area} spellCheck={false} autoCapitalize="off" />)}
        {row("Environment", "KEY=value per line. ${VAR} reads .env.local.", <textarea rows={3} value={d.env} onChange={(e) => set({ env: e.target.value })} className={area} spellCheck={false} autoCapitalize="off" placeholder={"OPENAI_BASE_URL=https://proxy.example/v1\nOPENAI_API_KEY=${PROXY_KEY}"} />)}
        {row("Models", "Comma separated", <input value={d.models} onChange={(e) => set({ models: e.target.value })} className={`${field} font-mono`} spellCheck={false} autoCapitalize="off" />)}
        {row("Default model", "", <input value={d.defaultModel} onChange={(e) => set({ defaultModel: e.target.value })} className={`${field} font-mono`} spellCheck={false} autoCapitalize="off" />)}
        {effortOptions(d.agent).length > 0 &&
          row(
            "Default effort",
            "When a session hasn't picked one",
            <select value={d.defaultEffort} onChange={(e) => set({ defaultEffort: e.target.value })} className={field}>
              <option value="">Agent default</option>
              {effortOptions(d.agent).map((o) => (
                <option key={o.key} value={o.key}>
                  {o.name}
                </option>
              ))}
            </select>,
          )}
        {row(
          "Fallback profiles",
          `Comma separated, used in order on a usage limit. Known: ${profiles.filter((p) => p.id !== d.id).map((p) => p.id).join(", ")}`,
          <input value={d.fallback} onChange={(e) => set({ fallback: e.target.value })} className={`${field} font-mono`} spellCheck={false} autoCapitalize="off" />,
        )}
        {row("Terminal arguments", "One per line, terminal only", <textarea rows={2} value={d.launchArgs} onChange={(e) => set({ launchArgs: e.target.value })} className={area} spellCheck={false} autoCapitalize="off" />)}
        {row("Notes", "", <input value={d.notes} onChange={(e) => set({ notes: e.target.value })} className={field} />)}
        <label className="flex items-center gap-2 self-end pb-2 text-[13px] text-ink-2">
          <input type="checkbox" checked={d.hidden} onChange={(e) => set({ hidden: e.target.checked })} />
          Hide from menus
        </label>
      </div>
    </Sheet>
  );
}
