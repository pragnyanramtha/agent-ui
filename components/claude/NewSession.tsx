"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Check, Clock, Menu } from "iconoir-react";
import { AGENT_LABEL, type AgentId, type PermissionMode, type SessionSummary } from "@/lib/types";
import { api, ApiError, timeAgo } from "@/lib/client/api";
import { profileModels, useAgentModels, profilesFor, useProfiles } from "@/lib/client/useProfiles";
import { newClientId } from "@/lib/client/send";
import { openServerTerminal } from "@/lib/client/terminals";
import { saveEffort } from "@/lib/client/storage";
import { useDefaultEffort } from "@/lib/client/settings";
import { Composer, MODELS, type AgentOption } from "./Composer";
import { FolderPicker } from "./FolderPicker";
import { Pulse } from "./Pulse";
import { isBusy } from "./SessionList";

/* The new-session screen: one question, one composer, and a few quiet rows
 * for picking up where you left off. Staggered blur-up reveal on entry. */
const REVEAL = { offsetY: 16, blur: 12, duration: 700, easing: "cubic-bezier(0.16, 1, 0.3, 1)" };
const reveal = (visible: boolean): CSSProperties => ({
  opacity: visible ? 1 : 0,
  transform: visible ? "translate3d(0,0,0)" : `translate3d(0,${REVEAL.offsetY}px,0)`,
  filter: visible ? "blur(0px)" : `blur(${REVEAL.blur}px)`,
  transition: ["opacity", "transform", "filter"].map((p) => `${p} ${REVEAL.duration}ms ${REVEAL.easing}`).join(", "),
});

const isLive = (s: SessionSummary) => Boolean(s.terminal) || (s.web !== null && s.web.status !== "closed");

export function NewSession({
  projects,
  sessions,
  onMenu,
  onOpen,
  extra,
}: {
  projects: string[];
  sessions: SessionSummary[] | null;
  onMenu: () => void;
  onOpen: (id: string) => void;
  /** trailing header control (the phone tab switcher) */
  extra?: ReactNode;
}) {
  const [stage, setStage] = useState(0);
  const [cwd, setCwd] = useState("");
  const [mode, setMode] = useState<PermissionMode>("default");
  const [model, setModel] = useState("");
  /* "" for the default (the profile's, else the agent's own) */
  const [effort, setEffort] = useState("");
  const [agent, setAgent] = useState<AgentId>("claude");
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [picker, setPicker] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [folderInvalid, setFolderInvalid] = useState(false);
  const [profile, setProfile] = useState<string>("claude");
  const [launching, setLaunching] = useState(false);
  const { profiles } = useProfiles();
  const [now, setNow] = useState(0);
  /* once the user picks a folder, never refill it behind their back */
  const touched = useRef(false);

  useEffect(() => {
    const saved = localStorage.getItem("cui:newAgent") as AgentId | null;
    if (saved && saved in AGENT_LABEL) {
      setAgent(saved);
      if (saved !== "claude") setMode("bypassPermissions");
    }
    api<{ agents: AgentOption[] }>("/api/agents")
      .then((d) => {
        setAgents(d.agents);
        /* the saved agent was uninstalled: fall back to Claude */
        if (saved && saved !== "claude" && !d.agents.some((a) => a.id === saved && a.installed)) pickAgent("claude");
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* the profile last used for each agent */
  useEffect(() => {
    const saved = localStorage.getItem(`cui:newProfile:${agent}`);
    const list = profilesFor(profiles, agent);
    setProfile(saved && list.some((p) => p.id === saved && p.installed) ? saved : agent);
  }, [agent, profiles]);
  const pickProfile = (id: string) => {
    setProfile(id);
    setModel("");
    localStorage.setItem(`cui:newProfile:${agent}`, id);
  };
  const profileInfo = profiles?.find((p) => p.id === profile);
  const settingsEffort = useDefaultEffort(agent);
  const sentEffort = effort || profileInfo?.defaultEffort || settingsEffort || "";
  const agentModels = useAgentModels(agent, profile);

  const pickAgent = (a: AgentId) => {
    setAgent(a);
    setModel("");
    setEffort("");
    /* other agents can't show approval prompts from their print modes yet: run them unattended */
    setMode(a === "claude" ? "default" : "bypassPermissions");
    localStorage.setItem("cui:newAgent", a);
  };
  const name = AGENT_LABEL[agent];

  useEffect(() => {
    setNow(Date.now());
    if (!touched.current) setCwd((c) => c || localStorage.getItem("cui:lastCwd") || "");
    /* reduced motion: show everything at once, no blur-up */
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setStage(3);
      return;
    }
    const timers = [120, 260, 420].map((t, i) => setTimeout(() => setStage(i + 1), t));
    return () => timers.forEach(clearTimeout);
  }, []);

  /* prefill once with the most recent project */
  const prefilled = useRef(false);
  useEffect(() => {
    if (prefilled.current || touched.current || !projects[0]) return;
    prefilled.current = true;
    setCwd((c) => c || projects[0]);
  }, [projects]);

  const chooseFolder = (p: string) => {
    touched.current = true;
    setCwd(p);
    setFolderInvalid(false);
    setError(null);
    localStorage.setItem("cui:lastCwd", p);
  };

  /* live sessions first, then the most recent ones */
  const all = sessions ?? [];
  const rows = [...all.filter(isLive), ...all.filter((s) => !isLive(s))].slice(0, 3);

  const [worktree, setWorktree] = useState(false);
  useEffect(() => {
    try {
      setWorktree(localStorage.getItem("cui:worktree") === "1");
    } catch {}
  }, []);

  const start = async (text: string) => {
    setError(null);
    if (!cwd.trim()) {
      setFolderInvalid(true);
      setError("Choose a folder.");
      setPicker(true);
      return false;
    }
    try {
      const { id } = await api<{ id: string }>("/api/sessions", { agent, profile, cwd: cwd.trim(), text, model: model || undefined, effort: sentEffort, permissionMode: mode, worktree, clientId: newClientId() });
      localStorage.setItem("cui:lastCwd", cwd.trim());
      saveEffort(id, effort);
      onOpen(id);
      return true;
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Couldn't start the session.";
      if (/^(Folder not found|Choose a folder)/.test(msg)) setFolderInvalid(true);
      setError(msg);
      return false;
    }
  };

  /* the agent's own TUI in a terminal the server keeps, for work that needs it */
  const startInTerminal = async () => {
    setError(null);
    if (!cwd.trim()) {
      setFolderInvalid(true);
      setError("Choose a folder.");
      setPicker(true);
      return;
    }
    setLaunching(true);
    try {
      const t = await api<{ id: string; backing: string; label: string }>("/api/terminals", { profile, cwd: cwd.trim(), model: model || undefined, effort: sentEffort });
      localStorage.setItem("cui:lastCwd", cwd.trim());
      openServerTerminal(t, `${t.label} in ${cwd.trim().split("/").pop()}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't open the terminal.");
    } finally {
      setLaunching(false);
    }
  };

  return (
    <section className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="safe-top flex shrink-0 items-center px-[max(0.375rem,env(safe-area-inset-left))] lg:hidden">
        <div className="flex h-14 w-full items-center gap-1 pr-[max(0.375rem,env(safe-area-inset-right))]">
          <button type="button" onClick={onMenu} aria-label="Open sessions" aria-haspopup="dialog" data-drawer-opener className="flex size-10 items-center justify-center rounded-[10px] text-ink-2 hover:bg-hover hover:text-ink">
            <Menu width={19} height={19} strokeWidth={1.8} />
          </button>
          <span className="min-w-0 flex-1 truncate px-1 text-[14.5px] font-semibold tracking-[-0.01em] text-ink">New session</span>
          {extra}
        </div>
      </header>

      <div className="safe-x safe-bottom min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex min-h-full w-full max-w-(--thread-w) flex-col px-3 pb-3 sm:justify-center sm:px-8 sm:pt-8 sm:pb-[14vh]">
          {/* phones: the question sits in the middle, the composer at the bottom (where the reply composer lives) */}
          <div className="order-1 flex flex-1 flex-col justify-center py-8 sm:flex-none sm:py-0">
            <h1 className="home-reveal text-center text-[24px] leading-8 font-normal tracking-[-0.02em] text-ink sm:text-[28px] sm:leading-9" style={reveal(stage >= 1)}>
              New session
            </h1>
          </div>

          <div className="home-reveal relative z-10 order-3 sm:order-2 sm:mt-7" style={reveal(stage >= 2)}>
            <Composer
              draftKey="new"
              placeholder={`Message ${name}…`}
              onSend={start}
              running={false}
              slashCommands={[]}
              mode={mode}
              onModeChange={setMode}
              model={model || null}
              onModelChange={setModel}
              models={profileModels(profileInfo, agent === "claude" ? MODELS : agentModels)}
              cwd={agent === "claude" ? cwd.trim() || undefined : undefined}
              profiles={profiles ?? undefined}
              profile={profile}
              onProfileChange={pickProfile}
              root={cwd.trim() || undefined}
              effort={effort}
              defaultEffort={profileInfo?.defaultEffort ?? null}
              onEffortChange={setEffort}
              agents={agents}
              agent={agent}
              onAgentChange={pickAgent}
              folder={cwd}
              onPickFolder={() => setPicker(true)}
              folderInvalid={folderInvalid}
              busyLabel={`Starting ${name}…`}
              autoFocus
              context={
                <button
                  type="button"
                  aria-pressed={worktree}
                  onClick={() => {
                    setWorktree((v) => !v);
                    try {
                      localStorage.setItem("cui:worktree", worktree ? "0" : "1");
                    } catch {}
                  }}
                  title="New branch in a separate folder"
                  className={`tap relative inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1 transition-colors duration-150 ${worktree ? "text-ink" : "text-ink-3 hover:text-ink"}`}
                >
                  <span aria-hidden className={`flex size-3.5 items-center justify-center rounded-[4px] border ${worktree ? "border-ink bg-ink text-surface" : "border-line-strong"}`}>
                    {worktree && <Check width={10} height={10} strokeWidth={3} />}
                  </span>
                  New worktree
                </button>
              }
              contextEnd={
                <button
                  type="button"
                  onClick={startInTerminal}
                  disabled={launching}
                  className="tap relative inline-flex h-6 shrink-0 items-center rounded-md px-1 text-ink-3 transition-colors duration-150 hover:text-ink disabled:opacity-60"
                >
                  {launching ? `Opening ${profileInfo?.label ?? name}…` : "Open in terminal"}
                </button>
              }
            />
            {error && (
              <p role="alert" className="px-4 pt-2.5 text-[13px] text-red-ink" style={{ animation: "fade-up 240ms cubic-bezier(0.23,1,0.32,1) both" }}>
                {error}
              </p>
            )}
          </div>

          {rows.length > 0 && (
            <nav aria-label="Recent sessions" className="home-reveal order-2 mb-3 sm:order-3 sm:mt-5 sm:mb-0" style={reveal(stage >= 3)}>
              <ul className="flex flex-col">
                {rows.map((s) => {
                  const live = isLive(s);
                  const waiting = (s.web?.pending.length ?? 0) > 0;
                  return (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => onOpen(s.id)}
                        title={s.cwd ? `${s.title}\n${s.cwd}` : s.title}
                        className="group flex min-h-11 w-full min-w-0 items-center gap-3 rounded-[10px] px-4 text-left transition-colors duration-150 hover:bg-hover focus-visible:bg-hover sm:min-h-10"
                      >
                        <span className="flex w-4 shrink-0 items-center justify-center text-ink-3" aria-hidden>
                          {live ? <Pulse busy={isBusy(s)} cellClass={waiting ? "bg-orange" : "bg-ink"} /> : <Clock width={15} height={15} strokeWidth={1.8} />}
                        </span>
                        <span className="flex min-w-0 flex-1 items-baseline gap-2">
                          <span className="min-w-0 truncate text-[14px] text-ink-2 transition-colors duration-150 group-hover:text-ink">{s.title}</span>
                          <span className="hidden min-w-0 max-w-[40%] shrink-0 truncate text-[13px] text-ink-3 min-[420px]:inline" translate="no">
                            {[s.project, s.agent !== "claude" ? AGENT_LABEL[s.agent] : null].filter(Boolean).join(" · ")}
                          </span>
                        </span>
                        <span className="shrink-0 text-[12px] text-ink-3">
                          {waiting ? <span className="text-orange-ink">Needs you</span> : live ? "Open" : now ? timeAgo(s.mtime, now) : null}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </nav>
          )}
        </div>
      </div>

      <FolderPicker open={picker} value={cwd} recent={projects} onPick={chooseFolder} onClose={() => setPicker(false)} />
    </section>
  );
}
