"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { EditPencil, NavArrowLeft, NavArrowRight, Package, Plus, Search, Trash, Xmark } from "iconoir-react";
import { ACTION_ICONS, canAsk, DEFAULT_BRANCH_PREFIX, folderName, PROJECT_LIMITS, type ActionIcon, type ProjectAction, type ProjectConfig, type ProjectEntry, type ScriptSeed } from "@/lib/projects";
import { effortOptions } from "@/lib/agent-traits";
import type { PermissionMode } from "@/lib/types";
import { ApiError, shortPath } from "@/lib/client/api";
import { forgetProject, listProjects, saveProject, scriptsIn } from "@/lib/client/projects";
import { profileModels, useAgentModels, useProfiles } from "@/lib/client/useProfiles";
import { useSetting } from "@/lib/client/settings";
import { toast } from "@/lib/client/toast";
import { MODELS, MODES } from "@/lib/composer-options";
import { FolderPicker } from "../lazy";
import { ACTION_ICON, ACTION_ICON_LABEL } from "../RunMenu";
import { Card, Row, Segmented, Select, SmallButton, useMediaQuery } from "./controls";

/* Settings > Projects: every folder sessions ran in plus the ones set up here. A project's page holds the defaults
 * new sessions there start with and the actions of the session header's Run menu. Wide screens show the list beside
 * the open project; phones open each one as a page. Changes save as they're made. */

const INPUT = "field-ring h-8 w-full rounded-control border border-line bg-field px-2.5 text-base text-ink outline-none placeholder:text-ink-3 md:text-sm";

const errorText = (err: unknown) => (err instanceof ApiError ? err.message : "Couldn't reach the server.");

export function ProjectsSection() {
  const [list, setList] = useState<ProjectEntry[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [picker, setPicker] = useState(false);
  const wide = useMediaQuery("(min-width: 1024px)");

  const load = () =>
    listProjects().then(
      (l) => {
        setList(l);
        setFailed(null);
        return l;
      },
      (err) => {
        setFailed(errorText(err));
        return null;
      },
    );
  useEffect(() => {
    void load();
  }, []);
  /* wide screens always show one */
  useEffect(() => {
    if (wide && !open && list?.length) setOpen(list[0].path);
  }, [wide, open, list]);

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (list ?? []).filter((p) => words.every((w) => `${p.name} ${p.path}`.toLowerCase().includes(w)));
  }, [list, query]);
  const entry = list?.find((p) => p.path === open) ?? null;

  const addFolder = (path: string) => {
    const clean = path.replace(/\/+$/, "") || path;
    setPicker(false);
    setQuery("");
    if (list?.some((p) => p.path === clean)) return setOpen(clean);
    setList((l) => [{ path: clean, name: folderName(clean), config: null, sessions: 0, lastActive: null, exists: true }, ...(l ?? [])]);
    setOpen(clean);
  };

  const onSaved = (path: string, config: ProjectConfig | null) =>
    setList((l) => (l ?? []).map((p) => (p.path === path ? { ...p, config, name: config?.name ?? folderName(p.path) } : p)));

  const listView = (
    <ProjectList
      list={list}
      shown={shown}
      failed={failed}
      query={query}
      onQuery={setQuery}
      open={wide ? open : null}
      onOpen={setOpen}
      onAdd={() => setPicker(true)}
      onRetry={() => void load()}
      wide={wide}
    />
  );
  const detail = entry ? <ProjectDetail key={entry.path} entry={entry} onSaved={onSaved} onBack={wide ? undefined : () => setOpen(null)} /> : null;

  return (
    <>
      {wide ? (
        <div className="grid grid-cols-[14rem_minmax(0,1fr)] items-start gap-5">
          {listView}
          <div className="flex min-w-0 flex-col gap-6">{detail ?? <p className="py-10 text-center text-sm text-ink-3">{list?.length ? "Choose a project." : "Add a folder to set it up."}</p>}</div>
        </div>
      ) : detail ? (
        <div className="flex flex-col gap-6">{detail}</div>
      ) : (
        listView
      )}
      <FolderPicker open={picker} value={entry?.path ?? ""} recent={(list ?? []).map((p) => p.path).slice(0, 12)} onPick={addFolder} onClose={() => setPicker(false)} />
    </>
  );
}

function ProjectList({
  list,
  shown,
  failed,
  query,
  onQuery,
  open,
  onOpen,
  onAdd,
  onRetry,
  wide,
}: {
  list: ProjectEntry[] | null;
  shown: ProjectEntry[];
  failed: string | null;
  query: string;
  onQuery: (q: string) => void;
  open: string | null;
  onOpen: (path: string) => void;
  onAdd: () => void;
  onRetry: () => void;
  wide: boolean;
}) {
  return (
    <section className={`flex min-w-0 flex-col gap-2 ${wide ? "sticky top-0" : ""}`} aria-label="Projects">
      <div className="flex items-center gap-2">
        <div className="field-ring relative flex h-9 min-w-0 flex-1 items-center gap-2 rounded-control border border-line bg-field px-2.5 md:h-8">
          <Search width={14} height={14} strokeWidth={2} className="shrink-0 text-ink-3" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && query && (e.preventDefault(), e.stopPropagation(), onQuery(""))}
            placeholder="Search projects"
            aria-label="Search projects"
            className="min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-ink-3 md:text-sm [&::-webkit-search-cancel-button]:hidden"
          />
        </div>
        <button type="button" onClick={onAdd} aria-label="Add a folder" data-tip="Add a folder" data-tip-pos="bottom" className="tap relative flex size-9 shrink-0 items-center justify-center rounded-control text-ink-2 shadow-btn hover:bg-hover hover:text-ink md:size-8">
          <Plus width={16} height={16} strokeWidth={1.9} />
        </button>
      </div>
      {failed ? (
        <div className="flex flex-col items-start gap-2 px-1 py-4 text-sm text-ink-3">
          <p>Couldn&apos;t load projects. {failed}</p>
          <SmallButton onClick={onRetry}>Try again</SmallButton>
        </div>
      ) : list === null ? (
        <p className="px-1 py-6 text-sm text-ink-3">Loading projects…</p>
      ) : !shown.length ? (
        <p className="px-1 py-6 text-sm text-ink-3">{query.trim() ? <>No projects match &ldquo;{query.trim()}&rdquo;.</> : "No projects yet. Sessions you start show their folders here."}</p>
      ) : (
        <ul className={wide ? "flex flex-col gap-px" : "divide-y divide-line rounded-card border border-line bg-surface"}>
          {shown.map((p) => {
            const current = p.path === open;
            const actions = p.config?.actions.length ?? 0;
            const meta = [p.config ? (actions ? `${actions} ${actions === 1 ? "action" : "actions"}` : "Set up") : null, p.sessions ? `${p.sessions} ${p.sessions === 1 ? "session" : "sessions"}` : null, p.exists ? null : "Missing"].filter(Boolean).join(" · ");
            return (
              <li key={p.path}>
                <button
                  type="button"
                  onClick={() => onOpen(p.path)}
                  aria-current={current ? "page" : undefined}
                  title={p.path}
                  className={`tap relative flex w-full min-w-0 items-center gap-2.5 text-left ${wide ? `rounded-control px-2.5 py-1.5 ${current ? "bg-sidebar-active" : "hover:bg-hover"}` : "min-h-13 px-3.5 py-2.5"}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className={`flex items-center gap-1.5 truncate text-ink ${wide ? "text-sm" : "text-base"} ${current ? "font-medium" : ""}`}>
                      <span className="truncate">{p.name}</span>
                      {p.config && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="Set up" />}
                    </span>
                    <span className="block truncate text-xs text-ink-3" translate="no">
                      {meta || shortPath(p.path)}
                    </span>
                  </span>
                  {!wide && <NavArrowRight width={15} height={15} strokeWidth={1.9} className="shrink-0 text-ink-3" aria-hidden />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const MODE_LABEL: Record<PermissionMode, string> = Object.fromEntries(MODES.map((m) => [m.key, m.name])) as Record<PermissionMode, string>;

function ProjectDetail({ entry, onSaved, onBack }: { entry: ProjectEntry; onSaved: (path: string, config: ProjectConfig | null) => void; onBack?: () => void }) {
  const [saved, setSaved] = useState<ProjectConfig | null>(entry.config);
  const [draft, setDraft] = useState<ProjectConfig>(entry.config ?? { path: entry.path, actions: [] });
  const [saving, setSaving] = useState(false);
  const { profiles } = useProfiles();
  const [globalWorktree] = useSetting("newSessionWorktree");
  const profileInfo = profiles?.find((p) => p.id === draft.profile);
  const agent = profileInfo?.agent ?? null;
  const agentModels = useAgentModels(agent ?? "claude", draft.profile ?? null);
  const name = draft.name ?? folderName(entry.path);

  const commit = async (next: ProjectConfig) => {
    setDraft(next);
    setSaving(true);
    try {
      const p = await saveProject(next);
      setSaved(p);
      setDraft(p);
      onSaved(entry.path, p);
    } catch (err) {
      toast({ key: "project-save", tone: "error", title: "Couldn't save the project", body: errorText(err) });
      setDraft(saved ?? { path: entry.path, actions: [] });
    } finally {
      setSaving(false);
    }
  };
  const set = (patch: Partial<ProjectConfig>) => void commit({ ...draft, ...patch });

  const forget = async () => {
    const old = saved;
    try {
      await forgetProject(entry.path);
      setSaved(null);
      setDraft({ path: entry.path, actions: [] });
      onSaved(entry.path, null);
      toast({ key: "project-save", tone: "success", title: `Forgot settings for ${name}`, action: old ? { label: "Undo", run: () => void commit(old) } : undefined });
    } catch (err) {
      toast({ key: "project-save", tone: "error", title: "Couldn't remove the settings", body: errorText(err) });
    }
  };

  const pickProfile = (id: string) => {
    const p = profiles?.find((x) => x.id === id);
    const next: ProjectConfig = { ...draft, profile: id || undefined, model: undefined };
    /* levels and approvals that the new agent doesn't have go back to its own default */
    if (next.effort && !(p && effortOptions(p.agent).some((o) => o.key === next.effort))) next.effort = undefined;
    if (p && next.mode && !canAsk(p.agent) && (next.mode === "default" || next.mode === "acceptEdits")) next.mode = undefined;
    void commit(next);
  };

  const profileOptions = [{ value: "", label: "No default" }, ...(profiles ?? []).filter((p) => !p.hidden && (p.installed || p.id === draft.profile)).map((p) => ({ value: p.id, label: p.label }))];
  const modelList = profileInfo ? profileModels(profileInfo, agent === "claude" ? MODELS : agentModels) : [];
  const modelOptions = [{ value: "", label: "Profile default" }, ...modelList.filter((m) => m.key).map((m) => ({ value: m.key, label: m.name }))];
  if (draft.model && !modelOptions.some((o) => o.value === draft.model)) modelOptions.push({ value: draft.model, label: draft.model });
  const modeOptions = [{ value: "", label: "No default" }, ...MODES.filter((m) => !agent || canAsk(agent) || m.key === "plan" || m.key === "bypassPermissions").map((m) => ({ value: m.key, label: m.name }))];
  const efforts = agent ? effortOptions(agent) : [];

  return (
    <>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-1">
        {onBack && (
          <button type="button" onClick={onBack} aria-label="All projects" className="icon-btn -ml-2 shrink-0">
            <NavArrowLeft width={19} height={19} strokeWidth={1.9} />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-md font-semibold tracking-[-0.01em] text-ink">{name}</h3>
          <p className="truncate text-xs text-ink-3" translate="no" title={entry.path}>
            {shortPath(entry.path)}
            {!entry.exists && " · folder not found"}
          </p>
        </div>
        {saving ? <span className="py-1.5 text-xs text-ink-3">Saving…</span> : saved && <SmallButton tone="danger" onClick={() => void forget()}>Forget</SmallButton>}
      </div>

      <Card title="Project">
        <Row label="Name" note="Shown in the Run menu and this list.">
          <TextField value={draft.name ?? ""} placeholder={folderName(entry.path)} maxLength={PROJECT_LIMITS.name} label="Project name" onCommit={(v) => v !== (draft.name ?? "") && set({ name: v || undefined })} />
        </Row>
      </Card>

      <Card title="New sessions" footer="Used when a new session starts in this folder. What you pick on the new session screen still wins.">
        <Row label="Profile" note="The agent and account to start with.">
          <Select value={draft.profile ?? ""} options={profileOptions} onChange={pickProfile} label="Default profile" />
        </Row>
        <Row label="Model" note={draft.profile ? undefined : "Choose a profile first."}>
          {draft.profile ? <Select value={draft.model ?? ""} options={modelOptions} onChange={(v) => set({ model: v || undefined })} label="Default model" /> : <span className="text-sm text-ink-3">Profile default</span>}
        </Row>
        <Row label="Approvals" note={agent && !canAsk(agent) ? "This agent can't ask here, so it runs plan-only or unattended." : undefined}>
          <Select value={draft.mode ?? ""} options={modeOptions} onChange={(v) => set({ mode: (v || undefined) as PermissionMode | undefined })} label="Default approvals" />
        </Row>
        {efforts.length > 0 && (
          <Row label="Effort">
            <Select value={draft.effort ?? ""} options={[{ value: "", label: "Profile default" }, ...efforts.map((e) => ({ value: e.key, label: e.name }))]} onChange={(v) => set({ effort: v || undefined })} label="Default effort" />
          </Row>
        )}
        <Row label="Worktree" note={draft.worktree ? (draft.worktree === "on" ? "Each new session gets its own branch and folder." : "New sessions work in this folder.") : `Follows Settings > Git (${globalWorktree ? "on" : "off"} on this device).`}>
          <Segmented
            value={draft.worktree ?? "inherit"}
            options={[
              { value: "inherit", label: "Inherit" },
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ]}
            onChange={(v) => set({ worktree: v === "inherit" ? undefined : v })}
            label="Worktree for new sessions"
          />
        </Row>
        <Row label="Branch prefix" note={`Worktree branches start with it, as in ${draft.branchPrefix ? (/[/_-]$/.test(draft.branchPrefix) ? draft.branchPrefix : `${draft.branchPrefix}/`) : DEFAULT_BRANCH_PREFIX}fix-login.`}>
          <TextField value={draft.branchPrefix ?? ""} placeholder={DEFAULT_BRANCH_PREFIX} maxLength={PROJECT_LIMITS.prefix} label="Branch prefix" mono onCommit={(v) => v !== (draft.branchPrefix ?? "") && set({ branchPrefix: v || undefined })} />
        </Row>
      </Card>

      <ActionsCard project={draft} disabled={saving} onChange={(actions) => set({ actions })} />
    </>
  );
}

/** A text box that saves on Enter or when it loses focus; Escape puts the saved value back. */
function TextField({ value, placeholder, maxLength, label, mono, onCommit }: { value: string; placeholder?: string; maxLength: number; label: string; mono?: boolean; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      type="text"
      value={text}
      placeholder={placeholder}
      maxLength={maxLength}
      aria-label={label}
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onCommit(text.trim())}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape" && text !== value) {
          e.preventDefault();
          e.stopPropagation();
          setText(value);
        }
      }}
      className={`${INPUT} sm:w-56 ${mono ? "font-mono" : ""}`}
    />
  );
}

type Editing = { index: number | null; name: string; command: string; icon: ActionIcon; error?: string };

function ActionsCard({ project, disabled, onChange }: { project: ProjectConfig; disabled: boolean; onChange: (actions: ProjectAction[]) => void }) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [seed, setSeed] = useState<ScriptSeed | null>(null);
  const [seeding, setSeeding] = useState(false);
  const actions = project.actions;
  const full = actions.length >= PROJECT_LIMITS.actions;
  const taken = (a: { name: string; command: string }) => actions.some((x) => x.command === a.command || x.name.toLowerCase() === a.name.toLowerCase());
  const fresh = (seed?.actions ?? []).filter((a) => !taken(a));

  const loadScripts = async () => {
    setSeeding(true);
    try {
      const s = await scriptsIn(project.path);
      setSeed(s);
      if (!s.actions.length) toast({ key: "project-seed", tone: "info", title: s.manager ? "No scripts in package.json" : "No package.json in this folder" });
    } catch (err) {
      toast({ key: "project-seed", tone: "error", title: "Couldn't read package.json", body: errorText(err) });
    } finally {
      setSeeding(false);
    }
  };
  const add = (list: Omit<ProjectAction, "id">[]) => onChange([...actions, ...list.slice(0, PROJECT_LIMITS.actions - actions.length).map((a) => ({ ...a, id: "" }))]);

  const saveEdit = () => {
    if (!editing) return;
    const name = editing.name.replace(/\s+/g, " ").trim();
    const command = editing.command.trim();
    if (!name || !command) return setEditing({ ...editing, error: !name ? "Give it a name." : "Enter a command." });
    if (actions.some((a, i) => i !== editing.index && a.name.toLowerCase() === name.toLowerCase())) return setEditing({ ...editing, error: `There's already an action called ${name}.` });
    const next = { id: editing.index === null ? "" : actions[editing.index].id, name, command, icon: editing.icon };
    onChange(editing.index === null ? [...actions, next] : actions.map((a, i) => (i === editing.index ? next : a)));
    setEditing(null);
  };

  const editor = editing && (
    <div className="flex flex-col gap-2.5 px-3.5 py-3">
      <div className="grid gap-2.5 sm:grid-cols-[10rem_minmax(0,1fr)]">
        <label className="flex flex-col gap-1 text-xs text-ink-3">
          Name
          <input autoFocus value={editing.name} maxLength={PROJECT_LIMITS.actionName} onChange={(e) => setEditing({ ...editing, name: e.target.value, error: undefined })} onKeyDown={(e) => e.key === "Enter" && saveEdit()} placeholder="dev" className={INPUT} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-3">
          Command
          <input
            value={editing.command}
            maxLength={PROJECT_LIMITS.command}
            onChange={(e) => setEditing({ ...editing, command: e.target.value, error: undefined })}
            onKeyDown={(e) => e.key === "Enter" && saveEdit()}
            placeholder="pnpm run dev"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className={`${INPUT} font-mono`}
          />
        </label>
      </div>
      <IconPicker value={editing.icon} onChange={(icon) => setEditing({ ...editing, icon })} />
      {editing.error && (
        <p role="alert" className="text-xs text-red-ink">
          {editing.error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <SmallButton onClick={() => setEditing(null)}>Cancel</SmallButton>
        <SmallButton tone="accent" onClick={saveEdit} disabled={disabled}>
          {editing.index === null ? "Add action" : "Save"}
        </SmallButton>
      </div>
    </div>
  );

  return (
    <section className="flex flex-col">
      <div className="flex flex-wrap items-end gap-2 px-1 pb-2">
        <h3 className="flex-1 basis-full whitespace-nowrap text-xs font-medium text-ink-3 sm:basis-0">Run actions</h3>
        <SmallButton onClick={() => void loadScripts()} disabled={seeding || full}>
          <Package width={14} height={14} strokeWidth={1.8} aria-hidden />
          {seeding ? "Reading package.json…" : "Add from package.json"}
        </SmallButton>
        <SmallButton onClick={() => setEditing({ index: null, name: "", command: "", icon: "play" })} disabled={full || editing?.index === null}>
          <Plus width={14} height={14} strokeWidth={1.9} aria-hidden />
          Add action
        </SmallButton>
      </div>
      <div className="divide-y divide-line rounded-card border border-line bg-surface">
        {seed && fresh.length > 0 && (
          <div className="flex flex-col gap-1.5 bg-field/40 px-3.5 py-3">
            <div className="flex items-center gap-2">
              <p className="flex-1 text-xs text-ink-3">
                Scripts in package.json{seed.manager ? `, run with ${seed.manager}` : ""}
              </p>
              <SmallButton onClick={() => (add(fresh), setSeed(null))} disabled={disabled || full}>
                Add all
              </SmallButton>
              <button type="button" onClick={() => setSeed(null)} aria-label="Close scripts" className="tap relative grid size-7 place-items-center rounded-control text-ink-3 hover:bg-hover hover:text-ink">
                <Xmark width={14} height={14} strokeWidth={1.9} />
              </button>
            </div>
            <ul className="flex flex-col">
              {fresh.map((a) => (
                <li key={a.name} className="flex min-h-9 items-center gap-2.5">
                  <ActionGlyph icon={a.icon} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink">{a.name}</span>
                    <span className="block truncate font-mono text-2xs text-ink-3" translate="no">
                      {a.command}
                    </span>
                  </span>
                  <SmallButton onClick={() => add([a])} disabled={disabled || full}>
                    Add
                  </SmallButton>
                </li>
              ))}
            </ul>
          </div>
        )}
        {actions.map((a, i) =>
          editing?.index === i ? (
            <div key={a.id || i}>{editor}</div>
          ) : (
            <ActionRow key={a.id || i} action={a} disabled={disabled} onEdit={() => setEditing({ index: i, name: a.name, command: a.command, icon: a.icon })} onRemove={() => onChange(actions.filter((_, j) => j !== i))} />
          ),
        )}
        {editing?.index === null && editor}
        {!actions.length && editing === null && !(seed && fresh.length) && <p className="px-3.5 py-3 text-sm text-ink-3">No actions yet. They show in the Run menu of sessions in this folder and open in a terminal.</p>}
      </div>
      {full && <p className="px-1 pt-2 text-xs text-ink-3">That&apos;s the most a project can have ({PROJECT_LIMITS.actions}).</p>}
    </section>
  );
}

function ActionGlyph({ icon }: { icon: ActionIcon }) {
  const I = ACTION_ICON[icon];
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-control bg-field text-ink-2" aria-hidden>
      <I width={15} height={15} strokeWidth={1.8} />
    </span>
  );
}

function ActionRow({ action, disabled, onEdit, onRemove }: { action: ProjectAction; disabled: boolean; onEdit: () => void; onRemove: () => void }): ReactNode {
  return (
    <div className="flex min-h-12 items-center gap-3 px-3.5 py-2">
      <ActionGlyph icon={action.icon} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-ink">{action.name}</p>
        <p className="truncate font-mono text-xs text-ink-3" translate="no" title={action.command}>
          {action.command}
        </p>
      </div>
      <button type="button" onClick={onEdit} disabled={disabled} aria-label={`Edit ${action.name}`} data-tip="Edit" data-tip-pos="bottom" className="tap relative grid size-8 shrink-0 place-items-center rounded-control text-ink-3 hover:bg-hover hover:text-ink disabled:opacity-50">
        <EditPencil width={15} height={15} strokeWidth={1.8} />
      </button>
      <button type="button" onClick={onRemove} disabled={disabled} aria-label={`Remove ${action.name}`} data-tip="Remove" data-tip-pos="bottom" className="tap relative grid size-8 shrink-0 place-items-center rounded-control text-ink-3 hover:bg-hover hover:text-red-ink disabled:opacity-50">
        <Trash width={15} height={15} strokeWidth={1.8} />
      </button>
    </div>
  );
}

function IconPicker({ value, onChange }: { value: ActionIcon; onChange: (v: ActionIcon) => void }) {
  return (
    <div role="radiogroup" aria-label="Icon" className="flex flex-wrap items-center gap-1">
      <span className="mr-1 text-xs text-ink-3">Icon</span>
      {ACTION_ICONS.map((k) => {
        const I = ACTION_ICON[k];
        const on = k === value;
        return (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={ACTION_ICON_LABEL[k]}
            data-tip={ACTION_ICON_LABEL[k]}
            data-tip-pos="bottom"
            onClick={() => onChange(k)}
            className={`tap relative grid size-8 place-items-center rounded-control transition-colors duration-150 ${on ? "bg-surface text-ink shadow-btn" : "text-ink-3 hover:bg-hover hover:text-ink"}`}
          >
            <I width={15} height={15} strokeWidth={1.8} />
          </button>
        );
      })}
    </div>
  );
}
