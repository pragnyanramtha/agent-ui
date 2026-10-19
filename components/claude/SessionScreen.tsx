"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowRight, Folder, GitBranch, GitCompare, Menu, MoreHoriz, StatsReport, Terminal, Xmark } from "iconoir-react";
import { AGENT_LABEL, type AgentId, type Entry, type PermissionMode, type ServerTerminal } from "@/lib/types";
import { AGENT_TONE, AgentMark } from "./SessionList";
import { OPEN_TERMINAL_EVENT } from "./CommandPalette";
import { api, ApiError, shortPath } from "@/lib/client/api";
import { setBaseTitle } from "@/lib/client/attention";
import { carryOver } from "@/lib/client/storage";
import { serverId, useSession } from "@/lib/client/useSession";
import { answerAsk, postReliably, transient, type Answer } from "@/lib/client/send";
import { openServerTerminal } from "@/lib/client/terminals";
import { profileModels, useAgentModels, useProfiles } from "@/lib/client/useProfiles";
import { HandoffDialog } from "./HandoffDialog";
import { OPEN_FILES_EVENT } from "./FilesScreen";
import { runFailed, terminalBusy } from "@/lib/status";
import { AskCards } from "./AskCards";
import { Composer, MODELS } from "./Composer";
import { MODE_ALIASES } from "@/lib/commands";
import { ChangesPanel, collectChanges } from "./ChangesPanel";
import { GitPanel } from "./GitPanel";
import { OPEN_USAGE_EVENT } from "./ContextRing";
import { UsagePanel } from "./UsagePanel";
import { sessionCost } from "@/lib/client/usage";
import { PendingBubble } from "./PendingBubble";
import { TerminalPeek } from "./TerminalPeek";
import { Pulse } from "./Pulse";
import { Thread } from "./Thread";
import { PanelSlot } from "./PanelSlot";
import { FindBar } from "./FindBar";
import { hasMod, isMac } from "@/lib/client/shortcuts";

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
type Panel = "changes" | "git" | "usage";
const PANEL_KEY = "cui:panel";

/** the kind of the last thing said in the thread (usage and notices aside) */
function lastSaid(entries: Entry[]) {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i].kind !== "usage" && entries[i].kind !== "notice") return entries[i].kind;
  return null;
}

export function SessionScreen({
  id,
  onMenu,
  onNavigate,
  onNew,
  extra,
}: {
  id: string;
  onMenu: () => void;
  onNavigate: (id: string) => void;
  onNew: () => void;
  /** trailing header control (the phone tab switcher) */
  extra?: ReactNode;
}) {
  const { view, loadOlder, addPending, updatePending, dropPending } = useSession(id, onNavigate);
  const [localMode, setLocalMode] = useState<PermissionMode | null>(null);
  const [localModel, setLocalModel] = useState<string | null>(null);
  const [localProfile, setLocalProfile] = useState<string | null>(null);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [launching, setLaunching] = useState(false);
  const { profiles } = useProfiles();
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [peek, setPeek] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null);
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
  /* which panels have something to show; read at key time */
  const available = useRef({ changes: false, git: false });
  /* Ctrl/Cmd+Alt+B shows or hides the side panel (the last one used), like VS Code's secondary sidebar */
  useEffect(() => {
    const mac = isMac();
    const onKey = (e: KeyboardEvent) => {
      if (!hasMod(e, mac) || !e.altKey || e.shiftKey || e.code !== "KeyB") return;
      /* AltGr arrives as Ctrl+Alt on Windows and Linux layouts, so it's text there */
      if (!mac && e.getModifierState?.("AltGraph")) return;
      e.preventDefault();
      setPanel((cur) => {
        if (cur) return null;
        let last: string | null = null;
        try {
          last = localStorage.getItem(PANEL_KEY);
        } catch {}
        const ok = (p: string | null): p is Panel => p === "usage" || (p === "changes" && available.current.changes) || (p === "git" && available.current.git);
        return ok(last) ? last : ok("changes") ? "changes" : "usage";
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const changesOpen = panel === "changes";
  const usageOpen = panel === "usage";
  const gitOpen = panel === "git";
  const [composerRef, composerH] = useMeasure<HTMLDivElement>();
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
  const model = localModel ?? run?.model ?? null;
  const where = terminal ? (terminal.headless ? "another program" : (terminal.multiplexer ?? "a terminal")) : null;
  const agentName = AGENT_LABEL[agent];
  const profileId = localProfile ?? view.profile ?? agent;
  const profileInfo = profiles?.find((p) => p.id === profileId);
  const agentModels = useAgentModels(agent, profileId);
  const runsOn = profileInfo && profileInfo.id !== agent ? profileInfo.label : agent !== "claude" ? agentName : null;
  const changes = useMemo(() => collectChanges(view.entries, view.results), [view.entries, view.results]);
  available.current = { changes: changes.length > 0, git: Boolean(view.cwd) };
  const cost = useMemo(() => sessionCost(view.entries, view.run), [view.entries, view.run]);
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
      if (e.key !== "Escape") return;
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

  useEffect(() => {
    setBaseTitle(view.title ? `${view.title} · agent-u` : "agent-u");
  }, [view.title]);

  const pendingRef = useRef(view.pending);
  pendingRef.current = view.pending;
  /* read at send time, so a mode switched right before a send goes with it */
  const localModeRef = useRef(localMode);
  localModeRef.current = localMode;
  /* the bubble stays until the message shows up in the transcript; failures stay visible with Retry.
   * A retry reuses the id the server last saw, so it can't send twice, unless that id was spent on a send that never ran (`fresh`) */
  const deliver = useCallback(
    async (localId: string, text: string, fresh = false, sentAs?: string) => {
      const clientId = fresh ? `${localId}-${Date.now().toString(36)}` : (sentAs ?? localId);
      updatePending(localId, { state: "sending", error: undefined, resend: undefined, sentAs: clientId });
      try {
        const res = await postReliably<{ id: string; via?: "terminal" | "web" | "queued"; cleared?: string | null }>(
          `/api/sessions/${id}/message`,
          { text, model: localModel ?? undefined, permissionMode: localModeRef.current ?? undefined, profile: localProfile ?? undefined },
          clientId,
        );
        updatePending(localId, { state: "sent", via: res.via, sentAt: Date.now() });
        /* a greyed suggestion or half-typed text was in the terminal's prompt; say what was cleared */
        if (res.cleared && !/^Try "/.test(res.cleared)) setError(`Cleared unsent text: "${res.cleared.slice(0, 80)}"`);
        if (res.id !== id) {
          carryOver(id, res.id, pendingRef.current.map((p) => (p.localId === localId ? { ...p, state: "sent", via: res.via, sentAt: Date.now(), sentAs: clientId, error: undefined, resend: undefined } : p)));
          onNavigate(res.id);
        }
      } catch (err) {
        updatePending(localId, { state: "failed", error: err instanceof ApiError && !transient(err) ? err.message : OFFLINE });
        /* the terminal refused the keystrokes: show it, so the reason is visible */
        if (err instanceof ApiError && ["agent_focus", "has_text", "no_prompt"].includes(err.code ?? "")) setPeek(true);
      }
    },
    [id, localModel, localMode, localProfile, updatePending, onNavigate],
  );
  /* sends that failed for want of a connection go out again once it's back */
  useEffect(() => {
    const retry = () => pendingRef.current.filter((p) => p.state === "failed" && p.error === OFFLINE).forEach((p) => void deliver(p.localId, p.text, false, p.sentAs));
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [deliver]);
  const send = useCallback(
    async (text: string) => {
      void deliver(addPending(text), text);
      return true;
    },
    [deliver, addPending],
  );

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

  /* the cards show a failure themselves and offer the answer again */
  const respond = useCallback((body: Answer) => answerAsk(id, body), [id]);

  /* status as a quiet mark + word; below 480px only the mark shows for calm states, states that need you keep the word */
  const chip = "flex h-8 shrink-0 items-center gap-1.5 px-1.5 text-[13px]";
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
    if (terminal) {
      /* only zellij and tmux can be joined from here; anything else stays where it runs */
      if (!/^(zellij|tmux)/.test(terminal.multiplexer ?? "")) {
        setError(
          terminal.headless
            ? "Another app is running this session. Continue it there, or open it here once it ends."
            : "This terminal can't be opened in the browser. Continue it there, or quit it there and open it here.",
        );
        return;
      }
      window.dispatchEvent(new CustomEvent(OPEN_TERMINAL_EVENT, { detail: { session: agent === "claude" ? id : undefined, pid: terminal.pid, label: `${agentName}: ${view.title || "session"}` } }));
      return;
    }
    setLaunching(true);
    try {
      const t = await api<{ id: string; backing: string; label: string }>("/api/terminals", { session: id, profile: profileId });
      openServerTerminal(t, `${t.label}: ${view.title || "session"}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't open the terminal.");
    } finally {
      setLaunching(false);
    }
  };

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
    <section ref={sectionRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="on-page safe-top safe-x relative z-20 flex shrink-0 items-center bg-page">
        <div className="flex h-14 w-full min-w-0 items-center gap-0.5 px-1.5 sm:px-3 lg:h-[52px]">
          <button type="button" onClick={onMenu} aria-label="Open sessions" aria-haspopup="dialog" data-drawer-opener className="icon-btn lg:hidden">
            <Menu width={19} height={19} strokeWidth={1.8} />
          </button>
          <div className="flex min-w-0 flex-1 flex-col px-1.5 sm:flex-row sm:items-baseline sm:gap-2.5">
            <h1 className="min-w-0 truncate text-[15px] font-medium tracking-[-0.01em] text-ink sm:text-[14.5px]" title={view.title || undefined}>
              {view.title || (view.status === "missing" ? "Couldn't load this session" : "Loading session…")}
            </h1>
            {(view.cwd || runsOn) && (
              <p className="flex min-w-0 shrink-[3] items-center gap-1.5 text-[12px] text-ink-3 sm:text-[13px]" title={view.cwd || undefined}>
                {runsOn && (
                  <>
                    <AgentMark agent={agent} />
                    <span className="shrink-0">{runsOn}</span>
                    {view.cwd && <span aria-hidden>·</span>}
                  </>
                )}
                <span className="truncate" translate="no">
                  {shortPath(view.cwd)}
                </span>
              </p>
            )}
          </div>
          {status}
          {changes.length > 0 && (
            <button
              type="button"
              onClick={() => togglePanel("changes")}
              aria-pressed={changesOpen}
              aria-label={`Changes: ${changes.length} ${changes.length === 1 ? "file" : "files"}`}
              data-tip="Changes"
              data-tip-pos="bottom"
              className="icon-btn w-auto gap-1 px-2 text-[12.5px] font-medium tabular-nums"
            >
              <GitCompare width={17} height={17} strokeWidth={1.8} />
              <span className="max-[379px]:sr-only">{changes.length}</span>
            </button>
          )}
          {view.status !== "missing" && (terminal || !busy) && (
            <button
              type="button"
              onClick={() => void openInteractive()}
              disabled={launching}
              aria-label="Open in terminal"
              data-tip="Open in terminal"
              data-tip-pos="bottom"
              className="icon-btn w-auto gap-1.5 px-2.5 text-[12.5px] font-medium disabled:opacity-60"
            >
              <Terminal width={17} height={17} strokeWidth={1.8} />
              <span className="max-sm:sr-only">{launching ? "Opening…" : "Terminal"}</span>
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
              className="icon-btn max-sm:hidden"
            >
              <GitBranch width={17} height={17} strokeWidth={1.8} />
            </button>
          )}
          <button
            type="button"
            onClick={() => togglePanel("usage")}
            aria-pressed={usageOpen}
            aria-label="Usage and cost"
            data-tip="Usage"
            data-tip-pos="bottom"
            className="icon-btn max-sm:hidden"
          >
            <StatsReport width={17} height={17} strokeWidth={1.8} />
          </button>
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
              className="icon-btn"
            >
              <MoreHoriz width={18} height={18} strokeWidth={1.8} />
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
                        <span className="text-[12px] text-ink-3">Stops the agent. History stays.</span>
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
        footer={run?.pending.length ? <AskCards pending={run.pending} respond={respond} /> : null}
        empty={
          view.status === "missing" ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <p className="text-[13px] text-ink-3">Couldn&apos;t load this session.</p>
              <button type="button" onClick={() => window.location.reload()} className="h-9 rounded-full px-3.5 text-[12.5px] font-medium text-ink shadow-btn hover:bg-hover">
                Reload
              </button>
            </div>
          ) : (
            <p className="py-16 text-center text-[13px] text-ink-3">No messages yet.</p>
          )
        }
      />

      <div ref={composerRef} className="safe-bottom safe-x pointer-events-none absolute inset-x-0 bottom-0 z-10">
        <div className="h-6 bg-gradient-to-t from-page to-transparent" />
        <div className="pointer-events-auto bg-page px-3 pb-3 sm:px-8 sm:pb-5">
          <div className="mx-auto max-w-[740px]">
            {failed && !busy && (
              <div role="alert" className="mb-2 flex flex-col gap-2 rounded-[12px] border border-red/25 bg-red-tint px-3 py-2.5 text-[13px] text-red-ink sm:flex-row sm:items-center" style={{ animation: "fade-up 240ms cubic-bezier(0.23,1,0.32,1) both" }}>
                <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                  <span className="font-medium">Turn failed.</span> {failed}
                </p>
                <div className="flex shrink-0 items-center gap-1">
                  {lastUserText && !view.pending.some((p) => p.state === "failed") && (
                    <button type="button" onClick={() => void send(lastUserText)} className="tap relative h-8 rounded-full px-3 text-[12.5px] font-medium text-ink hover:bg-hover">
                      Retry
                    </button>
                  )}
                  <button type="button" onClick={() => setHandoffOpen(true)} className="tap relative h-8 rounded-full px-3 text-[12.5px] font-medium text-ink hover:bg-hover">
                    Continue in…
                  </button>
                  <button type="button" onClick={() => setDismissedError(failed)} aria-label="Dismiss" className="tap relative grid size-8 place-items-center rounded-full text-ink-2 hover:bg-hover">
                    <Xmark width={15} height={15} strokeWidth={1.8} />
                  </button>
                </div>
              </div>
            )}
            {planReady && (
              <div className="mb-2 flex items-center gap-2 rounded-[12px] bg-accent-tint px-3 py-2 text-[13px] text-accent-ink" style={{ animation: "fade-up 240ms cubic-bezier(0.23,1,0.32,1) both" }}>
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
                  className="tap relative h-8 shrink-0 rounded-full bg-ink px-3 text-[12.5px] font-medium text-surface"
                >
                  Implement plan
                </button>
              </div>
            )}
            {error && (
              <p role="alert" className="mb-2 rounded-[10px] bg-red-tint px-3 py-2 text-[13px] text-red-ink" style={{ animation: "fade-up 240ms cubic-bezier(0.23,1,0.32,1) both" }}>
                {error}
              </p>
            )}
            <Composer
              draftKey={id}
              placeholder={terminal && !run && !/^(zellij|tmux)/.test(terminal.multiplexer ?? "") ? "Reply in the terminal" : `Reply to ${agentName}…`}
              history={sentTexts}
              onSend={send}
              running={Boolean(busy && (run || terminal))}
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
                if (live) void control("model", m);
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
              usage={usage}
              suggestion={run?.suggestion ?? null}
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
                  if (live) void control("model", m);
                } else if (name === "mode") {
                  const m = MODE_ALIASES[a.replace(/\s+/g, "")];
                  if (!m) return setError("Use /mode ask, edits, plan, or bypass."), true;
                  setLocalMode(m);
                  if (live) void control("mode", m);
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
    </section>
    {panel && (
      <PanelSlot>
        {usageOpen && <UsagePanel view={view} onClose={() => setPanel(null)} />}
        {gitOpen && <GitPanel session={id} busy={Boolean(busy)} onClose={() => setPanel(null)} />}
        {changesOpen && <ChangesPanel changes={changes} cwd={view.cwd} partial={view.cursor !== null} onClose={() => setPanel(null)} />}
      </PanelSlot>
    )}
    {handoffOpen && <HandoffDialog id={id} agent={agent} current={profileId} mode={mode} onClose={() => setHandoffOpen(false)} onOpen={onNavigate} />}
    </div>
  );
}
