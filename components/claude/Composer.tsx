"use client";

import { useDefaultEffort, useSetting } from "@/lib/client/settings";
import { comboFor, isCommand, isMac, modalOpen } from "@/lib/client/shortcuts";
import { onFirstLine, onLastLine } from "@/lib/client/caret";
import { composing, enterAction, enterSends, sendHint, type KeyLike } from "@/lib/client/composer-keys";
import { lineCount, pasteAction, pasteFile } from "@/lib/client/composer-paste";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Archive, ArrowUp, Attachment, Brain, Check, Folder, Map as PlanIcon, NavArrowDown, Plus, ShieldAlert, ShieldCheck, ShieldQuestion, Trash, Xmark } from "iconoir-react";
import { APP_COMMANDS, rankCommands, type SlashItem } from "@/lib/commands";
import { ContextRing, type ContextUsage } from "./ContextRing";
import { confirmAsk, promptAsk } from "./Ask";
import { AgentIcon } from "./AgentIcon";
import { chipModel } from "@/lib/model-chip";
import { useMediaQuery } from "@/lib/client/media";
import type { SessionCost } from "@/lib/client/usage";
import { shortPath, timeAgo } from "@/lib/client/api";
import { load, save } from "@/lib/client/storage";
import { AGENT_LABEL, type AgentId, type PermissionMode, type ProfileInfo } from "@/lib/types";
import { withAttachments } from "@/lib/attachments";
import { AttachmentChips, useAttachments } from "./Attachments";
import { effortLabel, effortOptions } from "@/lib/agent-traits";
import { insertMention, mentionAt } from "@/lib/client/mentions";
import { useFileSearch } from "@/lib/client/useFileSearch";
import { arrangeModels } from "@/lib/model-prefs";
import { ModelMarks } from "./ModelMarks";
import { dropStash, loadStash, pushStash, stashTitle, type Stash } from "@/lib/client/stash";
import { useSharedDraft } from "@/lib/client/share";
import { MODELS, MODES, modelLabel } from "@/lib/composer-options";

/* The composer: a two-row card. The text on top; under it a footer with the "+" menu, the agent and model,
 * effort and approvals chips on the left, and context use plus Send (or Stop) on the right. A quiet strip
 * under the card holds the folder, branch and the send shortcut. */

export { MODELS, MODES, modelLabel };

const MODE_ICON: Record<PermissionMode, typeof ShieldCheck> = { default: ShieldQuestion, acceptEdits: ShieldCheck, plan: PlanIcon, bypassPermissions: ShieldAlert };

export type AgentOption = { id: AgentId; label: string; installed: boolean };

type Menu = "slash" | "mention" | "pick" | "plus" | "stash" | "effort" | "mode" | null;

const KIND_LABEL: Record<SlashItem["kind"], string> = { app: "This app", builtin: "Claude Code", command: "Your commands", skill: "Skills" };

const MENU_W = { pick: 272, plus: 248, effort: 280, mode: 288 };

/* the textarea's line height and vertical padding, for the height cap */
const LINE_PX = 24;
const PAD_PX = 18;

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
    <p role="presentation" className="px-2.5 pt-2 pb-1 text-xs font-medium text-ink-3">
      {children}
    </p>
  );
}

const menuRowBase =
  "flex w-full min-w-0 items-center gap-2.5 rounded-[8px] px-2.5 text-left text-sm text-ink transition-colors duration-75 outline-none hover:bg-hover focus-visible:bg-hover disabled:cursor-default disabled:hover:bg-transparent";
const menuRow = `${menuRowBase} h-10 sm:h-8`;

const ghost = "tap relative flex shrink-0 items-center justify-center rounded-full text-ink-2 transition-[background-color,color] duration-150 hover:bg-hover hover:text-ink";

/* footer chips: 32px with a mouse, 44px on touch */
const chip =
  "tap relative flex h-8 min-w-0 shrink-0 items-center gap-1.5 rounded-lg px-2 text-sm transition-[background-color,color] duration-150 pointer-coarse:h-11 pointer-coarse:px-2.5";
const chipOff = "text-ink-2 hover:bg-hover hover:text-ink";
const chipOn = "bg-hover text-ink";

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
  context,
  contextEnd,
  note = null,
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
  /** the strip under the card, after the folder chip (branch, worktree toggle) */
  context?: React.ReactNode;
  /** the strip's right end, before the send shortcut hint */
  contextEnd?: React.ReactNode;
  /** the box takes a note instead of a message (a reason for denying); the draft waits until it's done */
  note?: { label: string; placeholder: string; onSend: (text: string) => Promise<boolean>; onCancel: () => void } | null;
}) {
  const [draft, setDraft] = useState("");
  const [caret, setCaret] = useState(0);
  /* where the caret goes once a picked path is in the box */
  const caretAfter = useRef<number | null>(null);
  const [sendShortcut] = useSetting("sendShortcut");
  const [busySend] = useSetting("busySend");
  const [spellCheck] = useSetting("spellCheck");
  const [phoneAutocorrect] = useSetting("phoneAutocorrect");
  const [maxLines] = useSetting("composerMaxLines");
  const [rememberDrafts] = useSetting("rememberDrafts");
  const [longPaste] = useSetting("longPaste");
  const [longPasteLines] = useSetting("longPasteLines");
  const settingsEffort = useDefaultEffort(agent);
  const touch = !useMediaQuery("(pointer: fine)");
  const [mac, setMac] = useState(false);
  useEffect(() => setMac(isMac()), []);
  /* a paste over the limit went into this draft (Long pastes: Ask before sending) */
  const pastedLong = useRef(false);
  /* index into `history` while stepping through it with the arrows; null when not recalling */
  const recall = useRef<number | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [slashHidden, setSlashHidden] = useState(false);
  const [menuPos, setMenuPos] = useState<{ left?: number; right?: number }>({});
  const [placement, setPlacement] = useState<"up" | "down">("up");
  const [menuMax, setMenuMax] = useState(416);
  const [active, setActive] = useState(0);
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /* the card and its menus, without the strip under it: menus open from its edges */
  const boxRef = useRef<HTMLDivElement>(null);
  const pickRef = useRef<HTMLButtonElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  const effortRef = useRef<HTMLButtonElement>(null);
  const modeRef = useRef<HTMLButtonElement>(null);
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

  /* drafts survive reloads and switching sessions (Settings > Composer > Remember drafts) */
  const keepDrafts = useRef(rememberDrafts);
  keepDrafts.current = rememberDrafts;
  useEffect(() => {
    setDraft(keepDrafts.current ? (load(`draft:${draftKey}`) ?? "") : "");
    pastedLong.current = false;
  }, [draftKey]);
  useEffect(() => {
    if (!note) save(`draft:${draftKey}`, rememberDrafts ? draft || null : null);
    if (!draft) pastedLong.current = false;
  }, [draft, draftKey, rememberDrafts, note]);
  /* a note gets an empty box; the message draft comes back when it's sent or cancelled */
  const noting = Boolean(note);
  const heldDraft = useRef<string | null>(null);
  useEffect(() => {
    if (noting) {
      heldDraft.current = draft;
      setDraft("");
      inputRef.current?.focus();
    } else if (heldDraft.current !== null) {
      setDraft(heldDraft.current);
      heldDraft.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noting]);

  useEffect(() => {
    if (autoFocus && window.matchMedia("(pointer: fine)").matches) inputRef.current?.focus();
  }, [autoFocus, draftKey]);
  /* shared from another app (lib/client/share.ts): a new session starts with it */
  useSharedDraft(draftKey === "new", (s) => {
    if (s.text) setDraft((d) => (d.trim() ? `${d.replace(/\s+$/, "")}\n\n${s.text}` : s.text));
    files.restore(s.files);
  });

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const cap = maxLines * LINE_PX + PAD_PX;
    el.style.height = "0px";
    const h = el.scrollHeight;
    el.style.height = `${Math.min(Math.max(h, 44), cap)}px`;
    el.style.overflowY = h > cap ? "auto" : "hidden";
  }, [draft, maxLines]);

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
    const r = boxRef.current?.getBoundingClientRect();
    if (!r) return;
    const up = r.top > window.innerHeight - r.bottom;
    setPlacement(up ? "up" : "down");
    /* use the room there is (minus a margin), capped so long lists still scroll */
    setMenuMax(Math.max(160, Math.min(520, (up ? r.top : window.innerHeight - r.bottom) - 16)));
  }, [openMenu]);

  /* close on Escape, outside taps, or focus leaving the composer; return focus to the trigger */
  const [modelQ, setModelQ] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [favoriteModels] = useSetting("favoriteModels");
  const [hiddenModels] = useSetting("hiddenModels");
  useEffect(() => {
    if (openMenu !== "pick") setModelQ("");
  }, [openMenu]);

  const closeMenu = useCallback(
    (refocus: boolean) => {
      const trigger =
        menu === "pick" ? pickRef.current : menu === "plus" || menu === "stash" ? plusRef.current : menu === "effort" ? effortRef.current : menu === "mode" ? modeRef.current : inputRef.current;
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
    if (menu !== "pick" && menu !== "plus" && menu !== "stash" && menu !== "effort" && menu !== "mode") return;
    const root = menuRef.current;
    const el = (menu !== "plus" ? root?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]') : null) ?? root?.querySelector<HTMLElement>(ITEM_SELECTOR);
    el?.focus({ preventScroll: true });
  }, [menu]);

  const toggleMenu = (which: "pick" | "plus" | "effort" | "mode") => {
    if (menu === which || (which === "plus" && menu === "stash")) return closeMenu(false);
    if (which === "plus") setStashes(loadStash(root));
    const box = boxRef.current?.getBoundingClientRect();
    const trigger = { pick: pickRef, effort: effortRef, mode: modeRef, plus: plusRef }[which].current?.getBoundingClientRect();
    if (box && trigger) {
      const w = Math.min(MENU_W[which], box.width);
      setMenuPos({ left: Math.max(0, Math.min(trigger.left - box.left - 4, box.width - w)) });
    }
    setMenu(which);
  };

  const hasFiles = files.items.length > 0;
  const canSend = (draft.trim().length > 0 || hasFiles) && !sending && !files.uploading && !files.failed;
  const stopFirst = Boolean(running && onStop && !draft.trim() && !hasFiles && !sending);
  /* Settings > Composer: a send while the agent works stops the turn first */
  const interrupts = Boolean(running && busySend === "interrupt");
  const send = async () => {
    if (!canSend) return;
    const typed = draft.trim();
    const text = withAttachments(typed, files.paths);
    const app = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(text);
    if (app && !note && !hasFiles && onAppCommand && APP_COMMANDS.some((c) => c.name === app[1]) && onAppCommand(app[1], (app[2] ?? "").trim())) {
      setDraft("");
      return;
    }
    const lines = lineCount(typed);
    if (longPaste === "confirm" && pastedLong.current && lines > longPasteLines) {
      const go = await confirmAsk({ title: `Send ${lines} lines?`, body: "This message has a long paste in it.", confirm: "Send" });
      if (!go) return inputRef.current?.focus();
    }
    setSending(true);
    setDraft("");
    const ok = await (note ? note.onSend : onSend)(text).catch(() => false);
    if (!ok) setDraft(typed);
    else {
      files.clear();
      pastedLong.current = false;
    }
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
  /* a session's own effort, else the profile's default, else the one in Settings > Composer */
  const fallbackEffort = defaultEffort || settingsEffort || null;
  const effortName = effortLabel(agent, effort || fallbackEffort);
  const slashOpen = openMenu === "slash";
  const mentionOpen = openMenu === "mention";
  /* with `agents` (even while it loads) the agent is choosable; the Claude section is always there */
  const pickable = agents && onAgentChange;
  const agentLabel = agents?.find((a) => a.id === agent)?.label ?? AGENT_LABEL[agent];
  const modelName = (m: string | null) => (m && models.find((x) => x.key === m)?.name) || modelLabel(m);
  const modelOn = (key: string, list: { key: string }[]) => key === (model && list.some((x) => x.key === model) ? model : "");
  const busy = sending && busyLabel;
  const profileChoices = onProfileChange ? (profiles ?? []).filter((p) => p.agent === agent && !p.hidden) : [];
  const profileOn = profileChoices.find((p) => p.id === profile);
  /* "Default" is never the label: name the model the server will pick (the profile's), else the one the session last
   * reported using, else the agent */
  const activeProfile = (profiles ?? []).find((p) => p.id === (profile ?? agent));
  const defaultModel = activeProfile?.defaultModel || activeProfile?.models[0] || null;
  const shownModel = chipModel(model, activeProfile, usage?.model).model;
  const profilePrefix = profileOn && profileChoices.length > 1 && profileOn.id !== agent ? profileOn.label : null;
  const pickText = profilePrefix ? (shownModel ? `${profilePrefix} · ${modelName(shownModel)}` : profilePrefix) : shownModel ? modelName(shownModel) : agentLabel;
  const ModeIcon = MODE_ICON[mode];
  const hint = sendHint(sendShortcut, touch, mac);

  const modelRow = (m: { key: string; name: string }, list: { key: string }[], on: boolean, onPick: () => void) => {
    /* the Default row says what it resolves to */
    const hint = m.key !== "" ? null : model && !list.some((x) => x.key === model) ? modelName(model) : m.name === "Default" ? (defaultModel ? modelName(defaultModel) : null) : null;
    const row = (
      <button key={m.key || "default"} type="button" role="menuitemradio" aria-checked={on} onClick={onPick} className={menuRow}>
        <span className="min-w-0 truncate">{m.name}</span>
        {hint && <span className="truncate text-xs text-ink-3">{hint}</span>}
        {on && <Check width={15} height={15} strokeWidth={2.2} className="ml-auto shrink-0 text-ink" aria-hidden />}
      </button>
    );
    return m.key === "" ? row : (
      <div key={m.key} className="group/model flex min-w-0 items-center">
        {row}
        <ModelMarks id={m.key} name={m.name} />
      </div>
    );
  };

  /* long CLI lists (Cursor has hundreds) get a filter; Default and the current model stay visible */
  const q = modelQ.trim().toLowerCase();
  const modelPrefs = { favorites: favoriteModels, hidden: hiddenModels };
  const arranged = arrangeModels(models, modelPrefs, { current: model, query: q, showHidden });
  const shownModels = arranged.rows;
  const showHiddenRow = arranged.hiddenCount > 0 && !q && (
    <button type="button" role="menuitem" onClick={() => setShowHidden((v) => !v)} className={`${menuRow} text-ink-3`}>
      {showHidden ? "Leave out hidden models" : `Show ${arranged.hiddenCount} hidden`}
    </button>
  );
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
            className="h-9 w-full rounded-[8px] bg-inset px-2.5 text-sm text-ink shadow-hairline outline-none placeholder:text-ink-3 focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-8"
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
          />
        </div>
      )}
      {/* long lists scroll on their own so the accounts below stay in reach */}
      <div className={models.length > 12 ? "max-h-[min(36dvh,300px)] overflow-y-auto overscroll-contain" : undefined}>
        {shownModels.map((m) =>
          modelRow(m, models, modelOn(m.key, models), () => {
            onModelChange(m.key);
            closeMenu(true);
          }),
        )}
        {q && shownModels.every((m) => m.key === "" || m.key === model) && <p className="px-2.5 py-1.5 text-sm text-ink-3">No models match.</p>}
        {showHiddenRow}
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
    <div ref={rootRef} className="w-full" data-composer>
      <div ref={boxRef} className="relative">
      {slashOpen && (
        <MenuShell placement={placement} maxHeight={Math.min(menuMax, 416)}>
          <div role="listbox" id={`${uid}-slash`} aria-label="Slash commands">
            {commands.map((c, i) => {
              const header = i === 0 || commands[i - 1].kind !== c.kind ? KIND_LABEL[c.kind] : null;
              return (
                <div key={`${c.kind}:${c.name}`}>
                  {header && !slashQuery && <p className="px-2.5 pt-2 pb-1 text-xs font-medium text-ink-3">{header}</p>}
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
                      <span className="shrink-0 font-mono text-sm text-ink" translate="no">
                        /{c.name}
                        {c.hint && <span className="text-ink-3"> {c.hint}</span>}
                      </span>
                      {c.description && <span className="min-w-0 truncate text-xs text-ink-3">{c.description}</span>}
                    </span>
                    {slashQuery ? <span className="shrink-0 text-2xs font-medium text-ink-3">{KIND_LABEL[c.kind]}</span> : null}
                  </button>
                </div>
              );
            })}
          </div>
          {commands.length === 0 && (
            <p className="px-2.5 py-2 text-sm text-ink-3">{allCommands.length ? `No command matches “${slashQuery}”.` : "Loading commands…"}</p>
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
                  <span className="shrink-0 truncate font-mono text-sm text-ink" translate="no">
                    {f.slice(cut + 1)}
                  </span>
                  {cut > 0 && (
                    /* rtl keeps the end of a long folder path in view; bdi keeps its characters in order */
                    <span className="min-w-0 truncate text-xs text-ink-3" translate="no" dir="rtl">
                      <bdi>{f.slice(0, cut)}</bdi>
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {found.files.length === 0 && (
            <p className="px-2.5 py-2 text-sm text-ink-3">
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
                  <span className="ml-auto min-w-0 truncate text-xs text-ink-3" translate="no">
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
              <span aria-hidden className="flex size-4 shrink-0 items-center justify-center font-mono text-base leading-none text-ink-2">
                /
              </span>
              <span>Commands</span>
              <span className="ml-auto text-xs text-ink-3">Type /</span>
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
              <span className="ml-auto text-xs text-ink-3 pointer-coarse:hidden">{comboFor("stash")}</span>
            </button>
            {stashes.length > 0 && (
              <button type="button" role="menuitem" aria-haspopup="menu" onClick={() => setMenu("stash")} className={menuRow}>
                <span aria-hidden className="size-4 shrink-0" />
                <span>Stashed prompts</span>
                <span className="ml-auto text-xs text-ink-3 tabular-nums">{stashes.length}</span>
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
                    <span className="shrink-0 text-xs text-ink-3 tabular-nums">{timeAgo(st.at)}</span>
                  </button>
                  <button type="button" role="menuitem" aria-label={`Delete stashed prompt: ${title}`} title="Delete" onClick={() => deleteStash(st.id)} className={`${ghost} size-10 rounded-[8px] sm:size-8`}>
                    <Trash width={15} height={15} strokeWidth={1.8} aria-hidden />
                  </button>
                </div>
              );
            })}
            {stashes.length === 0 && <p className="px-2.5 py-2 text-sm text-ink-3">No stashed prompts.</p>}
          </div>
        </MenuShell>
      )}

      {openMenu === "effort" && efforts.length > 0 && (
        <MenuShell placement={placement} maxHeight={menuMax} left={menuPos.left} width={MENU_W.effort}>
          <div ref={menuRef} role="menu" id={`${uid}-effort`} aria-label="Reasoning effort" onKeyDown={moveFocus}>
            <MenuLabel>Reasoning effort</MenuLabel>
            {[
              {
                key: "",
                name: "Default",
                desc: defaultEffort
                  ? `Profile default: ${effortLabel(agent, defaultEffort) ?? defaultEffort}`
                  : settingsEffort
                    ? `Your default: ${effortLabel(agent, settingsEffort) ?? settingsEffort}`
                    : `${agentLabel} decides`,
              },
              ...efforts,
            ].map((o) => {
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
                  <span className="ml-auto min-w-0 truncate text-xs text-ink-3">{o.desc}</span>
                  <Check width={15} height={15} strokeWidth={2.2} className={`shrink-0 text-ink ${on ? "" : "invisible"}`} aria-hidden />
                </button>
              );
            })}
          </div>
        </MenuShell>
      )}

      {openMenu === "pick" && (
        <MenuShell placement={placement} maxHeight={menuMax} left={menuPos.left} width={MENU_W.pick}>
          <div ref={menuRef} role="menu" id={`${uid}-pick`} aria-label={pickable ? "Agent and model" : "Model"} onKeyDown={moveFocus}>
            {pickable ? (
              <>
                <div role="group" aria-label="Claude">
                  <MenuLabel>Claude</MenuLabel>
                  {arrangeModels(agent === "claude" ? models : MODELS, modelPrefs, { current: agent === "claude" ? model : null, showHidden: true }).rows.map((m, _i, list) =>
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
                          {!a.installed && <span className="ml-auto text-xs text-ink-3">Not installed</span>}
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
                    {!p.installed && <span className="ml-auto text-xs text-ink-3">Not installed</span>}
                    {p.id === profile && <Check width={15} height={15} strokeWidth={2.2} className="ml-auto shrink-0 text-ink" aria-hidden />}
                  </button>
                ))}
              </div>
            )}
          </div>
        </MenuShell>
      )}

      {openMenu === "mode" && (
        <MenuShell placement={placement} maxHeight={menuMax} left={menuPos.left} width={MENU_W.mode}>
          <div ref={menuRef} role="menu" id={`${uid}-mode`} aria-label="Approvals" onKeyDown={moveFocus}>
            <MenuLabel>Approvals</MenuLabel>
            {MODES.map((m) => {
              const on = m.key === mode;
              const Icon = MODE_ICON[m.key];
              return (
                <button
                  key={m.key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={on}
                  onClick={() => {
                    onModeChange(m.key);
                    closeMenu(true);
                  }}
                  className={`${menuRowBase} min-h-12 py-1.5 sm:min-h-10`}
                >
                  <Icon width={16} height={16} strokeWidth={1.8} className={`shrink-0 ${m.key === "bypassPermissions" ? "text-orange-ink" : "text-ink-3"}`} aria-hidden />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{m.name}</span>
                    <span className="truncate text-xs text-ink-3">{m.desc}</span>
                  </span>
                  <Check width={15} height={15} strokeWidth={2.2} className={`shrink-0 text-ink ${on ? "" : "invisible"}`} aria-hidden />
                </button>
              );
            })}
          </div>
        </MenuShell>
      )}

      <div
        className={`composer-pill @container relative flex flex-col ${dragging ? "ring-2 ring-accent/50" : ""}`}
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
        {(notice || note || (suggestion && !draft) || hasFiles || fileNote) && (
          <div className="flex min-w-0 flex-col gap-1 px-3 pt-2.5">
            {notice}
            {note && (
              <span className="flex max-w-full min-w-0 items-center gap-1 self-start rounded-full bg-red-tint py-0.5 pr-0.5 pl-2.5 text-xs font-medium text-red-ink">
                <span className="min-w-0 truncate">{note.label}</span>
                <button type="button" onClick={note.onCancel} aria-label="Cancel note" title="Cancel (Esc)" className="tap relative grid size-5 shrink-0 place-items-center rounded-full transition-colors duration-150 hover:bg-red/15">
                  <Xmark width={12} height={12} strokeWidth={2.2} />
                </button>
              </span>
            )}
            <AttachmentChips items={files.items} onRemove={files.remove} onRetry={(id) => void files.retry(id)} />
            {fileNote && (
              <p role="status" className="px-1 text-xs text-ink-3">
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
                className="flex w-full min-w-0 items-center gap-2 rounded-[12px] px-1 pt-0.5 text-left text-sm text-ink-3 hover:text-ink-2"
                title="Use this suggestion (Tab)"
              >
                <span className="shrink-0 rounded-[5px] bg-inset px-1.5 py-px font-mono text-2xs shadow-hairline">Tab</span>
                <span className="min-w-0 truncate">{suggestion}</span>
              </button>
            )}
          </div>
        )}

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
            if (pasted.length) {
              /* a copied image often comes with its file name as text; keep only the file */
              e.preventDefault();
              addFiles(pasted);
              return;
            }
            const text = e.clipboardData.getData("text/plain");
            const act = pasteAction(text, longPaste, longPasteLines);
            if (act === "flag") pastedLong.current = true;
            if (act !== "attach") return;
            e.preventDefault();
            addFiles([pasteFile(text)]);
            setFileNote(`Pasted ${lineCount(text)} lines as a file.`);
          }}
          onKeyDown={(e) => {
            const key: KeyLike = { key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode };
            /* the keys belong to the input method while it composes (Enter picks a candidate) */
            if (composing(key)) return;
            /* Mod+S puts the draft aside instead of saving the page */
            if (isCommand(e.nativeEvent, "stash")) {
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
            /* Settings > Composer > Send with; read the pointer now, a keyboard can come and go */
            if (enterAction(key, sendShortcut, !window.matchMedia("(pointer: fine)").matches) === "send") {
              e.preventDefault();
              recall.current = null;
              void send();
              return;
            }
            if (note && e.key === "Escape" && !openMenu && !e.defaultPrevented) {
              e.preventDefault();
              note.onCancel();
              return;
            }
            /* Esc stops a running turn when there's nothing typed */
            if (isCommand(e.nativeEvent, "stop") && running && onStop && !draft && !openMenu && !e.defaultPrevented && !modalOpen()) {
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
          placeholder={busy ? busyLabel : (note?.placeholder ?? placeholder)}
          aria-label="Message"
          aria-busy={Boolean(busy) || undefined}
          aria-controls={slashOpen ? `${uid}-slash` : mentionOpen ? `${uid}-files` : undefined}
          aria-activedescendant={slashOpen && commands.length ? `${uid}-cmd-${active}` : mentionOpen && found.files.length ? `${uid}-file-${Math.min(active, found.files.length - 1)}` : undefined}
          aria-autocomplete="list"
          enterKeyHint={enterSends(sendShortcut, touch) ? "send" : "enter"}
          spellCheck={spellCheck}
          autoCorrect={phoneAutocorrect ? undefined : "off"}
          autoCapitalize={phoneAutocorrect ? undefined : "none"}
          className={`composer-input block min-h-[44px] w-full min-w-0 resize-none bg-transparent px-4 pb-1 text-[16px] leading-6 text-ink outline-none [overflow-wrap:anywhere] sm:text-base sm:pointer-coarse:text-[16px] ${
            busy ? "placeholder:text-ink-2 composer-busy" : "placeholder:text-ink-3"
          }`}
        />

        <div className="composer-footer flex min-w-0 items-center gap-1 px-2">
          <div className="flex min-w-0 flex-1 items-center gap-0.5">
            <button
              ref={plusRef}
              type="button"
              aria-haspopup="menu"
              aria-expanded={openMenu === "plus"}
              aria-controls={openMenu === "plus" ? `${uid}-plus` : undefined}
              aria-label="Add files, folder or command, or stash the prompt"
              title="Add"
              onClick={() => toggleMenu("plus")}
              className={`${ghost} size-8 rounded-lg pointer-coarse:size-11 ${openMenu === "plus" ? "bg-hover text-ink" : ""}`}
            >
              <Plus width={18} height={18} strokeWidth={1.8} />
            </button>
            <button
              ref={pickRef}
              type="button"
              aria-haspopup="menu"
              aria-expanded={openMenu === "pick"}
              aria-controls={openMenu === "pick" ? `${uid}-pick` : undefined}
              aria-label={`${pickable ? `Agent: ${agentLabel}. Model` : "Model"}: ${pickText}`}
              title={pickable ? `${agentLabel}: ${pickText}` : pickText}
              onClick={() => toggleMenu("pick")}
              onKeyDown={(e) => {
                if ((e.key === "ArrowUp" || e.key === "ArrowDown") && menu !== "pick") {
                  e.preventDefault();
                  toggleMenu("pick");
                }
              }}
              className={`${chip} shrink ${openMenu === "pick" ? chipOn : chipOff}`}
            >
              <AgentIcon agent={agent} size={14} />
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
                className={`${chip} ${openMenu === "effort" ? chipOn : effortName ? chipOff : "text-ink-3 hover:bg-hover hover:text-ink-2"}`}
              >
                <Brain width={15} height={15} strokeWidth={1.8} className="shrink-0" aria-hidden />
                {effortName && <span className="whitespace-nowrap @max-[25rem]:sr-only">{effortName}</span>}
              </button>
            )}
            <button
              ref={modeRef}
              type="button"
              aria-haspopup="menu"
              aria-expanded={openMenu === "mode"}
              aria-controls={openMenu === "mode" ? `${uid}-mode` : undefined}
              aria-label={`Approvals: ${currentMode.name}`}
              title={`Approvals: ${currentMode.name}. ${currentMode.desc}`}
              onClick={() => toggleMenu("mode")}
              onKeyDown={(e) => {
                if ((e.key === "ArrowUp" || e.key === "ArrowDown") && menu !== "mode") {
                  e.preventDefault();
                  toggleMenu("mode");
                }
              }}
              className={`${chip} ${
                openMenu === "mode" ? chipOn : mode === "bypassPermissions" ? "text-orange-ink hover:bg-hover" : mode === "plan" ? "text-accent-ink hover:bg-hover" : chipOff
              }`}
            >
              <ModeIcon width={15} height={15} strokeWidth={1.8} className="shrink-0" aria-hidden />
              <span className="whitespace-nowrap @max-[25rem]:sr-only">{currentMode.short}</span>
            </button>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <ContextRing usage={usage} costUsd={costUsd} cost={cost} />
            {/* with nothing to send, Stop takes Send's place; next to Send it keeps its distance so a near miss doesn't interrupt */}
            {running && onStop && (
              <button
                type="button"
                onClick={onStop}
                aria-label="Stop"
                title="Stop (Esc)"
                className={
                  stopFirst
                    ? "tap relative flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-[background-color,transform] duration-150 hover:bg-primary-hover active:scale-[0.92] pointer-coarse:size-9"
                    : `${ghost} mr-2 size-8 shadow-btn active:scale-[0.94] pointer-coarse:size-9`
                }
              >
                <span className="size-2.5 rounded-[2px] bg-current" />
              </button>
            )}
            {!stopFirst && (
              <button
                type="button"
                aria-label={sending ? "Sending…" : files.uploading ? "Uploading…" : interrupts ? "Stop and send" : "Send"}
                title={files.uploading ? "Uploading…" : files.failed ? "Fix the failed upload first" : `${interrupts ? "Stop and send" : "Send"} (${enterSends(sendShortcut, touch) ? "Enter" : comboFor("send")})`}
                disabled={!canSend}
                onClick={() => void send()}
                className="composer-send tap relative flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-[background-color,opacity,transform] duration-200 enabled:hover:bg-primary-hover enabled:active:scale-[0.92] disabled:opacity-35 pointer-coarse:size-9"
              >
                {sending ? <span aria-hidden className="composer-spinner size-4 rounded-full border-2 border-current border-r-transparent" /> : <ArrowUp width={16} height={16} strokeWidth={2} />}
              </button>
            )}
          </div>
        </div>
      </div>
      </div>

      <div className="flex min-h-6 min-w-0 items-center gap-3 px-2 pt-2 text-xs text-ink-3">
        {folder !== undefined && (
          <button
            type="button"
            onClick={onPickFolder}
            title={folder || "Choose a folder"}
            aria-label={folder ? `Folder: ${folder}. Change folder` : "Choose a folder"}
            aria-haspopup="dialog"
            aria-invalid={folderInvalid || undefined}
            className={`tap relative -mx-1 flex h-6 min-w-0 max-w-[14rem] items-center gap-1.5 rounded-md px-1 transition-colors duration-150 ${
              folderInvalid ? "bg-red-tint text-red-ink" : folder ? "text-ink-2 hover:text-ink" : "text-ink-3 hover:text-ink-2"
            }`}
          >
            <Folder width={14} height={14} strokeWidth={1.8} className="shrink-0" aria-hidden />
            <span className="min-w-0 truncate" translate="no">
              {folder ? folder.replace(/\/+$/, "").split("/").pop() || "/" : "Choose a folder"}
            </span>
          </button>
        )}
        {context}
        <span className="ml-auto" />
        {contextEnd}
        {hint && <span className="shrink-0 whitespace-nowrap max-sm:hidden">{hint}</span>}
      </div>
    </div>
  );
}
