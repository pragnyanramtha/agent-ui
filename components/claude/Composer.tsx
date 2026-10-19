"use client";

import { useSetting } from "@/lib/client/settings";
import { comboFor, hasMod, modalOpen } from "@/lib/client/shortcuts";
import { onFirstLine, onLastLine } from "@/lib/client/caret";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Archive, ArrowUp, Attachment, Brain, Check, Folder, NavArrowDown, Plus, ShieldAlert, ShieldCheck, Trash } from "iconoir-react";
import { APP_COMMANDS, rankCommands, type SlashItem } from "@/lib/commands";
import { ContextRing, type ContextUsage } from "./ContextRing";
import { promptAsk } from "./Ask";
import type { SessionCost } from "@/lib/client/usage";
import { shortPath, timeAgo } from "@/lib/client/api";
import { load, save } from "@/lib/client/storage";
import { AGENT_LABEL, type AgentId, type PermissionMode, type ProfileInfo } from "@/lib/types";
import { withAttachments } from "@/lib/attachments";
import { AttachmentChips, useAttachments } from "./Attachments";
import { effortLabel, effortOptions } from "@/lib/agent-traits";
import { insertMention, mentionAt } from "@/lib/client/mentions";
import { useFileSearch } from "@/lib/client/useFileSearch";
import { dropStash, loadStash, pushStash, stashTitle, type Stash } from "@/lib/client/stash";

/* The composer pill: one calm surface with a "+" menu on the left, the text
 * in the middle, and one quiet agent/model/approvals picker plus send on the
 * right. Single row while the text fits on one line (and the pill is wide),
 * stacked once it grows. */

export const MODES: { key: PermissionMode; name: string; short: string; desc: string }[] = [
  { key: "default", name: "Ask before acting", short: "Ask first", desc: "Approve edits and commands here" },
  { key: "acceptEdits", name: "Accept edits", short: "Accept edits", desc: "File edits go through, commands still ask" },
  { key: "plan", name: "Plan only", short: "Plan", desc: "Read and propose, no changes" },
  { key: "bypassPermissions", name: "Bypass approvals", short: "Bypass", desc: "Everything runs without asking" },
];

/* the labels in the segmented approvals control */
const MODE_SEG: Record<PermissionMode, string> = { default: "Ask", acceptEdits: "Edits", plan: "Plan", bypassPermissions: "Bypass" };

export const MODELS = [
  { key: "", name: "Default" },
  { key: "opus", name: "Opus" },
  { key: "sonnet", name: "Sonnet" },
  /* the "haiku" alias still resolves to Haiku 4.5 on current Claude Code */
  { key: "claude-haiku-5-5", name: "Haiku 5.5" },
];

export function modelLabel(model: string | null) {
  if (!model) return "Default";
  const m = /claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?/.exec(model);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] && m[3].length < 3 ? `.${m[3]}` : ""}`;
  return MODELS.find((x) => x.key === model)?.name ?? model;
}

export type AgentOption = { id: AgentId; label: string; installed: boolean };

type Menu = "slash" | "mention" | "pick" | "plus" | "stash" | "effort" | null;

const KIND_LABEL: Record<SlashItem["kind"], string> = { app: "This app", builtin: "Claude Code", command: "Your commands", skill: "Skills" };

const MENU_W = { pick: 272, plus: 248, effort: 280 };

function MenuShell({
  children,
  placement,
  maxHeight,
  left,
  right,
  width,
}: {
  children: React.ReactNode;
  placement: "up" | "down";
  maxHeight: number;
  left?: number;
  right?: number;
  width?: number;
}) {
  const full = width === undefined;
  const origin = `${placement === "up" ? "bottom" : "top"} ${right !== undefined ? "right" : "left"}`;
  return (
    <div
      className={`composer-menu no-scrollbar absolute z-30 overflow-y-auto overscroll-contain rounded-[10px] bg-surface p-1 shadow-raised ${
        placement === "up" ? "bottom-full mb-2" : "top-full mt-2"
      } ${full ? "inset-x-0" : "max-w-full"}`}
      style={{ left: full || right !== undefined ? undefined : left ?? 0, right, width, maxHeight, transformOrigin: origin }}
    >
      {children}
    </div>
  );
}

const ITEM_SELECTOR = '[role="menuitemradio"]:not([disabled]), [role="menuitem"]:not([disabled])';

/** Arrow keys, Home and End move focus between a menu's items. */
function moveFocus(e: React.KeyboardEvent<HTMLElement>) {
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(ITEM_SELECTOR));
  if (!items.length) return;
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next =
    e.key === "ArrowDown" ? (at + 1) % items.length : e.key === "ArrowUp" ? (at - 1 + items.length) % items.length : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : -1;
  if (next < 0) return;
  e.preventDefault();
  items[next].focus();
}

function MenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <p role="presentation" className="px-2.5 pt-2 pb-1 text-[11.5px] font-medium text-ink-3">
      {children}
    </p>
  );
}

const menuRow =
  "flex w-full min-w-0 items-center gap-2.5 rounded-[8px] px-2.5 text-left text-[13.5px] text-ink transition-colors duration-75 outline-none hover:bg-hover focus-visible:bg-hover disabled:cursor-default disabled:hover:bg-transparent h-10 sm:h-8 sm:text-[13px]";

const ghost = "tap relative flex shrink-0 items-center justify-center rounded-full text-ink-2 transition-[background-color,color] duration-150 hover:bg-hover hover:text-ink";

export function Composer({
  draftKey,
  placeholder,
  onSend,
  running,
  onStop,
  slashCommands,
  mode,
  onModeChange,
  model,
  onModelChange,
  notice,
  autoFocus,
  cwd,
  onAppCommand,
  usage = null,
  costUsd = null,
  models = MODELS,
  suggestion = null,
  cost = null,
  agents,
  agent = "claude",
  onAgentChange,
  folder,
  onPickFolder,
  folderInvalid = false,
  busyLabel,
  profiles,
  profile,
  onProfileChange,
  history,
  effort = "",
  onEffortChange,
  defaultEffort = null,
  root,
}: {
  draftKey: string;
  placeholder: string;
  onSend: (text: string) => Promise<boolean>;
  running: boolean;
  onStop?: () => void;
  slashCommands: string[];
  mode: PermissionMode;
  onModeChange: (mode: PermissionMode) => void;
  model: string | null;
  onModelChange: (model: string) => void;
  notice?: React.ReactNode;
  autoFocus?: boolean;
  /** folder whose project commands and skills to offer */
  cwd?: string;
  /** browser-side commands (/model, /mode, /stop, /new, /end); return true when handled */
  onAppCommand?: (name: string, arg: string) => boolean;
  /** latest turn's token usage, shown as the context ring */
  usage?: ContextUsage | null;
  costUsd?: number | null;
  /** model choices for this agent (Claude's by default); ignored when `agents` is set */
  models?: { key: string; name: string }[];
  /** Claude's suggested next message; Tab or a tap puts it in the box */
  suggestion?: string | null;
  /** session cost (actual or estimated) for the context popover */
  cost?: SessionCost | null;
  /** agents to choose from (new sessions); without it the agent is fixed and the picker only shows models */
  agents?: AgentOption[];
  agent?: AgentId;
  onAgentChange?: (agent: AgentId) => void;
  /** working folder chip (new sessions); undefined hides it, "" shows an empty chip */
  folder?: string;
  /** opens the folder picker; adds "Folder" to the + menu */
  onPickFolder?: () => void;
  folderInvalid?: boolean;
  /** shown in the box while onSend is pending (e.g. "Starting Claude…") */
  busyLabel?: string;
  /** accounts, proxies and wrappers for the current agent; the group shows when there's more than one */
  profiles?: ProfileInfo[];
  profile?: string;
  onProfileChange?: (id: string) => void;
  /** messages already sent in this session, oldest first; Arrow Up in an empty box brings them back */
  history?: string[];
  /** reasoning effort picked for this session, "" for the default (the profile's, else the agent's own);
   * the chip shows when the agent has levels and this is handled */
  effort?: string;
  onEffortChange?: (effort: string) => void;
  /** the profile's default level, named on the Default row */
  defaultEffort?: string | null;
  /** the session's folder: @ lists its files */
  root?: string;
}) {
  const [draft, setDraft] = useState("");
  const [caret, setCaret] = useState(0);
  /* where the caret goes once a picked path is in the box */
  const caretAfter = useRef<number | null>(null);
  const [sendWithEnter] = useSetting("sendWithEnter");
  /* index into `history` while stepping through it with the arrows; null when not recalling */
  const recall = useRef<number | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [slashHidden, setSlashHidden] = useState(false);
  const [menuPos, setMenuPos] = useState<{ left?: number; right?: number }>({});
  const [placement, setPlacement] = useState<"up" | "down">("up");
  const [menuMax, setMenuMax] = useState(416);
  const [active, setActive] = useState(0);
  const [sending, setSending] = useState(false);
  const [wide, setWide] = useState(true);
  const [multi, setMulti] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const pickRef = useRef<HTMLButtonElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  const effortRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const uid = useId();
  const [catalog, setCatalog] = useState<SlashItem[]>([]);
  const files = useAttachments();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [stashes, setStashes] = useState<Stash[]>([]);
  useEffect(() => setStashes(loadStash(root)), [root]);
  const addFiles = (list: FileList | File[]) => setFileNote(files.add(list));
  useEffect(() => {
    if (!fileNote) return;
    const t = setTimeout(() => setFileNote(null), 6000);
    return () => clearTimeout(t);
  }, [fileNote]);

  /* commands and skills on disk, so the menu works before the session is running */
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/commands${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`)
      .then((r) => (r.ok ? r.json() : { commands: [] }))
      .then((d: { commands: SlashItem[] }) => !cancelled && setCatalog(d.commands ?? []))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  /* drafts survive reloads and switching sessions */
  useEffect(() => {
    setDraft(load(`draft:${draftKey}`) ?? "");
  }, [draftKey]);
  useEffect(() => {
    save(`draft:${draftKey}`, draft || null);
  }, [draft, draftKey]);

  useEffect(() => {
    if (autoFocus && window.matchMedia("(pointer: fine)").matches) inputRef.current?.focus();
  }, [autoFocus, draftKey]);

  /* one row only when there's room for it */
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWide(el.offsetWidth >= 520));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const stacked = !wide || multi;

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    const h = el.scrollHeight;
    el.style.height = `${Math.min(Math.max(h, 36), 200)}px`;
    el.style.overflowY = h > 200 ? "auto" : "hidden";
    /* grow into the stacked layout once the text wraps; go back only when the box is cleared */
    if (!draft) setMulti(false);
    else if (!stacked && (h > 44 || draft.includes("\n"))) setMulti(true);
  }, [draft, stacked]);

  const slashQuery = /^\/([\w:-]*)$/.exec(draft)?.[1];
  const allCommands = useMemo(() => {
    /* Claude Code's commands and skills mean nothing to the other CLIs */
    const disk = agent === "claude" ? catalog : [];
    const known = new Set(disk.map((c) => c.name));
    const live = slashCommands.filter((n) => !known.has(n)).map((name): SlashItem => ({ name, description: "", kind: "command" }));
    const app = APP_COMMANDS.filter((c) => c.name !== "effort" || effortOptions(agent).length > 0);
    return [...(onAppCommand ? app : []), ...disk, ...live];
  }, [catalog, slashCommands, onAppCommand, agent]);
  /* "Commands" in the + menu opens the list without touching the text; picking one prefixes it */
  const forcedSlash = menu === "slash";
  const commands = slashQuery !== undefined ? rankCommands(allCommands, slashQuery) : forcedSlash ? rankCommands(allCommands, "") : [];
  const mention = root && slashQuery === undefined ? mentionAt(draft, caret) : null;
  const found = useFileSearch(root, mention?.query);
  const openMenu: Menu = menu ?? (slashHidden ? null : slashQuery !== undefined ? "slash" : mention ? "mention" : null);

  useEffect(() => setActive(0), [slashQuery, forcedSlash, mention?.query]);

  useLayoutEffect(() => {
    const at = caretAfter.current;
    if (at === null) return;
    caretAfter.current = null;
    inputRef.current?.setSelectionRange(at, at);
    setCaret(at);
  }, [draft]);

  /* menus open toward the side of the screen with more room */
  useLayoutEffect(() => {
    if (!openMenu) return;
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return;
    const up = r.top > window.innerHeight - r.bottom;
    setPlacement(up ? "up" : "down");
    /* use the room there is (minus a margin), capped so long lists still scroll */
    setMenuMax(Math.max(160, Math.min(520, (up ? r.top : window.innerHeight - r.bottom) - 16)));
  }, [openMenu]);

  /* close on Escape, outside taps, or focus leaving the composer; return focus to the trigger */
  const [modelQ, setModelQ] = useState("");
  useEffect(() => {
    if (openMenu !== "pick") setModelQ("");
  }, [openMenu]);

  const closeMenu = useCallback(
    (refocus: boolean) => {
      const trigger = menu === "pick" ? pickRef.current : menu === "plus" || menu === "stash" ? plusRef.current : menu === "effort" ? effortRef.current : inputRef.current;
      setMenu(null);
      setSlashHidden(true);
      if (refocus) trigger?.focus();
    },
    [menu],
  );

  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) closeMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      closeMenu(rootRef.current?.contains(document.activeElement) ?? false);
    };
    const onFocus = (e: FocusEvent) => {
      if (e.target instanceof Node && !rootRef.current?.contains(e.target)) closeMenu(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocus);
    };
  }, [openMenu, closeMenu]);

  /* the picker takes focus on the checked item (the + menu on its first) so arrows work right away */
  useEffect(() => {
    if (menu !== "pick" && menu !== "plus" && menu !== "stash" && menu !== "effort") return;
    const root = menuRef.current;
    const el = (menu !== "plus" ? root?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]') : null) ?? root?.querySelector<HTMLElement>(ITEM_SELECTOR);
    el?.focus({ preventScroll: true });
  }, [menu]);

  const toggleMenu = (which: "pick" | "plus" | "effort") => {
    if (menu === which || (which === "plus" && menu === "stash")) return closeMenu(false);
    if (which === "plus") setStashes(loadStash(root));
    const box = rootRef.current?.getBoundingClientRect();
    const trigger = (which === "pick" ? pickRef.current : which === "effort" ? effortRef.current : plusRef.current)?.getBoundingClientRect();
    if (box && trigger) {
      const w = Math.min(MENU_W[which], box.width);
      setMenuPos(
        which !== "plus"
          ? { right: Math.max(0, Math.min(box.right - trigger.right - 4, box.width - w)) }
          : { left: Math.max(0, Math.min(trigger.left - box.left - 4, box.width - w)) },
      );
    }
    setMenu(which);
  };

  const hasFiles = files.items.length > 0;
  const canSend = (draft.trim().length > 0 || hasFiles) && !sending && !files.uploading && !files.failed;
  const stopFirst = Boolean(running && onStop && !draft.trim() && !hasFiles && !sending);
  const send = async () => {
    if (!canSend) return;
    const typed = draft.trim();
    const text = withAttachments(typed, files.paths);
    const app = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(text);
    if (app && !hasFiles && onAppCommand && APP_COMMANDS.some((c) => c.name === app[1]) && onAppCommand(app[1], (app[2] ?? "").trim())) {
      setDraft("");
      return;
    }
    setSending(true);
    setDraft("");
    const ok = await onSend(text).catch(() => false);
    if (!ok) setDraft(typed);
    else files.clear();
    setSending(false);
  };

  const pickCommand = (c: string) => {
    setDraft((d) => (slashQuery !== undefined || !d.trim() ? `/${c} ` : `/${c} ${d}`));
    setMenu(null);
    setSlashHidden(true);
    inputRef.current?.focus();
  };

  const keptFiles = () => files.items.filter((a) => a.state === "done" && a.path).map((a) => ({ name: a.name, size: a.size, path: a.path! }));
  const canStash = Boolean(draft.trim() || keptFiles().length);
  /** puts the draft (and its uploaded files) aside and clears the box; false when nothing was stashed */
  const stashDraft = (quiet = false) => {
    if (files.uploading) return setFileNote("Wait for the upload to finish."), false;
    const kept = keptFiles();
    if (!draft.trim() && !kept.length) return !quiet && setFileNote("Nothing to stash."), false;
    const list = pushStash(root, draft, kept);
    if (!list) return setFileNote("Couldn't stash. Browser storage is full or turned off."), false;
    setStashes(list);
    setDraft("");
    files.clear();
    recall.current = null;
    if (!quiet) setFileNote("Prompt stashed. Restore it from the + menu.");
    return true;
  };
  /* a draft in the box is stashed first, so restoring never loses text */
  const restoreStash = (s: Stash) => {
    if ((draft.trim() || files.items.length) && !stashDraft(true)) return;
    const swapped = Boolean(draft.trim() || files.items.length);
    setStashes(dropStash(root, s.id));
    setDraft(s.text);
    files.restore(s.files);
    setMenu(null);
    if (swapped) setFileNote("Your draft was stashed.");
    inputRef.current?.focus();
  };
  const deleteStash = (id: string) => {
    setStashes(dropStash(root, id));
    requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>(ITEM_SELECTOR)?.focus({ preventScroll: true }));
  };

  const pickMention = (rel: string) => {
    if (!mention) return;
    const next = insertMention(draft, mention.start, mention.end, rel);
    caretAfter.current = next.caret;
    setDraft(next.text);
    inputRef.current?.focus();
  };

  const currentMode = MODES.find((m) => m.key === mode) ?? MODES[0];
  const efforts = onEffortChange ? effortOptions(agent) : [];
  const effortName = effortLabel(agent, effort || defaultEffort);
  const slashOpen = openMenu === "slash";
  const mentionOpen = openMenu === "mention";
  /* with `agents` (even while it loads) the agent is choosable; the Claude section is always there */
  const pickable = agents && onAgentChange;
  const agentLabel = agents?.find((a) => a.id === agent)?.label ?? AGENT_LABEL[agent];
  /* new sessions name the agent ("Claude · Opus", "Codex"); replies only the model */
  const modelName = (m: string | null) => (m && models.find((x) => x.key === m)?.name) || modelLabel(m);
  const pickLabel = pickable ? (model ? `${agentLabel} · ${modelName(model)}` : agentLabel) : modelName(model);
  const modelOn = (key: string, list: { key: string }[]) => key === (model && list.some((x) => x.key === model) ? model : "");
  const busy = sending && busyLabel;
  const profileChoices = onProfileChange ? (profiles ?? []).filter((p) => p.agent === agent && !p.hidden) : [];
  const profileOn = profileChoices.find((p) => p.id === profile);
  const pickText = profileOn && profileChoices.length > 1 && profileOn.id !== agent ? `${profileOn.label}${model ? ` · ${modelName(model)}` : ""}` : pickLabel;

  const modelRow = (m: { key: string; name: string }, list: { key: string }[], on: boolean, onPick: () => void) => (
    <button
      key={m.key || "default"}
      type="button"
      role="menuitemradio"
      aria-checked={on}
      onClick={onPick}
      className={menuRow}
    >
      <span className="min-w-0 truncate">{m.name}</span>
      {m.key === "" && model && !list.some((x) => x.key === model) && <span className="truncate text-[12px] text-ink-3">{modelName(model)}</span>}
      {on && <Check width={15} height={15} strokeWidth={2.2} className="ml-auto shrink-0 text-ink" aria-hidden />}
    </button>
  );

  /* long CLI lists (Cursor has hundreds) get a filter; Default and the current model stay visible */
  const q = modelQ.trim().toLowerCase();
  const shownModels = q ? models.filter((m) => m.key === "" || m.key === model || `${m.key} ${m.name}`.toLowerCase().includes(q)) : models;
  const modelList = (
    <>
      {models.length > 12 && (
        <div className="px-1.5 pb-1">
          <input
            value={modelQ}
            onChange={(e) => setModelQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Home" || e.key === "End") e.stopPropagation();
            }}
            placeholder={`Filter ${models.length - 1} models…`}
            aria-label="Filter models"
            className="h-9 w-full rounded-[8px] bg-inset px-2.5 text-[13px] text-ink shadow-hairline outline-none placeholder:text-ink-3 focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-8"
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
          />
        </div>
      )}
      {/* long lists scroll on their own so the approvals below stay in reach */}
      <div className={models.length > 12 ? "max-h-[min(36dvh,300px)] overflow-y-auto overscroll-contain" : undefined}>
        {shownModels.map((m) =>
          modelRow(m, models, modelOn(m.key, models), () => {
            onModelChange(m.key);
            closeMenu(true);
          }),
        )}
        {q && shownModels.every((m) => m.key === "" || m.key === model) && <p className="px-2.5 py-1.5 text-[12.5px] text-ink-3">No models match.</p>}
      </div>
    </>
  );

  /* CLI agents accept model ids their list may not show (new releases, other providers) */
  const otherModelRow =
    agent !== "claude" ? (
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          closeMenu(true);
          void promptAsk({ title: `${agentLabel} model`, body: "Any model id the CLI accepts.", confirm: "Use model", value: modelQ.trim() || model || "" }).then((m) => m && onModelChange(m));
        }}
        className={`${menuRow} text-ink-2`}
      >
        <span>Other model…</span>
      </button>
    ) : null;

  return (
    <div ref={rootRef} className="relative w-full" data-composer>
      {slashOpen && (
        <MenuShell placement={placement} maxHeight={Math.min(menuMax, 416)}>
          <div role="listbox" id={`${uid}-slash`} aria-label="Slash commands">
            {commands.map((c, i) => {
              const header = i === 0 || commands[i - 1].kind !== c.kind ? KIND_LABEL[c.kind] : null;
              return (
                <div key={`${c.kind}:${c.name}`}>
                  {header && !slashQuery && <p className="px-2.5 pt-2 pb-1 text-[11.5px] font-medium text-ink-3">{header}</p>}
                  <button
                    id={`${uid}-cmd-${i}`}
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    tabIndex={-1}
                    ref={i === active ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pickCommand(c.name)}
                    className={`flex w-full min-w-0 items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-left transition-colors duration-75 sm:py-1.5 ${i === active ? "bg-hover" : ""}`}
                  >
                    <span className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-baseline sm:gap-2.5">
                      <span className="shrink-0 font-mono text-[13px] text-ink sm:text-[12.5px]" translate="no">
                        /{c.name}
                        {c.hint && <span className="text-ink-3"> {c.hint}</span>}
                      </span>
                      {c.description && <span className="min-w-0 truncate text-[12px] text-ink-3">{c.description}</span>}
                    </span>
                    {slashQuery ? <span className="shrink-0 text-[10.5px] font-medium text-ink-3">{KIND_LABEL[c.kind]}</span> : null}
                  </button>
                </div>
              );
            })}
          </div>
          {commands.length === 0 && (
            <p className="px-2.5 py-2 text-[12.5px] text-ink-3">{allCommands.length ? `No command matches “${slashQuery}”.` : "Loading commands…"}</p>
          )}
        </MenuShell>
      )}

      {mentionOpen && (
        <MenuShell placement={placement} maxHeight={Math.min(menuMax, 416)}>
          <div role="listbox" id={`${uid}-files`} aria-label="Files">
            {found.files.map((f, i) => {
              const cut = f.lastIndexOf("/");
              return (
                <button
                  key={f}
                  id={`${uid}-file-${i}`}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  tabIndex={-1}
                  ref={i === active ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pickMention(f)}
                  className={`flex h-10 w-full min-w-0 items-center gap-2.5 rounded-[8px] px-2.5 text-left transition-colors duration-75 sm:h-8 ${i === active ? "bg-hover" : ""}`}
                >
                  <span className="shrink-0 truncate font-mono text-[13px] text-ink sm:text-[12.5px]" translate="no">
                    {f.slice(cut + 1)}
                  </span>
                  {cut > 0 && (
                    /* rtl keeps the end of a long folder path in view; bdi keeps its characters in order */
                    <span className="min-w-0 truncate text-[12px] text-ink-3" translate="no" dir="rtl">
                      <bdi>{f.slice(0, cut)}</bdi>
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {found.files.length === 0 && (
            <p className="px-2.5 py-2 text-[12.5px] text-ink-3">
              {found.loading ? "Searching files…" : found.error ? "Couldn't list files here." : mention?.query ? `No files match “${mention.query}”.` : "No files here."}
            </p>
          )}
        </MenuShell>
      )}

      {openMenu === "plus" && (
        <MenuShell placement={placement} maxHeight={menuMax} left={menuPos.left} width={MENU_W.plus}>
          <div ref={menuRef} role="menu" id={`${uid}-plus`} aria-label="Add" onKeyDown={moveFocus}>
            {onPickFolder && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  onPickFolder();
                }}
                className={menuRow}
              >
                <Folder width={16} height={16} strokeWidth={1.8} className="shrink-0 text-ink-2" aria-hidden />
                <span className="shrink-0">Folder</span>
                {folder && (
                  <span className="ml-auto min-w-0 truncate text-[12px] text-ink-3" translate="no">
                    {shortPath(folder)}
                  </span>
                )}
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                fileRef.current?.click();
              }}
              className={menuRow}
            >
              <Attachment width={16} height={16} strokeWidth={1.8} className="shrink-0 text-ink-2" aria-hidden />
              <span>Files or photos</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setSlashHidden(false);
                if (!draft.trim()) {
                  setMenu(null);
                  setDraft("/");
                } else setMenu("slash");
                inputRef.current?.focus();
              }}
              className={menuRow}
            >
              <span aria-hidden className="flex size-4 shrink-0 items-center justify-center font-mono text-[14px] leading-none text-ink-2">
                /
              </span>
              <span>Commands</span>
              <span className="ml-auto text-[12px] text-ink-3">Type /</span>
            </button>
            <div role="separator" className="mx-2.5 my-1 h-px bg-line" />
            <button
              type="button"
              role="menuitem"
              disabled={!canStash}
              onClick={() => {
                setMenu(null);
                stashDraft();
                inputRef.current?.focus();
              }}
              className={`${menuRow} disabled:text-ink-3`}
            >
              <Archive width={16} height={16} strokeWidth={1.8} className="shrink-0 text-ink-2" aria-hidden />
              <span>Stash prompt</span>
              <span className="ml-auto text-[12px] text-ink-3 pointer-coarse:hidden">{comboFor("stash")}</span>
            </button>
            {stashes.length > 0 && (
              <button type="button" role="menuitem" aria-haspopup="menu" onClick={() => setMenu("stash")} className={menuRow}>
                <span aria-hidden className="size-4 shrink-0" />
                <span>Stashed prompts</span>
                <span className="ml-auto text-[12px] text-ink-3 tabular-nums">{stashes.length}</span>
              </button>
            )}
          </div>
        </MenuShell>
      )}

      {openMenu === "stash" && (
        <MenuShell placement={placement} maxHeight={menuMax} left={menuPos.left} width={300}>
          <div ref={menuRef} role="menu" id={`${uid}-stash`} aria-label="Stashed prompts" onKeyDown={moveFocus}>
            <MenuLabel>Stashed prompts</MenuLabel>
            {stashes.map((st) => {
              const title = stashTitle(st);
              return (
                <div key={st.id} className="flex min-w-0 items-center gap-0.5">
                  <button type="button" role="menuitem" onClick={() => restoreStash(st)} title="Put back in the box" className={`${menuRow} flex-1`}>
                    <span className="min-w-0 flex-1 truncate">{title}</span>
                    {st.files.length > 0 && <Attachment width={14} height={14} strokeWidth={1.8} className="shrink-0 text-ink-3" aria-label={`${st.files.length} attached`} />}
                    <span className="shrink-0 text-[12px] text-ink-3 tabular-nums">{timeAgo(st.at)}</span>
                  </button>
                  <button type="button" role="menuitem" aria-label={`Delete stashed prompt: ${title}`} title="Delete" onClick={() => deleteStash(st.id)} className={`${ghost} size-10 rounded-[8px] sm:size-8`}>
                    <Trash width={15} height={15} strokeWidth={1.8} aria-hidden />
                  </button>
                </div>
              );
            })}
            {stashes.length === 0 && <p className="px-2.5 py-2 text-[12.5px] text-ink-3">No stashed prompts.</p>}
          </div>
        </MenuShell>
      )}

      {openMenu === "effort" && efforts.length > 0 && (
        <MenuShell placement={placement} maxHeight={menuMax} right={menuPos.right} width={MENU_W.effort}>
          <div ref={menuRef} role="menu" id={`${uid}-effort`} aria-label="Reasoning effort" onKeyDown={moveFocus}>
            <MenuLabel>Reasoning effort</MenuLabel>
            {[{ key: "", name: "Default", desc: defaultEffort ? `Profile default: ${effortLabel(agent, defaultEffort) ?? defaultEffort}` : `${agentLabel} decides` }, ...efforts].map((o) => {
              const on = o.key === effort;
              return (
                <button
                  key={o.key || "default"}
                  type="button"
                  role="menuitemradio"
                  aria-checked={on}
                  onClick={() => {
                    onEffortChange?.(o.key);
                    closeMenu(true);
                  }}
                  className={menuRow}
                >
                  <span className="shrink-0">{o.name}</span>
                  <span className="ml-auto min-w-0 truncate text-[12px] text-ink-3">{o.desc}</span>
                  <Check width={15} height={15} strokeWidth={2.2} className={`shrink-0 text-ink ${on ? "" : "invisible"}`} aria-hidden />
                </button>
              );
            })}
          </div>
        </MenuShell>
      )}

      {openMenu === "pick" && (
        <MenuShell placement={placement} maxHeight={menuMax} right={menuPos.right} width={MENU_W.pick}>
          <div ref={menuRef} role="menu" id={`${uid}-pick`} aria-label={pickable ? "Agent, model and approvals" : "Model and approvals"} onKeyDown={moveFocus}>
            {pickable ? (
              <>
                <div role="group" aria-label="Claude">
                  <MenuLabel>Claude</MenuLabel>
                  {(agent === "claude" ? models : MODELS).map((m, _i, list) =>
                    modelRow(m, list, agent === "claude" && modelOn(m.key, list), () => {
                      if (agent !== "claude") onAgentChange("claude");
                      onModelChange(m.key);
                      closeMenu(true);
                    }),
                  )}
                </div>
                {agents.some((a) => a.id !== "claude") && (
                  <div role="group" aria-label="Other agents">
                    <MenuLabel>Other agents</MenuLabel>
                    {agents
                      .filter((a) => a.id !== "claude")
                      .map((a) => (
                        <button
                          key={a.id}
                          type="button"
                          role="menuitemradio"
                          aria-checked={agent === a.id}
                          disabled={!a.installed}
                          title={a.installed ? undefined : `${a.label} isn't installed on the server`}
                          onClick={() => {
                            onAgentChange(a.id);
                            closeMenu(true);
                          }}
                          className={menuRow}
                        >
                          <span className={a.installed ? "" : "text-ink-3"}>{a.label}</span>
                          {!a.installed && <span className="ml-auto text-[12px] text-ink-3">Not installed</span>}
                          {agent === a.id && <Check width={15} height={15} strokeWidth={2.2} className="ml-auto shrink-0 text-ink" aria-hidden />}
                        </button>
                      ))}
                  </div>
                )}
                {agent !== "claude" && (
                  <div role="group" aria-label={`${agentLabel} model`}>
                    <MenuLabel>{`${agentLabel} model`}</MenuLabel>
                    {modelList}
                    {otherModelRow}
                  </div>
                )}
              </>
            ) : (
              <div role="group" aria-label="Model">
                <MenuLabel>Model</MenuLabel>
                {modelList}
                {otherModelRow}
              </div>
            )}
            {profileChoices.length > 1 && (
              <div role="group" aria-label="Account or backend">
                <MenuLabel>Account or backend</MenuLabel>
                {profileChoices.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={p.id === profile}
                    disabled={!p.installed}
                    title={p.installed ? p.notes || undefined : `${p.bin || p.label} isn't installed on the server`}
                    onClick={() => {
                      onProfileChange?.(p.id);
                      closeMenu(true);
                    }}
                    className={menuRow}
                  >
                    <span className={`min-w-0 truncate ${p.installed ? "" : "text-ink-3"}`}>{p.label}</span>
                    {!p.installed && <span className="ml-auto text-[12px] text-ink-3">Not installed</span>}
                    {p.id === profile && <Check width={15} height={15} strokeWidth={2.2} className="ml-auto shrink-0 text-ink" aria-hidden />}
                  </button>
                ))}
              </div>
            )}
            <div role="separator" className="mx-2.5 my-1 h-px bg-line" />
            <div role="group" aria-label="Approvals" className="px-1.5 pb-1.5">
              <p role="presentation" className="px-1 pt-1.5 pb-1.5 text-[11.5px] font-medium text-ink-3">
                Approvals
              </p>
              <div className="grid grid-cols-4 gap-0.5 rounded-[8px] bg-inset p-0.5 shadow-hairline">
                {MODES.map((m) => {
                  const on = m.key === mode;
                  return (
                    <button
                      key={m.key}
                      type="button"
                      role="menuitemradio"
                      aria-checked={on}
                      aria-label={m.name}
                      title={m.desc}
                      onClick={() => onModeChange(m.key)}
                      className={`h-9 rounded-[6px] text-[12.5px] font-medium outline-none transition-[background-color,color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-7 sm:text-[12px] ${
                        on ? `bg-surface shadow-btn ${m.key === "bypassPermissions" ? "text-orange-ink" : "text-ink"}` : "text-ink-3 hover:text-ink-2"
                      }`}
                    >
                      {MODE_SEG[m.key]}
                    </button>
                  );
                })}
              </div>
              <p className="px-1 pt-1.5 text-[12px] leading-4 text-ink-3">{currentMode.desc}</p>
            </div>
          </div>
        </MenuShell>
      )}

      <div
        className={`composer-pill composer-grid relative px-2.5 py-2.5 ${dragging ? "ring-2 ring-accent/50" : ""}`}
        data-stacked={stacked || undefined}
        data-invalid={folderInvalid || undefined}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(e) => {
          setDragging(false);
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          addFiles(e.dataTransfer.files);
        }}
      >
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        {(notice || (suggestion && !draft) || hasFiles || fileNote) && (
          <div className="flex min-w-0 flex-col gap-1 px-1 pb-1 [grid-area:header]">
            {notice}
            <AttachmentChips items={files.items} onRemove={files.remove} onRetry={(id) => void files.retry(id)} />
            {fileNote && (
              <p role="status" className="text-[12px] text-ink-3">
                {fileNote}
              </p>
            )}
            {suggestion && !draft && !hasFiles && (
              <button
                type="button"
                onClick={() => {
                  setDraft(suggestion);
                  inputRef.current?.focus();
                }}
                className="flex w-full min-w-0 items-center gap-2 rounded-[12px] px-1 pt-0.5 text-left text-[12.5px] text-ink-3 hover:text-ink-2"
                title="Use this suggestion (Tab)"
              >
                <span className="shrink-0 rounded-[5px] bg-inset px-1.5 py-px font-mono text-[10.5px] shadow-hairline">Tab</span>
                <span className="min-w-0 truncate">{suggestion}</span>
              </button>
            )}
          </div>
        )}

        <div className="flex min-w-0 items-center gap-0.5 [grid-area:lead]">
          <button
            ref={plusRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={openMenu === "plus"}
            aria-controls={openMenu === "plus" ? `${uid}-plus` : undefined}
            aria-label="Add files, folder or command, or stash the prompt"
            title="Add"
            onClick={() => toggleMenu("plus")}
            className={`${ghost} size-9 ${openMenu === "plus" ? "bg-hover text-ink" : ""}`}
          >
            <Plus width={20} height={20} strokeWidth={1.7} />
          </button>
          {folder !== undefined && (
            <button
              type="button"
              onClick={onPickFolder}
              title={folder || "Choose a folder"}
              aria-label={folder ? `Folder: ${folder}. Change folder` : "Choose a folder"}
              aria-haspopup="dialog"
              aria-invalid={folderInvalid || undefined}
              className={`tap relative flex h-9 min-w-0 max-w-[11rem] items-center gap-1.5 rounded-full px-2.5 text-[13px] transition-[background-color,color] duration-150 sm:max-w-[13rem] ${
                folderInvalid ? "bg-red-tint text-red-ink" : folder ? "text-ink-2 hover:bg-hover hover:text-ink" : "text-ink-3 hover:bg-hover hover:text-ink-2"
              }`}
            >
              <Folder width={15} height={15} strokeWidth={1.8} className="shrink-0" aria-hidden />
              <span className="min-w-0 truncate" translate="no">
                {folder ? folder.replace(/\/+$/, "").split("/").pop() || "/" : "Folder"}
              </span>
            </button>
          )}
        </div>

        <textarea
          ref={inputRef}
          rows={1}
          value={draft}
          readOnly={Boolean(busy)}
          onChange={(e) => {
            setDraft(e.target.value);
            setCaret(e.target.selectionStart);
            setSlashHidden(false);
            if (menu) setMenu(null);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onPaste={(e) => {
            const pasted = [...e.clipboardData.files];
            if (!pasted.length) return;
            /* a copied image often comes with its file name as text; keep only the file */
            e.preventDefault();
            addFiles(pasted);
          }}
          onKeyDown={(e) => {
            /* the keys belong to the input method while it composes (Enter picks a candidate) */
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            /* Mod+S puts the draft aside instead of saving the page */
            if (hasMod(e) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
              e.preventDefault();
              stashDraft();
              return;
            }
            /* Enter waits for the list instead of sending a half-typed path */
            if (mentionOpen && !found.files.length && found.loading && e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
              e.preventDefault();
              return;
            }
            if (mentionOpen && found.files.length) {
              const n = found.files.length;
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => (a + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey)) {
                e.preventDefault();
                pickMention(found.files[Math.min(active, n - 1)]);
                return;
              }
            }
            if (slashOpen && commands.length) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => (a + (e.key === "ArrowDown" ? 1 : commands.length - 1)) % commands.length);
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && (forcedSlash || !draft.includes(" ")))) {
                e.preventDefault();
                pickCommand(commands[active].name);
                return;
              }
            }
            if (e.key === "Tab" && !draft && suggestion && !e.shiftKey) {
              e.preventDefault();
              setDraft(suggestion);
              return;
            }
            /* Ctrl/Cmd+Enter sends; plain Enter too when the setting is on, on a desktop keyboard */
            if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
              if (e.ctrlKey || e.metaKey || (sendWithEnter && window.matchMedia("(pointer: fine)").matches)) {
                e.preventDefault();
                recall.current = null;
                void send();
                return;
              }
            }
            /* Esc stops a running turn when there's nothing typed */
            if (e.key === "Escape" && running && onStop && !draft && !openMenu && !e.defaultPrevented && !modalOpen()) {
              e.preventDefault();
              onStop();
              return;
            }
            /* Arrow Up in an empty box (or while stepping back) recalls earlier messages; Down goes forward */
            const el = e.currentTarget;
            if ((e.key === "ArrowUp" || e.key === "ArrowDown") && history?.length && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
              const stepping = recall.current !== null && draft === history[recall.current];
              const collapsed = el.selectionStart === el.selectionEnd;
              /* in a multi-line message the arrows move the caret until it reaches the first or last line */
              if (e.key === "ArrowUp" && (!draft || stepping) && collapsed && onFirstLine(draft, el.selectionStart)) {
                const next = recall.current === null || !stepping ? history.length - 1 : Math.max(0, recall.current - 1);
                e.preventDefault();
                recall.current = next;
                setDraft(history[next]);
                return;
              }
              if (e.key === "ArrowDown" && stepping && recall.current !== null && collapsed && onLastLine(draft, el.selectionEnd)) {
                e.preventDefault();
                const next = recall.current + 1;
                recall.current = next < history.length ? next : null;
                setDraft(next < history.length ? history[next] : "");
                return;
              }
            }
          }}
          placeholder={busy ? busyLabel : placeholder}
          aria-label="Message"
          aria-busy={Boolean(busy) || undefined}
          aria-controls={slashOpen ? `${uid}-slash` : mentionOpen ? `${uid}-files` : undefined}
          aria-activedescendant={slashOpen && commands.length ? `${uid}-cmd-${active}` : mentionOpen && found.files.length ? `${uid}-file-${Math.min(active, found.files.length - 1)}` : undefined}
          aria-autocomplete="list"
          enterKeyHint="enter"
          className={`composer-input w-full min-w-0 resize-none bg-transparent px-2 py-1.5 text-[16px] leading-6 text-ink outline-none [grid-area:primary] [overflow-wrap:anywhere] sm:text-[15px] sm:pointer-coarse:text-[16px] ${
            busy ? "placeholder:text-ink-2 composer-busy" : "placeholder:text-ink-3"
          }`}
        />

        <div className="flex min-w-0 items-center justify-end gap-1 [grid-area:trail]">
          <button
            ref={pickRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={openMenu === "pick"}
            aria-controls={openMenu === "pick" ? `${uid}-pick` : undefined}
            aria-label={`${pickable ? `Agent: ${agentLabel}, model` : "Model"}: ${modelName(model)}. Approvals: ${currentMode.name}`}
            title={`Approvals: ${currentMode.name}`}
            onClick={() => toggleMenu("pick")}
            onKeyDown={(e) => {
              if ((e.key === "ArrowUp" || e.key === "ArrowDown") && menu !== "pick") {
                e.preventDefault();
                toggleMenu("pick");
              }
            }}
            className={`tap relative flex h-9 min-w-0 items-center gap-1 rounded-full pr-2 pl-2.5 text-[13px] transition-[background-color,color] duration-150 ${
              openMenu === "pick" ? "bg-hover text-ink" : "text-ink-2 hover:bg-hover hover:text-ink"
            }`}
          >
            {mode === "bypassPermissions" && <ShieldAlert width={14} height={14} strokeWidth={1.9} className="shrink-0 text-orange-ink" aria-hidden />}
            {mode === "acceptEdits" && <ShieldCheck width={14} height={14} strokeWidth={1.9} className="shrink-0 text-ink-3" aria-hidden />}
            {mode === "plan" && <span className="shrink-0 rounded-[5px] bg-accent-tint px-1.5 py-px text-[11px] font-medium text-accent-ink">Plan</span>}
            <span className="min-w-0 truncate whitespace-nowrap">{pickText}</span>
            <NavArrowDown width={12} height={12} strokeWidth={2.2} className={`shrink-0 text-ink-3 transition-transform duration-200 ${openMenu === "pick" ? "rotate-180" : ""}`} aria-hidden />
          </button>
          {efforts.length > 0 && (
            <button
              ref={effortRef}
              type="button"
              aria-haspopup="menu"
              aria-expanded={openMenu === "effort"}
              aria-controls={openMenu === "effort" ? `${uid}-effort` : undefined}
              aria-label={`Reasoning effort: ${effortName ?? "Default"}`}
              title={`Reasoning effort: ${effortName ?? "Default"}`}
              onClick={() => toggleMenu("effort")}
              onKeyDown={(e) => {
                if ((e.key === "ArrowUp" || e.key === "ArrowDown") && menu !== "effort") {
                  e.preventDefault();
                  toggleMenu("effort");
                }
              }}
              className={`tap relative flex h-9 shrink-0 items-center gap-1 rounded-full px-2 text-[13px] transition-[background-color,color] duration-150 ${
                openMenu === "effort" ? "bg-hover text-ink" : effortName ? "text-ink-2 hover:bg-hover hover:text-ink" : "text-ink-3 hover:bg-hover hover:text-ink-2"
              }`}
            >
              <Brain width={15} height={15} strokeWidth={1.8} className="shrink-0" aria-hidden />
              {effortName && <span className="whitespace-nowrap">{effortName}</span>}
            </button>
          )}
          <ContextRing usage={usage} costUsd={costUsd} cost={cost} />
          {/* with nothing to send, Stop takes Send's place; next to Send it keeps its distance so a near miss doesn't interrupt */}
          {running && onStop && (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop"
              title="Stop"
              className={stopFirst ? "tap relative flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground active:scale-[0.92]" : `${ghost} mr-2 size-9 shadow-btn active:scale-[0.94]`}
            >
              <span className="size-2.5 rounded-[2px] bg-current" />
            </button>
          )}
          {!stopFirst && (
            <button
              type="button"
              aria-label={sending ? "Sending…" : files.uploading ? "Uploading…" : "Send"}
              title={files.uploading ? "Uploading…" : files.failed ? "Fix the failed upload first" : `Send (${sendWithEnter ? "Enter" : comboFor("send")})`}
              disabled={!canSend}
              onClick={() => void send()}
              className="composer-send tap relative flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-[background-color,color,transform] duration-200 enabled:hover:bg-primary-hover enabled:active:scale-[0.92] disabled:bg-field disabled:text-ink-3"
            >
              {sending ? <span aria-hidden className="composer-spinner size-4 rounded-full border-2 border-current border-r-transparent" /> : <ArrowUp width={18} height={18} strokeWidth={2.2} />}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
