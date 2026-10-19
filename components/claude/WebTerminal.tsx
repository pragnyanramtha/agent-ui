"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Collapse, Expand, Xmark } from "iconoir-react";
import "@xterm/xterm/css/xterm.css";
import { api } from "@/lib/client/api";
import { comboFor, hasMod, isMac, keyLabels } from "@/lib/client/shortcuts";
import { fenceBlock, sendToComposer } from "@/lib/client/composer-insert";
import { isDarkColor, oscColor, readTerminalTheme } from "@/lib/client/terminal-theme";
import { TerminalMenu, type TerminalAction } from "./TerminalMenu";
import { TerminalFind } from "./TerminalFind";
import { OPEN_FILES_EVENT } from "./FilesScreen";
import { findPathLinks, resolveTerminalPath } from "@/lib/client/terminal-links";
import { deviceBoxTrusted } from "@/lib/client/terminal-render";

/** What to open: a kept terminal (`term`), a tmux session, a CLI's multiplexer (`pid`/`session`), or a new shell (`cwd`). */
export type TerminalTarget = { term?: string; tmux?: string; session?: string; pid?: number; cwd?: string; label: string; newTab?: boolean };

/** What a terminal tab shows about itself */
export type TerminalInfo = { label: string; conn: Conn; id: string | null; kind: string | null; cwd: string | null };

type Conn = "connecting" | "open" | "reconnecting" | "ended";

/* keys phones don't have; sent as raw terminal sequences. "ctrl"/"alt" arm a modifier for the next key. */
const KEYS: [string, string][] = [
  ["Esc", "\x1b"],
  ["^C", "\x03"],
  ["Tab", "\t"],
  ["↑", "\x1b[A"],
  ["↓", "\x1b[B"],
  ["Enter", "\r"],
  ["Ctrl", "ctrl"],
  ["←", "\x1b[D"],
  ["→", "\x1b[C"],
  ["⇧Tab", "\x1b[Z"],
  ["Alt", "alt"],
  ["^D", "\x04"],
  ["^R", "\x12"],
  ["Home", "\x1b[H"],
  ["End", "\x1b[F"],
  ["PgUp", "\x1b[5~"],
  ["PgDn", "\x1b[6~"],
  ["|", "|"],
  ["/", "/"],
  ["~", "~"],
  ["-", "-"],
];

const SIZE_KEY = "cui:term-font";
const DOCK_KEY = "cui:term-dock-height";
const DOCK_MIN = 140;
const DOCK_DEFAULT = 320;
const NERD = '"Symbols Nerd Font Mono"';

const LONG_PRESS_MS = 500;

/* a buffer line's text with each character's cell column, so wide characters don't shift link ranges */
function lineCells(line: import("@xterm/xterm").IBufferLine) {
  let text = "";
  const cols: number[] = [];
  const widths: number[] = [];
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell) break;
    const w = cell.getWidth();
    if (!w) continue;
    const ch = cell.getChars() || " ";
    for (let i = 0; i < ch.length; i++) {
      cols.push(x);
      widths.push(w);
    }
    text += ch;
  }
  return { text, cols, widths };
}

/* whether a path is a file on the server, remembered per terminal */
function fileChecker() {
  const known = new Map<string, Promise<boolean>>();
  let home: Promise<string | null> | null = null;
  const get = (p: string) =>
    fetch(`/api/files?path=${encodeURIComponent(p)}`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ kind?: string; home?: string }>) : null))
      .catch(() => null);
  return {
    home: () => (home ??= get("/").then((d) => d?.home ?? null)),
    isFile: (p: string) => {
      let v = known.get(p);
      if (!v) {
        if (known.size > 500) known.clear();
        v = get(p).then((d) => d?.kind === "file");
        known.set(p, v);
      }
      return v;
    },
  };
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* plain http: no async clipboard */
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

const ctrlOf = (ch: string) => {
  const c = ch.toUpperCase().charCodeAt(0);
  if (c >= 64 && c <= 95) return String.fromCharCode(c - 64);
  if (ch === " ") return "\x00";
  return ch;
};

/**
 * A full interactive terminal: a shell on the server, an agent launched from the web,
 * or the zellij/tmux session a CLI session runs in (shared with your other clients).
 * Drops reconnect on their own: a kept terminal replays what was missed, an attach redraws.
 * Full screen on phones, a large sheet on desktop.
 */
export function WebTerminal({
  target,
  onClose,
  docked = false,
  hidden = false,
  onDock,
  tabs,
  onInfo,
  enter = true,
}: {
  target: TerminalTarget;
  onClose: () => void;
  /** a resizable panel at the bottom of the main column (desktop) instead of a sheet over the page */
  docked?: boolean;
  /** docked and folded away; the connection stays up */
  hidden?: boolean;
  onDock?: (docked: boolean) => void;
  /** the tab strip, shown in place of the label */
  tabs?: ReactNode;
  onInfo?: (info: TerminalInfo) => void;
  /** pop in when first shown (a sheet) */
  enter?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(DOCK_DEFAULT);
  useEffect(() => {
    const stored = Number(localStorage.getItem(DOCK_KEY));
    if (stored >= DOCK_MIN) setHeight(Math.max(DOCK_MIN, Math.min(stored, Math.round(window.innerHeight * 0.8))));
    /* tabs share the height: another tab may have been resized while this one was in the background */
  }, [hidden]);
  const [popped, setPopped] = useState(!enter);
  useEffect(() => {
    if (hidden || popped) return;
    const t = setTimeout(() => setPopped(true), 250);
    return () => clearTimeout(t);
  }, [hidden, popped]);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const [conn, setConn] = useState<Conn>("connecting");
  const [reason, setReason] = useState<string | null>(null);
  const [label, setLabel] = useState(target.label);
  const [attempt, setAttempt] = useState(0);
  const [mod, setMod] = useState<"ctrl" | "alt" | null>(null);
  const modRef = useRef(mod);
  modRef.current = mod;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [fontSize, setFontSize] = useState<number | null>(null);
  const [kind, setKind] = useState<string | null>(null);
  const [termId, setTermId] = useState<string | null>(target.term ?? null);
  const [cwd, setCwd] = useState<string | null>(target.cwd ?? null);
  const [output, setOutput] = useState(false);
  /* after a shell exits, "New shell" opens a fresh one in the same folder */
  const [fresh, setFresh] = useState(false);
  const tgt: TerminalTarget = fresh ? { cwd: target.cwd, label: target.label } : target;
  /* where relative paths in the output start from: the folder the terminal opened in */
  const cwdRef = useRef<string | null>(target.cwd ?? null);
  const dockedRef = useRef(docked);
  dockedRef.current = docked;

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    setOutput(false);
    setConn("connecting");
    setReason(null);
    (async () => {
      const [{ Terminal }, { FitAddon }, { Unicode11Addon }, { WebLinksAddon }, { SearchAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-unicode11"),
        import("@xterm/addon-web-links"),
        import("@xterm/addon-search"),
      ]);
      /* xterm measures glyphs on a canvas, which can't resolve CSS variables: use the real families, once loaded */
      const mono = getComputedStyle(document.body).getPropertyValue("--font-mono-face").trim();
      await Promise.all([
        ...(mono ? [document.fonts.load(`13px ${mono}`), document.fonts.load(`bold 13px ${mono}`)] : []),
        document.fonts.load(`13px ${NERD}`, "\ue0b0"),
      ]).catch(() => undefined);
      if (disposed || !hostRef.current) return;
      const phone = window.matchMedia("(max-width: 640px)").matches;
      const stored = Number(localStorage.getItem(SIZE_KEY));
      const size = stored >= 8 && stored <= 24 ? stored : phone ? 12 : 13;
      setFontSize(size);
      const term = new Terminal({
        fontFamily: `${mono ? `${mono}, ` : ""}${NERD}, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`,
        lineHeight: 1.12,
        fontSize: size,
        cursorBlink: true,
        scrollback: 10000,
        theme: readTerminalTheme(),
        allowProposedApi: true,
        macOptionIsMeta: true,
        rightClickSelectsWord: true,
        smoothScrollDuration: 0,
        drawBoldTextInBrightColors: false,
        minimumContrastRatio: 1,
      });
      termRef.current = term;
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new Unicode11Addon());
      term.unicode.activeVersion = "11";
      term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, "_blank", "noopener,noreferrer")));
      const files = fileChecker();
      const pathLinks = term.registerLinkProvider({
        provideLinks(y, callback) {
          const line = term.buffer.active.getLine(y - 1);
          const cells = line ? lineCells(line) : null;
          const matches = cells ? findPathLinks(cells.text).map((m) => ({ ...m, x0: cells.cols[m.start] + 1, x1: cells.cols[m.end - 1] + cells.widths[m.end - 1] })) : [];
          if (!matches.length) return callback(undefined);
          void (async () => {
            const home = matches.some((m) => m.path.startsWith("~/")) ? await files.home() : null;
            const links = await Promise.all(
              matches.map(async (m) => {
                const abs = resolveTerminalPath(m.path, cwdRef.current, home);
                if (!abs || !(await files.isFile(abs))) return null;
                return {
                  range: { start: { x: m.x0, y }, end: { x: m.x1, y } },
                  text: m.text,
                  decorations: { underline: true, pointerCursor: true },
                  activate: () => {
                    /* a sheet over the page would hide Files; Ctrl+` brings it back on desktop */
                    const hideTerminal = !dockedRef.current && window.matchMedia("(min-width: 1024px)").matches;
                    window.dispatchEvent(new CustomEvent(OPEN_FILES_EVENT, { detail: { path: abs, hideTerminal } }));
                  },
                };
              }),
            );
            const found = links.filter((l) => l !== null);
            callback(found.length ? found : undefined);
          })();
        },
      });
      const search = new SearchAddon({ highlightLimit: 2000 });
      term.loadAddon(search);
      term.attachCustomKeyEventHandler((e) => {
        if (e.type === "keydown" && e.shiftKey && hasMod(e) && e.code === "KeyF") {
          e.preventDefault();
          openFindRef.current();
          return false;
        }
        return true;
      });
      term.open(hostRef.current);
      /* the GPU renderer draws box art and Nerd Font icons cell-exact; fall back to the DOM renderer without WebGL */
      try {
        if (!(await deviceBoxTrusted())) throw new Error("device pixel boxes are off");
        const { WebglAddon } = await import("@xterm/addon-webgl");
        const gl = new WebglAddon();
        gl.onContextLoss(() => gl.dispose());
        term.loadAddon(gl);
      } catch {
        /* DOM renderer */
      }
      /* closed (or retried) while the renderer loaded */
      if (disposed) {
        term.dispose();
        termRef.current = null;
        return;
      }
      fit.fit();
      setSearch(search);

      /* connection loop: a kept terminal is re-joined by id from the last byte seen */
      let kept: string | null = tgt.term ?? null;
      let received = 0;
      let tries = 0;
      let ended = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let ws: WebSocket | null = null;
      const pending: string[] = [];
      const encoder = new TextEncoder();

      const connect = () => {
        if (disposed || ended) return;
        clearTimeout(timer);
        const q = new URLSearchParams({ cols: String(term.cols), rows: String(term.rows) });
        if (kept) {
          q.set("term", kept);
          q.set("since", String(received));
        } else if (tgt.tmux) q.set("tmux", tgt.tmux);
        else if (tgt.pid) q.set("pid", String(tgt.pid));
        else if (tgt.session) q.set("session", tgt.session);
        else if (tgt.cwd) q.set("cwd", tgt.cwd);
        const sock = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/pty?${q}`);
        sock.binaryType = "arraybuffer";
        ws = sock;
        wsRef.current = sock;
        let opened = false;
        sock.onopen = () => {
          opened = true;
          tries = 0;
          setConn("open");
          setReason(null);
          term.focus();
          for (const d of pending.splice(0)) sock.send(encoder.encode(d));
        };
        sock.onmessage = (e) => {
          if (typeof e.data === "string") {
            let msg: { type: string; id?: string; label?: string; kind?: string; cwd?: string; persistent?: boolean; code?: number; offset?: number };
            try {
              msg = JSON.parse(e.data);
            } catch {
              return;
            }
            if (msg.type === "hello") {
              if (msg.label) setLabel(msg.label);
              if (msg.cwd) {
                cwdRef.current = msg.cwd;
                setCwd(msg.cwd);
              }
              if (msg.id) setTermId(msg.id);
              setKind(msg.kind ?? null);
              /* an attach starts over each time; the multiplexer redraws everything */
              if (msg.persistent && msg.id) {
                kept = msg.id;
                if (typeof msg.offset === "number") received = msg.offset;
              } else term.reset();
            } else if (msg.type === "reset") term.reset();
            else if (msg.type === "exit") {
              ended = true;
              setConn("ended");
              setReason(msg.code ? `Exited with code ${msg.code}.` : "The terminal exited.");
            }
            return;
          }
          const bytes = new Uint8Array(e.data as ArrayBuffer);
          if (bytes.length) setOutput(true);
          received += bytes.length;
          term.write(bytes);
        };
        sock.onclose = (e) => {
          if (ws !== sock || disposed) return;
          if (e.code === 4401) {
            window.location.href = "/login";
            return;
          }
          if (ended || e.code === 1000 || (e.code >= 4400 && e.code < 4600)) {
            ended = true;
            setConn("ended");
            setReason((r) => r ?? (e.reason || "The terminal closed."));
            return;
          }
          setConn("reconnecting");
          setReason(opened ? "Connection lost. Reconnecting…" : "Can't reach the terminal server. Retrying…");
          tries++;
          /* a refused upgrade looks like a network error: after a few, ask the app whether we're still signed in (api() sends us to login if not) */
          if (!opened && tries === 3)
            void api("/api/terminals").then(
              () => !disposed && !ended && setReason("The app is up but the terminal server isn't answering. It may be restarting, or agent-u-pty is down. Retrying…"),
              () => undefined,
            );
          timer = setTimeout(connect, Math.min(10_000, 400 * 2 ** Math.min(tries, 5)));
        };
      };

      const sendData = (data: string) => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(encoder.encode(data));
        else if (!ended && pending.join("").length < 4096) pending.push(data);
      };
      /* TUIs ask for the colors to pick tints that suit the background */
      const osc = [10, 11].map((n) =>
        term.parser.registerOscHandler(n, (data) => {
          if (data !== "?") return false;
          const theme = term.options.theme ?? {};
          sendData(`\x1b]${n};${oscColor((n === 10 ? theme.foreground : theme.background) ?? "#000000")}\x1b\\`);
          return true;
        }),
      );
      const onData = term.onData((data) => {
        const m = modRef.current;
        if (m && data.length === 1) {
          setMod(null);
          sendData(m === "ctrl" ? ctrlOf(data) : `\x1b${data}`);
          return;
        }
        sendData(data);
      });
      const onResize = term.onResize(({ cols, rows }) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "resize", cols, rows })));
      let fitTimer: ReturnType<typeof setTimeout> | undefined;
      const ro = new ResizeObserver(() => {
        clearTimeout(fitTimer);
        fitTimer = setTimeout(() => {
          try {
            fit.fit();
          } catch {
            /* hidden */
          }
        }, 40);
      });
      ro.observe(hostRef.current);
      /* come back fast after the phone wakes up or the network returns */
      const wake = () => {
        if (document.visibilityState !== "visible" || disposed || ended) return;
        if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
          tries = 0;
          connect();
        }
      };
      window.addEventListener("online", wake);
      document.addEventListener("visibilitychange", wake);
      /* light, dark and palette switches all land on <html> */
      let themeKey = JSON.stringify(term.options.theme);
      const themeWatch = new MutationObserver(() => {
        const next = readTerminalTheme();
        const key = JSON.stringify(next);
        if (key === themeKey) return;
        themeKey = key;
        term.options.theme = next;
      });
      themeWatch.observe(document.documentElement, { attributes: true });
      (term as unknown as { __send?: (d: string) => void }).__send = sendData;
      (term as unknown as { __fit?: () => void }).__fit = () => fit.fit();
      connect();

      cleanup = () => {
        clearTimeout(timer);
        clearTimeout(fitTimer);
        window.removeEventListener("online", wake);
        document.removeEventListener("visibilitychange", wake);
        ro.disconnect();
        themeWatch.disconnect();
        pathLinks.dispose();
        onData.dispose();
        onResize.dispose();
        osc.forEach((h) => h.dispose());
        ended = true;
        ws?.close(4000, "closed by viewer");
        term.dispose();
        termRef.current = null;
        setSearch(null);
        setFind(null);
      };
    })().catch((err: unknown) => {
      if (disposed) return;
      setConn("ended");
      setReason(`Couldn't start the terminal here: ${err instanceof Error ? err.message : String(err)}`);
    });
    return () => {
      disposed = true;
      cleanup();
    };
  }, [tgt.term, tgt.tmux, tgt.session, tgt.pid, tgt.cwd, attempt]);

  const onInfoRef = useRef(onInfo);
  onInfoRef.current = onInfo;
  useEffect(() => onInfoRef.current?.({ label, conn, id: termId, kind, cwd }), [label, conn, termId, kind, cwd]);

  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      /* Escape belongs to the terminal; Ctrl+Shift+X closes it */
      if (e.key.toLowerCase() === "x" && e.ctrlKey && e.shiftKey && !hiddenRef.current) {
        e.preventDefault();
        closeRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (!hidden) requestAnimationFrame(() => termRef.current?.focus());
  }, [hidden, docked]);

  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const max = () => Math.max(DOCK_MIN, window.innerHeight * 0.8);
    /* the CSS cap (80dvh) may be showing less than the stored height after the window shrank */
    const startH = Math.min(height, max());
    let last = startH;
    const move = (ev: PointerEvent) => {
      last = Math.round(Math.min(max(), Math.max(DOCK_MIN, startH + startY - ev.clientY)));
      setHeight(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      localStorage.setItem(DOCK_KEY, String(last));
    };
    document.body.style.cursor = "row-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const send = (seq: string) => (termRef.current as unknown as { __send?: (d: string) => void } | null)?.__send?.(seq);
  const press = (seq: string) => {
    if (seq === "ctrl" || seq === "alt") return setMod((m) => (m === seq ? null : seq));
    if (mod && seq.length === 1) {
      setMod(null);
      return send(mod === "ctrl" ? ctrlOf(seq) : `\x1b${seq}`);
    }
    send(seq);
    termRef.current?.focus();
  };
  const zoom = (delta: number) => {
    const t = termRef.current;
    if (!t) return;
    const next = Math.min(24, Math.max(8, (t.options.fontSize ?? 13) + delta));
    t.options.fontSize = next;
    setFontSize(next);
    localStorage.setItem(SIZE_KEY, String(next));
    (t as unknown as { __fit?: () => void }).__fit?.();
  };
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const flash = (text: string) => {
    clearTimeout(noticeTimer.current);
    setNotice(text);
    noticeTimer.current = setTimeout(() => setNotice(null), 3200);
  };
  useEffect(() => () => clearTimeout(noticeTimer.current), []);
  const paste = async () => {
    let text: string | null = null;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      text = null;
    }
    if (text === null) return flash(`The browser blocked paste. Use ${isMac() ? "⌘V" : "Ctrl+Shift+V"} instead.`);
    if (text) termRef.current?.paste(text);
    termRef.current?.focus();
  };

  const [search, setSearch] = useState<import("@xterm/addon-search").SearchAddon | null>(null);
  /* the find bar, and a counter that refocuses its field when asked to open again */
  const [find, setFind] = useState<{ n: number; dark: boolean } | null>(null);
  const openFindRef = useRef(() => {});
  openFindRef.current = () => {
    setMenu(null);
    setFind((f) => ({ n: (f?.n ?? 0) + 1, dark: isDarkColor(termRef.current?.options.theme?.background ?? "#000000") }));
  };
  const closeFind = () => {
    setFind(null);
    termRef.current?.focus();
  };
  const findKey = keyLabels(["Mod", "Shift", "F"]).join(isMac() ? "" : "+");
  const [menu, setMenu] = useState<{ x: number; y: number; selection: boolean } | null>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const open = (x: number, y: number) => setMenu({ x, y, selection: Boolean(termRef.current?.hasSelection()) });
    let pressAt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let start: { x: number; y: number } | null = null;
    /* Shift+right-click keeps the browser's own menu */
    const onContext = (e: MouseEvent) => {
      if (e.shiftKey || !termRef.current) return;
      e.preventDefault();
      if (Date.now() - pressAt < 1000) return;
      open(e.clientX, e.clientY);
    };
    /* iOS has no contextmenu on long-press */
    const onTouchStart = (e: TouchEvent) => {
      clearTimeout(timer);
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      start = { x: t.clientX, y: t.clientY };
      timer = setTimeout(() => {
        if (!start || !termRef.current) return;
        pressAt = Date.now();
        open(start.x, start.y + 8);
      }, LONG_PRESS_MS);
    };
    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (start && t && Math.hypot(t.clientX - start.x, t.clientY - start.y) > 10) clearTimeout(timer);
    };
    const onTouchEnd = () => {
      clearTimeout(timer);
      start = null;
    };
    host.addEventListener("contextmenu", onContext);
    host.addEventListener("touchstart", onTouchStart, { passive: true });
    host.addEventListener("touchmove", onTouchMove, { passive: true });
    host.addEventListener("touchend", onTouchEnd);
    host.addEventListener("touchcancel", onTouchEnd);
    return () => {
      clearTimeout(timer);
      host.removeEventListener("contextmenu", onContext);
      host.removeEventListener("touchstart", onTouchStart);
      host.removeEventListener("touchmove", onTouchMove);
      host.removeEventListener("touchend", onTouchEnd);
      host.removeEventListener("touchcancel", onTouchEnd);
    };
  }, []);
  const closeMenu = useCallback(() => {
    setMenu(null);
    termRef.current?.focus();
  }, []);
  const act = async (action: TerminalAction) => {
    setMenu(null);
    const t = termRef.current;
    if (!t) return;
    const selection = t.getSelection();
    if (action === "find") return openFindRef.current();
    if (action === "chat") {
      if (!selection.trim()) return;
      if (sendToComposer(fenceBlock(selection))) {
        t.clearSelection();
        flash("Added to the chat.");
      } else flash("Open a session to send this to chat.");
      return;
    }
    if (action === "copy") {
      if (selection) flash((await copyText(selection)) ? "Copied." : "Couldn't copy. Use your copy shortcut instead.");
    } else if (action === "paste") return void paste();
    else if (action === "select-all") t.selectAll();
    else if (action === "clear") t.clear();
    else if (action === "bottom") t.scrollToBottom();
    t.focus();
  };

  /* a plain shell (or one that ended before saying what it was) restarts fresh; attaches retry the same target */
  const isShell = kind === "shell" || (!kind && !target.tmux && !target.pid && !target.session && !target.term);
  const dot = conn === "open" ? "bg-green" : conn === "ended" ? "bg-red" : "animate-pulse bg-orange";
  const tool = "tap relative h-9 shrink-0 rounded-[7px] px-2 text-[12px] text-ink-2 hover:bg-hover hover:text-ink sm:h-7";
  return (
    <div
      className={
        docked
          ? `relative flex max-h-[80dvh] shrink-0 flex-col border-t border-line ${hidden ? "hidden" : ""}`
          : `fixed inset-x-0 top-0 bottom-[var(--kb,0px)] z-50 items-stretch justify-center bg-black/50 lg:items-center lg:p-6 ${hidden ? "hidden" : "flex"}`
      }
      style={docked ? { height } : undefined}
      role={docked ? "region" : "dialog"}
      aria-modal={docked || hidden ? undefined : true}
      aria-label={`Terminal: ${label}`}
    >
      {docked && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize terminal"
          onPointerDown={startResize}
          className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize transition-colors hover:bg-accent/40"
        />
      )}
      <div
        className={
          docked
            ? "flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-page"
            : "safe-top safe-bottom flex w-full flex-col overflow-hidden bg-page shadow-overlay lg:h-[min(90dvh,1000px)] lg:max-w-[1400px] lg:rounded-[14px] lg:border lg:border-line"
        }
        style={docked || popped ? undefined : { animation: "pop-in 200ms cubic-bezier(0.23,1,0.32,1) both" }}
      >
        <div className={`flex shrink-0 items-center gap-1.5 border-b border-line px-3 text-[12.5px] text-ink-2 ${docked ? "h-9" : "h-12 sm:h-11"}`}>
          {tabs ?? (
            <>
              <span className={`size-2 shrink-0 rounded-full ${dot}`} aria-hidden />
              <span className="min-w-0 truncate font-mono text-[12px] text-ink" title={label}>
                {label}
              </span>
            </>
          )}
          {conn === "reconnecting" && <span className="shrink-0 text-[11.5px] text-orange-ink">Reconnecting…</span>}
          {conn === "ended" && kind !== "agent" && (
            <button
              type="button"
              onClick={() => {
                if (isShell) setFresh(true);
                setAttempt((a) => a + 1);
              }}
              className="ml-1 shrink-0 rounded-full bg-hover px-2.5 py-1 text-[12px] font-medium text-ink hover:bg-hover-2"
            >
              {isShell ? "New shell" : kind ? "Reattach" : "Retry"}
            </button>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-0.5">
            <button type="button" onClick={() => zoom(-1)} aria-label="Smaller text" className={tool}>
              A−
            </button>
            <span className="w-5 text-center text-[11px] tabular-nums text-ink-3">{fontSize ?? ""}</span>
            <button type="button" onClick={() => zoom(1)} aria-label="Larger text" className={tool}>
              A+
            </button>
            <button type="button" onClick={() => void paste()} className={`${tool} max-sm:hidden`}>
              Paste
            </button>
            {onDock && (
              <button type="button" onClick={() => onDock(!docked)} aria-label={docked ? "Expand terminal" : "Dock terminal"} className={`${tool} max-lg:hidden`}>
                {docked ? <Expand width={14} height={14} strokeWidth={1.8} /> : <Collapse width={14} height={14} strokeWidth={1.8} />}
              </button>
            )}
            <span className="mx-1 hidden text-[11px] text-ink-3 lg:inline">{docked ? `${comboFor("terminal-anywhere")} to hide` : "Ctrl+Shift+X to close"}</span>
          </span>
          <button type="button" onClick={onClose} aria-label="Close terminal" className="tap relative flex size-10 shrink-0 items-center justify-center rounded-[8px] text-ink-3 hover:bg-hover hover:text-ink sm:size-8">
            <Xmark width={16} height={16} strokeWidth={2} />
          </button>
        </div>
        {reason && conn !== "open" && <p className={`shrink-0 px-3 py-1.5 text-[12px] ${conn === "ended" ? "bg-red-tint text-red-ink" : "bg-orange-tint text-orange-ink"}`}>{reason}</p>}
        <div className="relative min-h-0 flex-1">
          <div ref={hostRef} className="absolute inset-0 px-1.5 pt-1.5 [-webkit-touch-callout:none]" />
          {!output && conn !== "ended" && <p className="pointer-events-none absolute inset-x-0 top-1/3 text-center font-mono text-[12px] text-ink-3">{conn === "open" ? "Waiting for the terminal…" : "Connecting…"}</p>}
          {find && search && <TerminalFind search={search} dark={find.dark} focusKey={find.n} onClose={closeFind} />}
          {notice && (
            <p role="status" className="pointer-events-none absolute bottom-3 left-1/2 z-10 max-w-[90%] -translate-x-1/2 rounded-full bg-ink px-3 py-1.5 text-center text-[12px] text-page shadow-overlay" style={{ animation: "fade-up 180ms cubic-bezier(0.23,1,0.32,1) both" }}>
              {notice}
            </p>
          )}
          {menu && <TerminalMenu at={menu} hasSelection={menu.selection} findKey={findKey} onAction={(a) => void act(a)} onClose={closeMenu} />}
        </div>
        <div className="no-scrollbar flex shrink-0 items-center gap-1 overflow-x-auto border-t border-line px-2 py-1.5 [mask-image:linear-gradient(to_right,black_88%,transparent)] lg:hidden" role="toolbar" aria-label="Terminal keys">
          <button type="button" onPointerDown={(e) => e.preventDefault()} onClick={() => void paste()} className="h-10 min-w-10 shrink-0 rounded-[8px] bg-hover px-3 font-mono text-[12.5px] text-ink-2 active:bg-hover-2">
            Paste
          </button>
          {KEYS.map(([text, seq]) => (
            <button
              key={text}
              type="button"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => press(seq)}
              aria-pressed={seq === mod || undefined}
              className={`h-10 min-w-10 shrink-0 rounded-[8px] px-3 font-mono text-[12.5px] active:bg-hover-2 ${seq === mod ? "bg-ink text-page" : "bg-hover text-ink-2"}`}
            >
              {text}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
