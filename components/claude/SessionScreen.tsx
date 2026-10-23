"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowRight, ChatBubbleEmpty, ChatBubbleWarning, Download, Folder, FolderWarning, GitBranch, GitCompare, List, Menu, MoreHoriz, Page, StatsReport, Terminal, Xmark } from "iconoir-react";
import { AGENT_LABEL, type AgentId, type Entry, type PermissionMode, type ServerTerminal } from "@/lib/types";
import { AGENT_TONE, AgentMark } from "./SessionList";
import { OPEN_CHANGES_EVENT, OPEN_TERMINAL_EVENT } from "@/lib/client/events";
import { api, ApiError, shortPath } from "@/lib/client/api";
import { setBaseTitle } from "@/lib/client/attention";
import { appendToDraft, fillTextarea, INSERT_INTO_COMPOSER_EVENT, type InsertIntoComposer } from "@/lib/client/composer-insert";
import { carryOver, loadEffort, saveEffort } from "@/lib/client/storage";
import { effortFromCommand, effortOptions } from "@/lib/agent-traits";
import { serverId, useSession } from "@/lib/client/useSession";
import { answerAsk, failureText, postReliably, transient, type Answer } from "@/lib/client/send";
import { openServerTerminal } from "@/lib/client/terminals";
import { profileModels, useAgentModels, useProfiles } from "@/lib/client/useProfiles";
import { confirmAsk } from "./Ask";
import { useGitInfo } from "@/lib/client/useGitInfo";
import { AskCards, FilesPanel, GitPanel, HandoffDialog, QuickOpen, TerminalPeek, UsagePanel } from "./lazy";
import { OPEN_FILES_EVENT } from "@/lib/client/events";
import { useFilesPanel } from "./useFilesPanel";
import { FileRoot } from "./FileLink";
import { ReviewPill } from "./ReviewPill";
import { takeReview } from "@/lib/client/review-store";
import { withReviewBlock } from "@/lib/client/review";
import { toast } from "@/lib/client/toast";
import { runFailed, terminalBusy } from "@/lib/status";
import { Composer, MODELS } from "./Composer";
import { MODE_ALIASES } from "@/lib/commands";
import { ChangesPanel, collectChanges } from "./ChangesPanel";
import { OPEN_USAGE_EVENT } from "./ContextRing";
import { sessionCost } from "@/lib/client/usage";
import { PendingBubble } from "./PendingBubble";
import { Pulse } from "./Pulse";
import { Thread } from "./Thread";
import { PromptTimeline } from "./PromptTimeline";
import { PanelSlot } from "./PanelSlot";
import { FindBar } from "./FindBar";
import { RunMenu } from "./RunMenu";
import { isCommand } from "@/lib/client/shortcuts";
import { useDefaultEffort, useSetting } from "@/lib/client/settings";
import { useFolderGone } from "@/lib/client/useFolderGone";
import { FOLDER_GONE, folderGoneCopy } from "@/lib/empty-states";
import { EmptyState } from "@/components/primitives/EmptyState";
import { TaskPill } from "./TaskPill";
import { latestTasks, showTasks } from "@/lib/client/tasks";
import { summarizeTool } from "@/lib/client/tools";
import type { PendingAsk } from "@/lib/types";
import { useSessionPalette } from "./useSessionCommands";
import { chipModel } from "@/lib/model-chip";
import { useAutoOpenDiff } from "@/lib/client/useAutoOpenDiff";
import { useEditorLink } from "@/lib/client/useEditorLink";
import { OpenNewWindow } from "iconoir-react";
import { useComposerCollapse } from "@/lib/client/useComposerCollapse";
import { ComposerPill } from "./ComposerPill";
import { useBranching } from "./useBranching";

function useMeasure<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [h, setH] = useState(140);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, h] as const;
}

const OFFLINE = "Couldn't reach the server.";
const SEGMENT =
  "relative flex h-full shrink-0 items-center gap-1.5 rounded-[6px] px-2 text-sm font-medium text-ink-2 transition-colors duration-100 hover:bg-hover hover:text-ink aria-pressed:bg-hover aria-pressed:text-ink disabled:opacity-60 pointer-coarse:px-2.5";
type Panel = "changes" | "git" | "usage" | "files";
const PANEL_KEY = "cui:panel";

/** the composer chip while a denial note is written: "Denying Bash · npm test" */
function noteLabel(ask: Extract<PendingAsk, { kind: "permission" }>) {
  const s = summarizeTool(ask.toolName, ask.input ?? {});
  return `Denying ${ask.toolName}${s.verb === ask.toolName || !s.chip ? "" : ` · ${s.chip}`}`;
}

/** the kind of the last thing said in the thread (usage and notices aside) */
function lastSaid(entries: Entry[]) {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i].kind !== "usage" && entries[i].kind !== "notice") return entries[i].kind;
  return null;
}

export function SessionScreen({
  id,
  onMenu,
  onNavigate,
  onOpen,
  onNew,
  extra,
}: {
  id: string;
  onMenu: () => void;
  onNavigate: (id: string) => void;
  /** opens a session in a tab of its own */
  onOpen: (id: string) => void;
  onNew: () => void;
  /** trailing header control (the phone tab switcher) */
  extra?: ReactNode;
}) {
  const { view, loadOlder, addPending, updatePending, dropPending } = useSession(id, onNavigate);
  const [localMode, setLocalMode] = useState<PermissionMode | null>(null);
  const [localModel, setLocalModel] = useState<string | null>(null);
  const [localProfile, setLocalProfile] = useState<string | null>(null);
  /* the effort picked for this session ("" for the default), remembered on this device */
  const [localEffort, setLocalEffort] = useState("");
  useEffect(() => setLocalEffort(loadEffort(id) ?? ""), [id]);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [launching, setLaunching] = useState(false);
  const { profiles } = useProfiles();
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [peek, setPeek] = useState(false);
  const [jumpOpen, setJumpOpen] = useState(false);
  const closeJump = useCallback(() => setJumpOpen(false), []);
  const [panel, setPanel] = useState<Panel | null>(null);
  const openFilesPanel = useCallback(() => {
    setPanel("files");
    try {
      localStorage.setItem(PANEL_KEY, "files");
    } catch {}
  }, []);
  const filesPanel = useFilesPanel(view.cwd || "", openFilesPanel);
  const togglePanel = useCallback((p: Panel) => {
    setPanel((cur) => (cur === p ? null : p));
    try {
      localStorage.setItem(PANEL_KEY, p);
    } catch {}
  }, []);
  useEffect(() => {
    const open = () => setPanel("usage");
    window.addEventListener(OPEN_USAGE_EVENT, open);
    return () => window.removeEventListener(OPEN_USAGE_EVENT, open);
  }, []);
  /* a file in a turn's changed files: the Changes panel, at that file */
  const [changesFocus, setChangesFocus] = useState<{ path: string | null; n: number }>({ path: null, n: 0 });
  useEffect(() => {
    const open = (e: Event) => {
      setChangesFocus((f) => ({ path: (e as CustomEvent<{ path?: string }>).detail?.path ?? null, n: f.n + 1 }));
      setPanel("changes");
    };
    window.addEventListener(OPEN_CHANGES_EVENT, open);
    return () => window.removeEventListener(OPEN_CHANGES_EVENT, open);
  }, []);
  /* which panels have something to show; read at key time */
  const available = useRef({ changes: false, git: false, files: false });
  /* Mod+Alt+B shows or hides the side panel (the last one used), like VS Code's secondary sidebar */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      /* AltGr arrives as Ctrl+Alt on Windows and Linux layouts; the matcher treats it as text */
      if (!isCommand(e, "sidePanel")) return;
      e.preventDefault();
      setPanel((cur) => {
        if (cur) return null;
        let last: string | null = null;
        try {
          last = localStorage.getItem(PANEL_KEY);
        } catch {}
        const ok = (p: string | null): p is Panel =>
          p === "usage" || (p === "files" && available.current.files) || (p === "changes" && available.current.changes) || (p === "git" && available.current.git);
        return ok(last) ? last : ok("files") ? "files" : ok("changes") ? "changes" : "usage";
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const changesOpen = panel === "changes";
  const usageOpen = panel === "usage";
  const gitOpen = panel === "git";
  const filesOpen = panel === "files";
  const [composerRef, composerH] = useMeasure<HTMLDivElement>();
  useEffect(() => {
    const take = (e: Event) => {
      const text = (e as CustomEvent<InsertIntoComposer>).detail?.text;
      const box = composerRef.current?.querySelector("textarea");
      if (!text || !box) return;
      e.preventDefault();
      fillTextarea(box, appendToDraft(box.value, text));
    };
    window.addEventListener(INSERT_INTO_COMPOSER_EVENT, take);
    return () => window.removeEventListener(INSERT_INTO_COMPOSER_EVENT, take);
  }, [composerRef]);
  const menuRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  const agent: AgentId = id.includes(":") ? (id.slice(0, id.indexOf(":")) as AgentId) : "claude";
  const run = view.run && view.run.status !== "closed" ? view.run : null;
  /* a failed run stays on screen (its error, its last state) but can't take mode/model/stop changes; the next send starts fresh */
  const live = run && run.status !== "error" ? run : null;
  const terminal = view.terminal;
  const busy = run ? run.status === "running" || run.status === "starting" : terminalBusy(terminal?.status);
  /* most other agents' print modes can't ask for approval on the web (Codex can), so like new sessions they default to Bypass */
  const mode = live?.permissionMode ?? localMode ?? run?.permissionMode ?? view.permissionMode ?? (agent === "claude" ? "default" : "bypassPermissions");
  const lastModel = useMemo(() => {
    for (let i = view.entries.length - 1; i >= 0; i--) {
      const e = view.entries[i];
      if (e.kind === "usage" && e.model && !e.model.startsWith("<")) return e.model;
    }
    return null;
  }, [view.entries]);
  const model = localModel ?? run?.model ?? lastModel;
  /* a Claude TUI in zellij/tmux the server can type into */
  const typesInto = agent === "claude" && !live && /^(zellij|tmux)/.test(terminal?.multiplexer ?? "");
  const where = terminal ? (terminal.headless ? "another program" : (terminal.multiplexer ?? "a terminal")) : null;
  const agentName = AGENT_LABEL[agent];
  const profileId = localProfile ?? view.profile ?? agent;
  const profileInfo = profiles?.find((p) => p.id === profileId);
  const agentModels = useAgentModels(agent, profileId);
  /* the session's own, else the profile's default, else the one in Settings > Composer; while the profiles load
   * nothing is sent, so the server applies the profile's default instead of Settings overriding it */
  const settingsEffort = useDefaultEffort(agent);
  const fallbackEffort = profiles ? profileInfo?.defaultEffort || settingsEffort || "" : "";
  const effort = localEffort || fallbackEffort;
  const runsOn = profileInfo && profileInfo.id !== agent ? profileInfo.label : agent !== "claude" ? agentName : null;
  const changes = useMemo(() => collectChanges(view.entries, view.results), [view.entries, view.results]);
  available.current = { changes: changes.length > 0, git: Boolean(view.cwd), files: Boolean(view.cwd) };
  useAutoOpenDiff(id, Boolean(busy && run), changes, () => setPanel((p) => p ?? "changes"));
  const editorLink = useEditorLink();
  const cost = useMemo(() => sessionCost(view.entries, view.run), [view.entries, view.run]);
  const turns = useMemo(() => view.entries.filter((e) => e.kind === "user").length, [view.entries]);
  const [gitRev, setGitRev] = useState(0);
  const project = view.cwd.split("/").filter(Boolean).pop() ?? "";
  const folder = useFolderGone(view.status === "missing" ? "" : view.cwd);
  /* a busy Claude web turn can be handed over to a terminal (openInteractive asks first) */
  const showTerminal = view.status !== "missing" && Boolean(terminal || !busy || agent === "claude");
  const git = useGitInfo(id, `${busy ? "busy" : "idle"}:${turns}:${gitRev}`);
  const branching = useBranching({
    id,
    agent,
    entries: view.entries,
    git,
    busy: Boolean(busy),
    ready: view.status !== "missing" && view.status !== "connecting" && Boolean(view.cwd),
    mode,
    model,
    profile: profileId,
    effort,
    onNavigate,
    onOpen,
  });
  const usage = useMemo(() => {
    for (let i = view.entries.length - 1; i >= 0; i--) {
      const e = view.entries[i];
      if (e.kind === "usage") return e;
    }
    return null;
  }, [view.entries]);

  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    const inside = (t: EventTarget | null) => t instanceof Element && Boolean(t.closest("[data-session-menu]"));
    const close = (e: PointerEvent) => !inside(e.target) && setMenuOpen(false);
    const onFocus = (e: FocusEvent) => !inside(e.target) && setMenuOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("focusin", onFocus);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("focusin", onFocus);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(t);
  }, [error]);

  /* a failed run stays on screen (with Retry and Continue in) until dismissed or the next turn starts */
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const planReady =
    mode === "plan" &&
    !busy &&
    !run?.pending.length &&
    !view.pending.length &&
    lastSaid(view.entries) === "text";
  const failed = runFailed(run) && run?.error && run.error !== dismissedError ? run.error : null;
  const sentTexts = useMemo(() => view.entries.flatMap((e) => (e.kind === "user" && e.text.trim() ? [e.text] : [])).slice(-50), [view.entries]);
  const lastUserText = sentTexts.at(-1) ?? null;
  const fold = useComposerCollapse(sectionRef, composerRef, Boolean(failed || planReady || error));

  useEffect(() => {
    setBaseTitle(view.title ? `${view.title} · agent-u` : "agent-u");
  }, [view.title]);

  const pendingRef = useRef(view.pending);
  pendingRef.current = view.pending;
  /* read at send time, so a mode switched right before a send goes with it */
  const localModeRef = useRef(localMode);
  localModeRef.current = localMode;
  const effortRef = useRef(effort);
  effortRef.current = effort;
  /* the bubble stays until the message shows up in the transcript; failures stay visible with Retry.
   * A retry reuses the id the server last saw, so it can't send twice, unless that id was spent on a send that never ran (`fresh`) */
  const deliver = useCallback(
    async (localId: string, text: string, fresh = false, sentAs?: string) => {
      const clientId = fresh ? `${localId}-${Date.now().toString(36)}` : (sentAs ?? localId);
      let delivered: { via?: "terminal" | "web" | "queued"; clientId: string } | null = null;
      updatePending(localId, { state: "sending", error: undefined, resend: undefined, sentAs: clientId });
      try {
        const res = await postReliably<{ id: string; via?: "terminal" | "web" | "queued"; cleared?: string | null }>(
          `/api/sessions/${id}/message`,
          { text, model: localModel ?? undefined, permissionMode: localModeRef.current ?? undefined, profile: localProfile ?? undefined, effort: effortRef.current || undefined },
          clientId,
        );
        updatePending(localId, { state: "sent", via: res.via, sentAt: Date.now() });
        delivered = { via: res.via, clientId };
        /* a greyed suggestion or half-typed text was in the terminal's prompt; say what was cleared */
        if (res.cleared && !/^Try "/.test(res.cleared)) setError(`Cleared unsent text: "${res.cleared.slice(0, 80)}"`);
        if (res.id !== id) {
          carryOver(id, res.id, pendingRef.current.map((p) => (p.localId === localId ? { ...p, state: "sent", via: res.via, sentAt: Date.now(), sentAs: clientId, error: undefined, resend: undefined } : p)));
          onNavigate(res.id);
        }
      } catch (err) {
        updatePending(localId, { state: "failed", error: err instanceof ApiError && !transient(err) ? err.message : OFFLINE });
        if (err instanceof ApiError && err.code === FOLDER_GONE) void folder.check();
        /* the terminal refused the keystrokes: show it, so the reason is visible */
        if (err instanceof ApiError && ["agent_focus", "has_text", "no_prompt"].includes(err.code ?? "")) setPeek(true);
      }
      return delivered;
    },
    [id, localModel, localMode, localProfile, updatePending, onNavigate, folder.check],
  );
  /* sends that failed for want of a connection go out again once it's back */
  useEffect(() => {
    const retry = () => pendingRef.current.filter((p) => p.state === "failed" && p.error === OFFLINE).forEach((p) => void deliver(p.localId, p.text, false, p.sentAs));
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [deliver]);
  const control = useCallback(
    async (action: string, value?: string) => {
      try {
        await api(`/api/sessions/${id}/control`, { action, value });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [id],
  );

  /* Esc interrupts a terminal Claude, like pressing it at the keyboard */
  const pressKey = useCallback(
    async (key: string) => {
      try {
        await api(`/api/sessions/${id}/keys`, { key });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [id],
  );

  /* Settings > Composer: a message sent while the agent works can stop the turn first. Claude's run and
   * terminals stop, then take it; other agents queue it and send it now, like the queued bubble's Send now. */
  const [busySend] = useSetting("busySend");
  const busyRef = useRef(false);
  busyRef.current = Boolean(busy);
  const send = useCallback(
    async (text: string) => {
      const { block, dropped } = await takeReview(id, view.cwd);
      const message = withReviewBlock(text, block);
      if (dropped) {
        toast({
          title: dropped === 1 ? "1 review comment was skipped because its lines changed." : `${dropped} review comments were skipped because their lines changed.`,
          key: "review-stale",
        });
      }
      const localId = addPending(message);
      if (busySend !== "interrupt" || !busyRef.current) {
        void deliver(localId, message);
      } else if (agent === "claude" || !live) {
        if (live) await control("interrupt");
        else if (terminal) await pressKey("Escape");
        void deliver(localId, message);
      } else {
        void deliver(localId, message).then((d) => {
          if (d?.via === "queued") void control("sendQueued", d.clientId);
        });
      }
      return true;
    },
    [deliver, addPending, busySend, agent, live, terminal, control, pressKey, id, view.cwd],
  );

  /* the cards show a failure themselves and offer the answer again */
  const respond = useCallback((body: Answer) => answerAsk(id, body), [id]);

  /* "Deny with note…": the composer takes the reason. Claude hears it with the denial; the other agents'
   * approvals carry no reason, so there it follows the denial as a message */
  const [noteFor, setNoteFor] = useState<Extract<PendingAsk, { kind: "permission" }> | null>(null);
  useEffect(() => setNoteFor(null), [id]);
  const noteAsk = noteFor && run?.pending.some((p) => p.requestId === noteFor.requestId) ? noteFor : null;
  useEffect(() => {
    if (noteFor && !noteAsk) setNoteFor(null);
  }, [noteFor, noteAsk]);
  const sendNote = useCallback(
    async (text: string) => {
      if (!noteAsk) return false;
      const message = text.trim();
      try {
        await respond({ requestId: noteAsk.requestId, allow: false, ...(agent === "claude" ? { message } : {}) });
      } catch (err) {
        setError(failureText(err));
        return false;
      }
      setNoteFor(null);
      if (agent !== "claude") void send(message);
      return true;
    },
    [noteAsk, respond, agent, send],
  );
  const tasks = useMemo(() => latestTasks(view.entries), [view.entries]);

  /* status as a quiet mark + word; below 480px only the mark shows for calm states, states that need you keep the word */
  const chip = "flex h-8 shrink-0 items-center gap-1.5 px-1.5 text-sm";
  const chipLabel = "max-w-[9rem] truncate max-[479px]:sr-only";
  const loudLabel = "max-w-[9rem] truncate";
  const turnFailed = runFailed(run);
  const runLabel = run ? (run.pending.length ? "Needs you" : busy ? "Working…" : turnFailed ? "Failed" : "Ready") : "";
  const status = view.status === "reconnecting" ? (
    <span role="status" className={`${chip} text-orange-ink`} title="Reconnecting…">
      <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-current" aria-hidden />
      <span className={loudLabel}>Reconnecting…</span>
    </span>
  ) : terminal ? (
    <span className={`${chip} text-ink-3`} title="Open in a terminal">
      <Pulse busy={terminalBusy(terminal.status)} size={2.5} cellClass={AGENT_TONE[agent]} />
      <span className={chipLabel}>Terminal</span>
    </span>
  ) : run ? (
    <span role="status" className={`${chip} ${run.pending.length ? "font-medium text-orange-ink" : turnFailed && !busy ? "font-medium text-red-ink" : "text-ink-3"}`} title={run.error && turnFailed ? run.error : runLabel}>
      {run.pending.length ? (
        <span className="size-1.5 shrink-0 rounded-full bg-orange" aria-hidden />
      ) : turnFailed && !busy ? (
        <span className="size-1.5 shrink-0 rounded-full bg-red" aria-hidden />
      ) : (
        <Pulse busy={busy} size={2.5} cellClass={AGENT_TONE[agent]} />
      )}
      <span className={run.pending.length || (turnFailed && !busy) ? loudLabel : chipLabel}>{runLabel}</span>
    </span>
  ) : null;

  /* the branch for the strip under the composer, read again when a turn ends */
  const [branch, setBranch] = useState<string | null>(null);
  const idle = !busy;
  useEffect(() => setBranch(null), [id]);
  useEffect(() => {
    if (!view.cwd || !idle) return;
    let gone = false;
    api<{ repo: { branch: string | null } | null }>(`/api/git?session=${encodeURIComponent(id)}`)
      .then((d) => !gone && setBranch(d.repo?.branch ?? null))
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [id, view.cwd, idle]);
  const stripBtn = "tap relative -mx-1 flex h-6 min-w-0 items-center gap-1.5 rounded-md px-1 text-ink-3 transition-colors duration-150 hover:text-ink-2";
  const composerContext = view.cwd ? (
    <>
      <button
        type="button"
        onClick={() => filesPanel.browse()}
        title={`${view.cwd}\nBrowse files`}
        aria-label={`Folder: ${view.cwd}. Browse files`}
        className={`${stripBtn} max-w-[12rem] shrink-[2]`}
      >
        <Folder width={14} height={14} strokeWidth={1.8} className="shrink-0" aria-hidden />
        <span className="min-w-0 truncate" translate="no">
          {view.cwd.replace(/\/+$/, "").split("/").pop() || "/"}
        </span>
      </button>
      {branch && (
        <button type="button" onClick={() => togglePanel("git")} title={`Branch ${branch}\nGit and checkpoints`} aria-label={`Branch: ${branch}. Git and checkpoints`} className={`${stripBtn} max-w-[16rem]`}>
          <GitBranch width={14} height={14} strokeWidth={1.8} className="shrink-0" aria-hidden />
          <span className="min-w-0 truncate" translate="no">
            {branch}
          </span>
        </button>
      )}
    </>
  ) : null;

  /* sent with every message; a running Claude switches right away */
  const pickEffort = (e: string) => {
    setLocalEffort(e);
    saveEffort(id, e);
    effortRef.current = e || fallbackEffort;
    if (live) void control("effort", effortRef.current);
  };

  useSessionPalette({
    id,
    agent,
    agentName,
    openPanel: setPanel,
    togglePanel,
    changes: changes.length,
    hasFolder: Boolean(view.cwd),
    exportable: view.entries.length > 0,
    onHandoff: view.status === "open" ? () => setHandoffOpen(true) : null,
    onStop: busy && (run || terminal) ? () => (live ? void control("interrupt") : void pressKey("Escape")) : null,
    models: profileModels(profileInfo, agent === "claude" ? MODELS : agentModels),
    model,
    defaultModel: chipModel(null, profileInfo, usage?.model).model,
    onModel: (m) => {
      setLocalModel(m || null);
      if (live) void control("model", m);
    },
    mode,
    onMode: (m) => {
      setLocalMode(m);
      if (live) void control("mode", m);
    },
    effort: localEffort,
    defaultEffort: fallbackEffort || null,
    onEffort: pickEffort,
  });

  const closeMenu = () => {
    setMenuOpen(false);
    menuButtonRef.current?.focus();
  };
  /* attach to the terminal the session runs in, or start the agent's own TUI on it in a terminal the server keeps */
  const openInteractive = async () => {
    setPeek(false);
    const kept = await fetch("/api/terminals")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { terminals?: ServerTerminal[] } | null) => d?.terminals?.find((t) => t.session === id && t.exited === null))
      .catch(() => undefined);
    if (kept) {
      openServerTerminal(kept, `${kept.label}: ${view.title || "session"}`);
      return;
    }
    /* a headless process (Agent SDK) or a turn from the web has no screen: hand the session over to a terminal */
    let takeover = false;
    if (terminal?.headless || (!terminal && run && busy && agent === "claude")) {
      takeover = await confirmAsk(
        terminal?.headless
          ? { title: "Open this session in a terminal?", body: "Another program is running it through the Agent SDK, which has no screen. It will be stopped and the session opens in Claude's own terminal here.", confirm: "Stop it and open", danger: true }
          : { title: "Open this session in a terminal?", body: `${agentName} is working on a message from the web. That turn stops, and the session opens in a terminal where you can carry on.`, confirm: "Stop turn and open", danger: true },
      );
      if (!takeover) return;
    } else if (terminal) {
      /* only zellij and tmux can be joined from here; anything else stays where it runs */
      if (!/^(zellij|tmux)/.test(terminal.multiplexer ?? "")) {
        setError("This terminal can't be opened in the browser. Continue it there, or quit it there and open it here.");
        return;
      }
      window.dispatchEvent(new CustomEvent(OPEN_TERMINAL_EVENT, { detail: { session: agent === "claude" ? id : undefined, pid: terminal.pid, label: `${agentName}: ${view.title || "session"}` } }));
      return;
    }
    setLaunching(true);
    try {
      const t = await api<{ id: string; backing: string; label: string }>("/api/terminals", { session: id, profile: profileId, effort, takeover });
      openServerTerminal(t, `${t.label}: ${view.title || "session"}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't open the terminal.");
    } finally {
      setLaunching(false);
    }
  };

  return (
    <FileRoot.Provider value={view.cwd || null}>
    <div className="relative flex min-h-0 min-w-0 flex-1">
    <section ref={sectionRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <header data-swipe-tabs className="on-page safe-top safe-x relative z-20 flex shrink-0 touch-pan-y touch-pinch-zoom items-center bg-page">
        <div className="@container flex h-14 w-full min-w-0 items-center gap-0.5 px-1.5 sm:px-3 lg:h-[52px]">
          <button type="button" onClick={onMenu} aria-label="Open sessions" aria-haspopup="dialog" data-drawer-opener className="icon-btn lg:hidden">
            <Menu width={19} height={19} strokeWidth={1.8} />
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 text-md tracking-[-0.01em] sm:text-sm">
            {runsOn && (
              <span className="flex shrink-0 max-sm:hidden" title={runsOn}>
                <AgentMark agent={agent} />
              </span>
            )}
            {project && (
              <>
                <span className="min-w-[2.5rem] shrink-[4] truncate text-ink-3 max-sm:hidden @max-[36rem]:hidden" title={runsOn ? `${shortPath(view.cwd)} · ${runsOn}` : shortPath(view.cwd)} translate="no">
                  {project}
                </span>
                <span className="shrink-0 text-ink-3/60 max-sm:hidden @max-[36rem]:hidden" aria-hidden>
                  /
                </span>
              </>
            )}
            <h1 className="min-w-0 truncate font-medium text-ink" title={[view.title, shortPath(view.cwd)].filter(Boolean).join("\n") || undefined}>
              {view.title || (view.status === "missing" ? "Couldn't load this session" : "Loading session…")}
            </h1>
            {git?.branch && (
              <span className="inline-flex h-5 max-w-[10rem] min-w-0 shrink-[8] items-center rounded-chip bg-field px-1.5 font-mono text-xs text-ink-3 max-sm:hidden @max-[48rem]:hidden" title={`Branch ${git.branch}`} translate="no">
                <span className="truncate">{git.branch}</span>
              </span>
            )}
          </div>
          {status}
          <div role="group" aria-label="Panels" className={`mx-1 flex h-8 shrink-0 items-center gap-0.5 pointer-coarse:h-11 max-sm:mx-0 ${changes.length || showTerminal ? "" : "max-sm:hidden"}`}>
            {changes.length > 0 && (
              <button
                type="button"
                onClick={() => togglePanel("changes")}
                aria-pressed={changesOpen}
                aria-label={`Changes: ${changes.length} ${changes.length === 1 ? "file" : "files"}`}
                data-tip="Changes"
                data-tip-pos="bottom"
                className={`${SEGMENT} tabular-nums`}
              >
                <GitCompare width={16} height={16} strokeWidth={1.6} />
                <span className="max-[379px]:sr-only">{changes.length}</span>
              </button>
            )}
            {showTerminal && (
              <button
                type="button"
                onClick={() => void openInteractive()}
                disabled={launching}
                aria-label="Open in terminal"
                data-tip="Open in terminal"
                data-tip-pos="bottom"
                className={SEGMENT}
              >
                <Terminal width={16} height={16} strokeWidth={1.6} />
                <span className="max-sm:sr-only @max-[44rem]:sr-only">{launching ? "Opening…" : "Terminal"}</span>
              </button>
            )}
            {view.cwd && <RunMenu cwd={view.cwd} className={SEGMENT} />}
            {view.cwd && (
              <button
                type="button"
                onClick={() => (filesOpen ? togglePanel("files") : filesPanel.browse())}
                aria-pressed={filesOpen}
                aria-label="Browse files"
                data-tip="Files"
                data-tip-pos="bottom"
                className={SEGMENT}
              >
                <Page width={16} height={16} strokeWidth={1.6} />
              </button>
            )}
            {view.cwd && (
              <button
                type="button"
                onClick={() => togglePanel("git")}
                aria-pressed={gitOpen}
                aria-label="Git and checkpoints"
                data-tip="Git"
                data-tip-pos="bottom"
                className={`${SEGMENT} max-sm:hidden`}
              >
                <GitBranch width={16} height={16} strokeWidth={1.6} />
              </button>
            )}
            <button
              type="button"
              onClick={() => togglePanel("usage")}
              aria-pressed={usageOpen}
              aria-label="Usage and cost"
              data-tip="Usage"
              data-tip-pos="bottom"
              className={`${SEGMENT} max-sm:hidden`}
            >
              <StatsReport width={16} height={16} strokeWidth={1.6} />
            </button>
          </div>
          <div className="relative shrink-0" data-session-menu>
            <button
              ref={menuButtonRef}
              type="button"
              aria-label="Session options"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              data-tip="Options"
              data-tip-pos="bottom-end"
              onClick={() => setMenuOpen((v) => !v)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" && !menuOpen) {
                  e.preventDefault();
                  setMenuOpen(true);
                }
              }}
              className="icon-btn pointer-fine:size-8"
            >
              <MoreHoriz width={17} height={17} strokeWidth={1.6} />
            </button>
            {menuOpen && (
              <div
                ref={menuRef}
                role="menu"
                aria-label="Session options"
                onKeyDown={(e) => {
                  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
                  e.preventDefault();
                  const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
                  const i = items.indexOf(document.activeElement as HTMLElement);
                  items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
                }}
                className="absolute top-full right-0 z-30 mt-1 w-64 max-w-[calc(100vw-1rem)] rounded-[12px] bg-surface p-1 shadow-overlay"
                style={{ animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "top right" }}
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    closeMenu();
                    setPanel("usage");
                  }}
                  className="menu-item"
                >
                  <StatsReport width={15} height={15} strokeWidth={1.8} className="shrink-0 text-ink-3" aria-hidden />
                  Usage and cost
                </button>
                {lastUserText && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      closeMenu();
                      setJumpOpen(true);
                    }}
                    className="menu-item"
                  >
                    <List width={15} height={15} strokeWidth={1.8} className="shrink-0 text-ink-3" aria-hidden />
                    Jump to prompt…
                  </button>
                )}
                {view.cwd && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      closeMenu();
                      setPanel("git");
                    }}
                    className="menu-item"
                  >
                    <GitBranch width={15} height={15} strokeWidth={1.8} className="shrink-0 text-ink-3" aria-hidden />
                    Git and checkpoints
                  </button>
                )}
                {terminal && !run && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      closeMenu();
                      setPeek((v) => !v);
                    }}
                    className="menu-item"
                  >
                    <Terminal width={15} height={15} strokeWidth={1.8} className="shrink-0 text-ink-3" aria-hidden />
                    {peek ? "Hide terminal preview" : "Preview terminal"}
                  </button>
                )}
                {view.cwd && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      window.dispatchEvent(new CustomEvent(OPEN_TERMINAL_EVENT, { detail: { cwd: view.cwd, label: `Shell: ${shortPath(view.cwd)}` } }));
                    }}
                    className="menu-item"
                  >
                    <Terminal width={15} height={15} strokeWidth={1.8} className="shrink-0 text-ink-3" aria-hidden />
                    Open shell
                  </button>
                )}
                {view.cwd && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      window.dispatchEvent(new CustomEvent(OPEN_FILES_EVENT, { detail: { path: view.cwd } }));
                    }}
                    className="menu-item"
                  >
                    <Folder width={15} height={15} strokeWidth={1.8} className="shrink-0 text-ink-3" aria-hidden />
                    Browse files here
                  </button>
                )}
                {view.cwd && editorLink?.href(view.cwd) && (
                  <a role="menuitem" href={editorLink.href(view.cwd)!} onClick={() => setTimeout(closeMenu)} className="menu-item pointer-coarse:hidden">
                    <OpenNewWindow width={15} height={15} strokeWidth={1.8} className="shrink-0 text-ink-3" aria-hidden />
                    {editorLink.label}
                  </a>
                )}
                {view.status === "open" && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      closeMenu();
                      setHandoffOpen(true);
                    }}
                    className="menu-item items-start"
                  >
                    <ArrowRight width={15} height={15} strokeWidth={1.8} className="mt-0.5 shrink-0 text-ink-3" aria-hidden />
                    <span>Continue in another agent…</span>
                  </button>
                )}
                {view.entries.length > 0 &&
                  (["md", "json"] as const).map((format) => (
                    <a
                      key={format}
                      role="menuitem"
                      href={`/api/sessions/${id}/export?format=${format}`}
                      download
                      onClick={() => setTimeout(closeMenu)}
                      className="menu-item"
                    >
                      <Download width={15} height={15} strokeWidth={1.8} className="shrink-0 text-ink-3" aria-hidden />
                      {format === "md" ? "Download as Markdown" : "Download JSON"}
                    </a>
                  ))}
                {run && (
                  <>
                    <div className="mx-2 my-1 h-px bg-line" />
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        closeMenu();
                        void control("stop");
                      }}
                      className="menu-item items-start"
                    >
                      <Xmark width={15} height={15} strokeWidth={1.8} className="mt-0.5 shrink-0 text-ink-3" aria-hidden />
                      <span className="flex min-w-0 flex-col">
                        <span>End session</span>
                        <span className="text-xs text-ink-3">Stops the agent. History stays.</span>
                      </span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          {extra}
        </div>
        <div className="pointer-events-none absolute inset-x-0 top-full h-3 bg-gradient-to-b from-page to-transparent" aria-hidden />
        <FindBar scope={sectionRef} />
      </header>
      {peek && terminal && !run && <TerminalPeek id={id} pid={terminal.pid} where={`${agentName}: ${view.title || "session"}`} onClose={() => setPeek(false)} />}

      <Thread
        view={view}
        busy={Boolean(busy)}
        agentName={agentName}
        workingLabel={agent === "claude" && run ? "Thinking" : "Working"}
        onLoadOlder={() => void loadOlder()}
        pendingSlot={(p) => (
          <PendingBubble
            pending={p}
            where={where}
            agentName={agentName}
            claudeBusy={Boolean(busy)}
            queued={p.via === "queued" && view.queue.includes(serverId(p))}
            onRetry={() => void deliver(p.localId, p.text, p.resend || p.state === "sent", p.sentAs)}
            onDiscard={() => dropPending(p.localId)}
            onUnqueue={() => {
              dropPending(p.localId);
              void control("unqueue", serverId(p));
            }}
            onSendNow={() => void control("sendQueued", serverId(p))}
          />
        )}
        bottomPad={composerH}
        overlay={(nav) => <PromptTimeline nav={nav} bottomPad={composerH} waiting={Boolean(run?.pending.length)} failed={Boolean(failed && !busy)} sheet={jumpOpen} onSheetClose={closeJump} />}
        changes={{ session: id, git, onView: () => setPanel("changes"), onUndone: () => setGitRev((n) => n + 1) }}
        messageActions={branching.actions}
        footer={run?.pending.length ? <AskCards pending={run.pending} respond={respond} onNote={setNoteFor} noting={noteAsk?.requestId ?? null} /> : null}
        empty={
          view.status === "missing" ? (
            <EmptyState
              tone="error"
              icon={<ChatBubbleWarning width={18} height={18} strokeWidth={1.8} />}
              title="Couldn't load this session"
              body="Its history may have been deleted, or the server didn't answer."
              actions={[
                { label: "Reload", onClick: () => window.location.reload() },
                { label: "New session", onClick: onNew },
              ]}
            />
          ) : (
            <EmptyState className="py-16" icon={<ChatBubbleEmpty width={18} height={18} strokeWidth={1.8} />} title="No messages yet" body="Send a message below to start." />
          )
        }
      />

      <div
        ref={composerRef}
        className="safe-bottom safe-x pointer-events-none absolute inset-x-0 bottom-0 z-10 transition-[transform,opacity] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)]"
        style={fold.collapsed ? { transform: "translateY(100%)", opacity: 0 } : undefined}
      >
        <div className="h-6 bg-gradient-to-t from-page to-transparent" />
        {/* the same column as the thread (its width token and side padding), so the card lines up with the text */}
        <div className="pointer-events-auto bg-page px-3 pb-3 sm:px-0 sm:pb-4">
          <div className="mx-auto max-w-(--thread-w) sm:px-8">
            {folder.gone && (
              <div className="mb-2 rounded-[12px] bg-surface shadow-hairline">
                <EmptyState
                  size="inline"
                  tone="error"
                  className="py-2.5"
                  icon={<FolderWarning width={15} height={15} strokeWidth={1.8} />}
                  {...folderGoneCopy(shortPath(view.cwd))}
                  actions={[
                    { label: "New session", onClick: onNew, primary: true },
                    { label: folder.checking ? "Checking…" : "Check again", onClick: () => void folder.check(), disabled: folder.checking },
                  ]}
                />
              </div>
            )}
            {failed && !busy && (
              <div role="alert" className="mb-2 flex flex-col gap-2 rounded-[12px] border border-red/25 bg-red-tint px-3 py-2.5 text-sm text-red-ink sm:flex-row sm:items-center" style={{ animation: "fade-up 240ms cubic-bezier(0.23,1,0.32,1) both" }}>
                <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                  <span className="font-medium">Turn failed.</span> {failed}
                </p>
                <div className="flex shrink-0 items-center gap-1">
                  {lastUserText && !view.pending.some((p) => p.state === "failed") && (
                    <button type="button" onClick={() => void send(lastUserText)} className="tap relative h-8 rounded-full px-3 text-sm font-medium text-ink hover:bg-hover">
                      Retry
                    </button>
                  )}
                  <button type="button" onClick={() => setHandoffOpen(true)} className="tap relative h-8 rounded-full px-3 text-sm font-medium text-ink hover:bg-hover">
                    Continue in…
                  </button>
                  <button type="button" onClick={() => setDismissedError(failed)} aria-label="Dismiss" className="tap relative grid size-8 place-items-center rounded-full text-ink-2 hover:bg-hover">
                    <Xmark width={15} height={15} strokeWidth={1.8} />
                  </button>
                </div>
              </div>
            )}
            {planReady && (
              <div className="mb-2 flex items-center gap-2 rounded-[12px] bg-accent-tint px-3 py-2 text-sm text-accent-ink" style={{ animation: "fade-up 240ms cubic-bezier(0.23,1,0.32,1) both" }}>
                <p className="min-w-0 flex-1">Plan ready. No files changed yet.</p>
                <button
                  type="button"
                  onClick={() => {
                    const next: PermissionMode = agent === "claude" || agent === "codex" ? "acceptEdits" : "bypassPermissions";
                    localModeRef.current = next;
                    setLocalMode(next);
                    if (live) void control("mode", next);
                    void send("Go ahead and implement the plan.");
                  }}
                  className="tap relative h-8 shrink-0 rounded-full bg-ink px-3 text-sm font-medium text-surface"
                >
                  Implement plan
                </button>
              </div>
            )}
            {error && (
              <p role="alert" className="mb-2 rounded-[10px] bg-red-tint px-3 py-2 text-sm text-red-ink" style={{ animation: "fade-up 240ms cubic-bezier(0.23,1,0.32,1) both" }}>
                {error}
              </p>
            )}
            {showTasks(tasks, Boolean(busy)) && <TaskPill key={id} progress={tasks} live={Boolean(busy)} />}
            {view.cwd && (
              <ReviewPill
                session={id}
                root={view.cwd}
                onSend={() => void send("")}
                onShow={() => setPanel("git")}
              />
            )}
            <Composer
              draftKey={id}
              agent={agent}
              placeholder={terminal && !run && !/^(zellij|tmux)/.test(terminal.multiplexer ?? "") ? "Reply in the terminal" : `Reply to ${agentName}…`}
              history={sentTexts}
              onSend={send}
              note={noteAsk ? { label: noteLabel(noteAsk), placeholder: "Tell the agent why…", onSend: sendNote, onCancel: () => setNoteFor(null) } : branching.note}
              running={Boolean(busy && (run || terminal) && !noteAsk)}
              onStop={() => (live ? void control("interrupt") : void pressKey("Escape"))}
              slashCommands={run?.slashCommands ?? []}
              mode={mode}
              onModeChange={(m) => {
                setLocalMode(m);
                if (live) void control("mode", m);
              }}
              model={model}
              onModelChange={(m) => {
                setLocalModel(m || null);
                if (live || typesInto) void control("model", m);
              }}
              autoFocus
              cwd={agent === "claude" ? view.cwd || undefined : undefined}
              models={profileModels(profileInfo, agent === "claude" ? MODELS : agentModels)}
              profiles={profiles ?? undefined}
              profile={profileId}
              onProfileChange={(p) => {
                setLocalProfile(p);
                setLocalModel(null);
              }}
              root={view.cwd || undefined}
              context={composerContext}
              effort={localEffort}
              defaultEffort={profileInfo?.defaultEffort ?? null}
              onEffortChange={pickEffort}
              usage={usage}
              suggestion={noteAsk ? null : (run?.suggestion ?? null)}
              cost={cost}
              costUsd={run?.costUsd ?? null}
              onAppCommand={(name, arg) => {
                const a = arg.toLowerCase();
                if (name === "model") {
                  const m =
                    agent === "claude"
                      ? (MODELS.find((x) => x.key === a || x.name.toLowerCase().startsWith(a))?.key ?? (a === "default" ? "" : null))
                      : a === "default" ? "" : arg.trim() || null;
                  if (m === null) return setError(agent === "claude" ? "Use /model opus, sonnet, haiku, or default." : "Use /model <id> or /model default."), true;
                  setLocalModel(m || null);
                  if (live || typesInto) void control("model", m);
                } else if (name === "mode") {
                  const m = MODE_ALIASES[a.replace(/\s+/g, "")];
                  if (!m) return setError("Use /mode ask, edits, plan, or bypass."), true;
                  setLocalMode(m);
                  if (live) void control("mode", m);
                } else if (name === "effort") {
                  const e = effortFromCommand(agent, arg);
                  const levels = effortOptions(agent).map((o) => o.key);
                  if (e === null) return setError(levels.length ? `Use /effort ${levels.join(", ")}, or default.` : `${agentName} has no effort levels.`), true;
                  pickEffort(e);
                } else if (name === "stop") {
                  if (live) void control("interrupt");
                  else if (terminal) void pressKey("Escape");
                } else if (name === "new") onNew();
                else if (name === "end") {
                  if (live) void control("stop");
                } else return false;
                return true;
              }}
            />
          </div>
        </div>
      </div>
      <ComposerPill shown={fold.collapsed} composer={composerRef} onOpen={fold.expand} />
    </section>
    {panel && (
      <PanelSlot resetKey={panel} onClose={() => setPanel(null)}>
        {usageOpen && <UsagePanel view={view} onClose={() => setPanel(null)} />}
        {gitOpen && <GitPanel session={id} busy={Boolean(busy)} onClose={() => setPanel(null)} />}
        {changesOpen && <ChangesPanel changes={changes} cwd={view.cwd} partial={view.cursor !== null} onClose={() => setPanel(null)} focus={changesFocus.path} focusKey={changesFocus.n} />}
        {filesOpen && view.cwd && (
          <FilesPanel root={view.cwd} target={filesPanel.target} onClose={() => setPanel(null)} onQuickOpen={filesPanel.openPicker} />
        )}
      </PanelSlot>
    )}
    {filesPanel.picking && view.cwd && <QuickOpen root={view.cwd} onPick={filesPanel.pick} onClose={filesPanel.closePicker} />}
    {handoffOpen && <HandoffDialog id={id} agent={agent} current={profileId} mode={mode} onClose={() => setHandoffOpen(false)} onOpen={onNavigate} />}
    </div>
    </FileRoot.Provider>
  );
}
