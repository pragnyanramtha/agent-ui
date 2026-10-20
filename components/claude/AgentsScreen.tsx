"use client";

import { confirmAsk, promptAsk } from "./Ask";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check as CheckIcon, Copy, Menu, Plus, Terminal, Trash } from "iconoir-react";
import { AGENT_IDS, AGENT_LABEL, type AgentId, type ProfileInfo, type ServerTerminal } from "@/lib/types";
import { effortOptions } from "@/lib/agent-traits";
import { api, ApiError, shortPath, timeAgo } from "@/lib/client/api";
import type { Check as HealthRow, CheckStatus as HealthStatus, DoctorReport } from "@/lib/server/doctor";
import { openServerTerminal } from "@/lib/client/terminals";
import { reloadProfiles, setProfilesCache, useProfiles } from "@/lib/client/useProfiles";
import { launcherEmpty } from "@/lib/empty-states";
import { EmptyState } from "@/components/primitives/EmptyState";
import { useSetting } from "@/lib/client/settings";
import { clockTime } from "@/lib/time-format";
import { copyText } from "./CodeCard";
import { OPEN_TERMINAL_EVENT } from "@/lib/client/events";
import { FolderPicker } from "./FolderPicker";
import { Select } from "./Select";
import { AgentIcon } from "./AgentIcon";
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
          <h1 className="min-w-0 flex-1 truncate px-1.5 text-md font-medium tracking-[-0.01em] text-ink sm:text-base">Agents</h1>
          {extra}
        </div>
      </header>
      <div className="safe-x safe-bottom min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex w-full max-w-[820px] flex-col gap-8 px-3 pt-2 pb-16 sm:px-6">
          <Launcher projects={projects} />
          <Terminals onOpenSession={onOpenSession} />
          <Profiles />
          <HealthCheck />
        </div>
      </div>
    </section>
  );
}

function H({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 pb-2">
      <h2 className="min-w-0 flex-1 text-sm font-semibold text-ink">{children}</h2>
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
  const none = launcherEmpty(profiles);
  const [checking, setChecking] = useState(false);
  const checkAgain = () => {
    setChecking(true);
    void reloadProfiles()
      .catch(() => setError("Couldn't reach the server."))
      .finally(() => setChecking(false));
  };
  const openShell = () => window.dispatchEvent(new CustomEvent(OPEN_TERMINAL_EVENT, { detail: { cwd: cwd || undefined, label: `Shell: ${shortPath(cwd || "~")}` } }));

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
      {none ? (
        <div className="rounded-[12px] bg-surface shadow-hairline">
          <EmptyState
            className="py-8"
            icon={<Terminal width={18} height={18} strokeWidth={1.8} />}
            {...none}
            actions={[
              { label: "Open a shell", onClick: openShell },
              { label: checking ? "Checking…" : "Check again", onClick: checkAgain, disabled: checking },
            ]}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-2 rounded-[12px] bg-surface p-3 shadow-hairline sm:flex-row sm:items-end">
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-xs font-medium text-ink-3">Agent</span>
            <Select
              label="Agent"
              value={chosen?.id ?? ""}
              onChange={setProfile}
              options={AGENT_IDS.flatMap((a) => usable.filter((p) => p.agent === a)).map((p) => ({ value: p.id, label: p.label, hint: p.installed ? undefined : "Not installed", disabled: !p.installed }))}
            />
          </label>
          <label className="flex min-w-0 flex-[1.4] flex-col gap-1">
            <span className="text-xs font-medium text-ink-3">Folder</span>
            <button type="button" onClick={() => setPicker(true)} className={`${field} truncate text-left`} translate="no">
              {cwd ? shortPath(cwd) : <span className="text-ink-3">Choose a folder</span>}
            </button>
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-xs font-medium text-ink-3">Model</span>
            <input value={model} onChange={(e) => setModel(e.target.value)} list="launch-models" placeholder={chosen?.defaultModel ?? "Default"} className={field} autoComplete="off" spellCheck={false} />
            <datalist id="launch-models">{chosen?.models.map((m) => <option key={m} value={m} />)}</datalist>
          </label>
          <div className="flex gap-2">
            <button type="button" onClick={() => void start()} disabled={busy || !chosen?.installed} className={`${primaryBtn} flex-1 gap-1.5`}>
              <Terminal width={15} height={15} strokeWidth={1.9} />
              {busy ? "Starting…" : "Start"}
            </button>
            <button type="button" onClick={openShell} className={secondaryBtn}>
              Shell
            </button>
          </div>
        </div>
      )}
      {!none && <p className="px-1 pt-1.5 text-xs text-ink-3">Keeps running after you close the tab.</p>}
      {error && <p className="mt-2 rounded-[10px] bg-red-tint px-3 py-2 text-sm text-red-ink">{error}</p>}
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
      <H aside={data && !data.tmux ? <span className="text-xs text-ink-3">Install tmux so these survive restarts</span> : null}>
        <span id="terms-h">Running</span>
      </H>
      {data?.error && data.terminals.length > 0 && <p className="rounded-[10px] bg-red-tint px-3 py-2 text-sm text-red-ink">{data.error}</p>}
      {data === null ? (
        <p className="px-1 text-sm text-ink-3">Loading terminals…</p>
      ) : data.error && !data.terminals.length ? (
        <EmptyState size="inline" tone="error" className="px-1" icon={<Terminal width={15} height={15} strokeWidth={1.8} />} title="Can't list terminals" body={data.error} actions={[{ label: "Try again", onClick: () => void load() }]} />
      ) : data.terminals.length === 0 ? (
        <EmptyState size="inline" className="px-1" icon={<Terminal width={15} height={15} strokeWidth={1.8} />} title="Nothing running" body="Agents you start above keep running here after you close the tab." />
      ) : (
        <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-[12px] bg-surface shadow-hairline">
          {data.terminals.map((t) => (
            <li key={t.id} className="flex min-h-12 items-center gap-3 px-3 py-2">
              <span className={`size-2 shrink-0 rounded-full ${t.exited ? "bg-line-strong" : "animate-pulse bg-green"}`} aria-hidden />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm text-ink">{t.label}</span>
                <span className="truncate text-xs text-ink-3" translate="no">
                  {[t.cwd && shortPath(t.cwd), t.exited ? `Exited (${t.exited.code})` : t.clients ? `${t.clients} watching` : "Running", t.createdAt ? timeAgo(t.createdAt, now) : ""].filter(Boolean).join(" · ")}
                </span>
              </div>
              {t.session && (
                <button type="button" onClick={() => onOpenSession(t.session!)} className="h-8 shrink-0 rounded-full pointer-coarse:h-10 px-2.5 text-sm font-medium text-ink-2 hover:bg-hover max-sm:hidden">
                  Session
                </button>
              )}
              <button type="button" onClick={() => openServerTerminal(t, t.label)} className="h-8 shrink-0 rounded-full pointer-coarse:h-10 px-3 text-sm font-medium text-ink shadow-btn hover:bg-hover">
                Open
              </button>
              <button type="button" onClick={() => void stop(t)} aria-label={t.exited ? `Remove ${t.label}` : `Stop ${t.label}`} className="icon-btn shrink-0 text-ink-3 pointer-coarse:size-10">
                <Trash width={15} height={15} strokeWidth={1.8} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ── health check ──────────────────────────────────────────── */

const DOT: Record<HealthStatus, string> = { ok: "bg-green", warn: "bg-orange", fail: "bg-red", unknown: "bg-line-strong" };
const SAYS: Record<HealthStatus, string> = { ok: "OK", warn: "Warning", fail: "Problem", unknown: "Unknown" };

function HealthCheck() {
  const [fmt] = useSetting("timeFormat");
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await api<DoctorReport>("/api/doctor"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  };

  const rows = report?.checks ?? [];
  /* agents this server doesn't have fold into one line */
  const absent = rows.filter((r) => r.group === "agents" && r.status === "unknown" && r.detail === "Not installed");
  const agents = rows.filter((r) => r.group === "agents" && !absent.includes(r));
  const system = rows.filter((r) => r.group === "system");
  const fails = rows.filter((r) => r.status === "fail").length;
  const warns = rows.filter((r) => r.status === "warn").length;
  const summary = !report ? null : fails || warns ? [fails && `${fails} ${fails === 1 ? "problem" : "problems"}`, warns && `${warns} ${warns === 1 ? "warning" : "warnings"}`].filter(Boolean).join(", ") : "Everything looks fine";

  return (
    <section aria-labelledby="health-h">
      <H
        aside={
          <button type="button" onClick={() => void check()} disabled={busy} className="inline-flex h-8 items-center gap-1 rounded-full px-3 text-sm font-medium text-ink shadow-btn hover:bg-hover disabled:opacity-60">
            {busy ? "Checking…" : report ? "Check again" : "Run check"}
          </button>
        }
      >
        <span id="health-h">Health check</span>
      </H>
      <p className="px-1 pb-2 text-xs text-ink-3" aria-live="polite">
        {summary ? `${summary} · ${clockTime(report!.at, fmt)}` : "If a turn fails, this shows which agent, sign-in or service is the cause."}
      </p>
      {error && <p className="mb-2 rounded-[10px] bg-red-tint px-3 py-2 text-sm text-red-ink">{error}</p>}
      {report && (
        <div className="flex flex-col gap-3">
          <HealthList rows={agents} footer={absent.length ? `Not installed: ${absent.map((r) => r.label).join(", ")}` : undefined} />
          <HealthList rows={system} />
        </div>
      )}
    </section>
  );
}

function HealthList({ rows, footer }: { rows: HealthRow[]; footer?: string }) {
  if (!rows.length && !footer) return null;
  return (
    <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-[12px] bg-surface shadow-hairline">
      {rows.map((r) => (
        <li key={r.id} className="flex min-h-12 gap-3 px-3 py-2.5">
          <span className={`mt-[7px] size-2 shrink-0 rounded-full ${DOT[r.status]}`} aria-hidden />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-sm text-ink">
              <span className="sr-only">{SAYS[r.status]}: </span>
              {r.label}
            </span>
            <span className="text-xs break-words text-ink-3" translate="no">
              {r.detail}
            </span>
            {r.fix && <FixCommand command={r.fix} />}
          </div>
        </li>
      ))}
      {footer && <li className="px-3 py-2.5 text-xs text-ink-3">{footer}</li>}
    </ul>
  );
}

function FixCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () =>
    copyText(command).then((ok) => {
      if (!ok) return;
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    });
  return (
    <div className="mt-1 flex min-w-0 items-center gap-1 rounded-[8px] bg-inset py-0.5 pr-0.5 pl-2.5">
      <code className="no-scrollbar min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-nowrap text-ink-2" translate="no">
        {command}
      </code>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={copied ? "Copied" : `Copy ${command}`}
        className={`flex h-8 shrink-0 items-center gap-1 rounded-[6px] px-2 text-xs font-medium hover:bg-hover ${copied ? "text-green" : "text-ink-3 hover:text-ink"}`}
      >
        {copied ? <CheckIcon width={13} height={13} strokeWidth={2.2} /> : <Copy width={13} height={13} strokeWidth={1.8} />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
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
            className="inline-flex h-8 items-center gap-1 rounded-full px-2.5 pointer-coarse:h-10 pointer-coarse:px-3 text-sm font-medium text-ink shadow-btn hover:bg-hover"
          >
            <Plus width={14} height={14} strokeWidth={2} /> Add profile
          </button>
        }
      >
        <span id="profiles-h">Profiles</span>
      </H>
      <p className="px-1 pb-2 text-xs text-ink-3">
        Accounts, proxies and wrappers per agent. Stored in{" "}
        <code className="font-mono" translate="no">
          {shortPath(configPath)}
        </code>
        .
      </p>
      {error && !edit && <p className="mb-2 rounded-[10px] bg-red-tint px-3 py-2 text-sm text-red-ink">{error}</p>}
      {profiles === null ? (
        <p className="px-1 text-sm text-ink-3">Loading profiles…</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-[12px] bg-surface shadow-hairline">
          {AGENT_IDS.flatMap((a) => profiles.filter((p) => p.agent === a)).map((p) => (
            <li key={p.id} className="flex min-h-12 items-center gap-3 px-3 py-2">
              <AgentIcon agent={p.agent} size={16} className={p.installed ? "" : "opacity-30"} />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className={`truncate text-sm ${p.hidden ? "text-ink-3" : "text-ink"}`}>
                  {p.label}
                  <span className="text-ink-3"> · {p.id === p.agent ? "Built-in" : AGENT_LABEL[p.agent]}</span>
                </span>
                <span className="truncate font-mono text-xs text-ink-3" translate="no">
                  {p.installed ? shortPath(p.binPath ?? p.bin ?? p.agent) : `${p.bin || p.agent} not found`}
                  {p.models.length ? ` · ${p.models.join(", ")}` : ""}
                  {p.fallback.length ? ` · then ${p.fallback.join(", ")}` : ""}
                </span>
              </div>
              {p.custom && (
                <button type="button" onClick={() => reset(p)} className="h-8 shrink-0 rounded-full pointer-coarse:h-10 px-2.5 text-sm font-medium text-ink-3 hover:bg-hover hover:text-ink">
                  {p.builtin ? "Reset" : "Delete"}
                </button>
              )}
              <button type="button" onClick={() => setEdit({ isNew: false, draft: toDraft(p), from: p.id })} className="h-8 shrink-0 rounded-full pointer-coarse:h-10 px-3 text-sm font-medium text-ink shadow-btn hover:bg-hover">
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
      <span className="text-xs font-medium text-ink-2">{label}</span>
      {control}
      {hint && <span className="text-xs text-ink-3">{hint}</span>}
    </label>
  );
  const area = `${areaBase} font-mono sm:text-sm`;
  return (
    <Sheet
      title={edit.isNew ? "New profile" : `Edit ${d.label || d.id}`}
      onClose={close}
      wide
      footer={
        <>
          {error && <span className="mr-auto min-w-0 truncate text-sm text-red-ink">{error}</span>}
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
          <Select label="Agent" value={d.agent} onChange={(v) => set({ agent: v as AgentId })} disabled={builtin} options={AGENT_IDS.map((a) => ({ value: a, label: AGENT_LABEL[a] }))} />,
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
        <label className="flex items-center gap-2 self-end pb-2 text-sm text-ink-2 pointer-coarse:min-h-10 pointer-coarse:pb-0">
          <input type="checkbox" checked={d.hidden} onChange={(e) => set({ hidden: e.target.checked })} />
          Hide from menus
        </label>
      </div>
    </Sheet>
  );
}
