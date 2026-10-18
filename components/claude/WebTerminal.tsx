"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Collapse, Expand, Xmark } from "iconoir-react";
import "@xterm/xterm/css/xterm.css";
import { api } from "@/lib/client/api";

/** What to open: a kept terminal (`term`), a tmux session, a CLI's multiplexer (`pid`/`session`), or a new shell (`cwd`). */
export type TerminalTarget = { term?: string; tmux?: string; session?: string; pid?: number; cwd?: string; label: string };

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

/* One Dark-ish, matched to the app's dark page */
const THEME = {
  background: "#17181a",
  foreground: "#e6e8ec",
  cursor: "#e6e8ec",
  cursorAccent: "#17181a",
  selectionBackground: "#3a3d44",
  black: "#1d1e21",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#c9ccd3",
  brightBlack: "#6b7079",
  brightRed: "#f28b94",
  brightGreen: "#b5e08f",
  brightYellow: "#f2d398",
  brightBlue: "#8cc7ff",
  brightMagenta: "#dc9ef0",
  brightCyan: "#7fd3dd",
  brightWhite: "#ffffff",
};

const SIZE_KEY = "cui:term-font";
const DOCK_KEY = "cui:term-dock-height";
const DOCK_MIN = 140;
const DOCK_DEFAULT = 320;
/* "#17181a" -> "rgb:1717/1818/1a1a", the form OSC 10/11 replies use */
const oscColor = (hex: string) => `rgb:${[1, 3, 5].map((i) => hex.slice(i, i + 2).repeat(2)).join("/")}`;
const NERD = '"Symbols Nerd Font Mono"';

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
}: {
  target: TerminalTarget;
  onClose: () => void;
  /** a resizable panel at the bottom of the main column (desktop) instead of a sheet over the page */
  docked?: boolean;
  /** docked and folded away; the connection stays up */
  hidden?: boolean;
  onDock?: (docked: boolean) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(DOCK_DEFAULT);
  useEffect(() => {
    const stored = Number(localStorage.getItem(DOCK_KEY));
    if (stored >= DOCK_MIN) setHeight(stored);
  }, []);
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
  const [output, setOutput] = useState(false);
  /* after a shell exits, "New shell" opens a fresh one in the same folder */
  const [fresh, setFresh] = useState(false);
  const tgt: TerminalTarget = fresh ? { cwd: target.cwd, label: target.label } : target;

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    setOutput(false);
    setConn("connecting");
    setReason(null);
    (async () => {
      const [{ Terminal }, { FitAddon }, { Unicode11Addon }, { WebLinksAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-unicode11"),
        import("@xterm/addon-web-links"),
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
        theme: THEME,
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
      term.open(hostRef.current);
      /* the GPU renderer draws box art and Nerd Font icons cell-exact; fall back to the DOM renderer without WebGL */
      try {
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
            let msg: { type: string; id?: string; label?: string; kind?: string; persistent?: boolean; code?: number; offset?: number };
            try {
              msg = JSON.parse(e.data);
            } catch {
              return;
            }
            if (msg.type === "hello") {
              if (msg.label) setLabel(msg.label);
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
          sendData(`\x1b]${n};${oscColor(n === 10 ? THEME.foreground : THEME.background)}\x1b\\`);
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
      (term as unknown as { __send?: (d: string) => void }).__send = sendData;
      (term as unknown as { __fit?: () => void }).__fit = () => fit.fit();
      connect();

      cleanup = () => {
        clearTimeout(timer);
        clearTimeout(fitTimer);
        window.removeEventListener("online", wake);
        document.removeEventListener("visibilitychange", wake);
        ro.disconnect();
        onData.dispose();
        onResize.dispose();
        osc.forEach((h) => h.dispose());
        ended = true;
        ws?.close(4000, "closed by viewer");
        term.dispose();
        termRef.current = null;
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
    const startH = height;
    const max = () => Math.max(DOCK_MIN, window.innerHeight * 0.8);
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
  const paste = async () => {
    const text = await navigator.clipboard?.readText().catch(() => "");
    if (text) termRef.current?.paste(text);
  };

  /* a plain shell (or one that ended before saying what it was) restarts fresh; attaches retry the same target */
  const isShell = kind === "shell" || (!kind && !target.tmux && !target.pid && !target.session && !target.term);
  const dot = conn === "open" ? "bg-green" : conn === "ended" ? "bg-red" : "animate-pulse bg-orange";
  const tool = "tap relative h-9 shrink-0 rounded-[7px] px-2 text-[12px] text-[#c9ccd3] hover:bg-white/10 sm:h-7";
  return (
    <div
      className={
        docked
          ? `relative flex shrink-0 flex-col border-t border-line ${hidden ? "hidden" : ""}`
          : "fixed inset-x-0 top-0 bottom-[var(--kb,0px)] z-50 flex items-stretch justify-center bg-black/50 lg:items-center lg:p-6"
      }
      style={docked ? { height } : undefined}
      role={docked ? "region" : "dialog"}
      aria-modal={docked ? undefined : true}
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
            ? "flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-[#17181a]"
            : "safe-top safe-bottom flex w-full flex-col overflow-hidden bg-[#17181a] shadow-overlay lg:h-[min(90dvh,1000px)] lg:max-w-[1400px] lg:rounded-[14px] lg:border lg:border-line"
        }
        style={docked ? undefined : { animation: "pop-in 200ms cubic-bezier(0.23,1,0.32,1) both" }}
      >
        <div className={`flex shrink-0 items-center gap-1.5 border-b border-white/10 px-3 text-[12.5px] text-[#c9ccd3] ${docked ? "h-9" : "h-12 sm:h-11"}`}>
          <span className={`size-2 shrink-0 rounded-full ${dot}`} aria-hidden />
          <span className="min-w-0 truncate font-mono text-[12px] text-[#e6e8ec]" title={label}>
            {label}
          </span>
          {conn === "reconnecting" && <span className="shrink-0 text-[11.5px] text-orange">Reconnecting…</span>}
          {conn === "ended" && kind !== "agent" && (
            <button
              type="button"
              onClick={() => {
                if (isShell) setFresh(true);
                setAttempt((a) => a + 1);
              }}
              className="ml-1 shrink-0 rounded-full bg-white/10 px-2.5 py-1 text-[12px] font-medium text-[#e6e8ec] hover:bg-white/15"
            >
              {isShell ? "New shell" : kind ? "Reattach" : "Retry"}
            </button>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-0.5">
            <button type="button" onClick={() => zoom(-1)} aria-label="Smaller text" className={tool}>
              A−
            </button>
            <span className="w-5 text-center text-[11px] tabular-nums text-[#6b7079]">{fontSize ?? ""}</span>
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
            <span className="mx-1 hidden text-[11px] text-[#6b7079] lg:inline">{docked ? "Ctrl+J to hide" : "Ctrl+Shift+X to close"}</span>
          </span>
          <button type="button" onClick={onClose} aria-label="Close terminal" className="tap relative flex size-10 shrink-0 items-center justify-center rounded-[8px] text-[#8b909a] hover:bg-white/10 hover:text-[#e6e8ec] sm:size-8">
            <Xmark width={16} height={16} strokeWidth={2} />
          </button>
        </div>
        {reason && conn !== "open" && <p className={`shrink-0 px-3 py-1.5 text-[12px] ${conn === "ended" ? "bg-red/10 text-[#f2a7a7]" : "bg-orange/10 text-[#f2d398]"}`}>{reason}</p>}
        <div className="relative min-h-0 flex-1">
          <div ref={hostRef} className="absolute inset-0 px-1.5 pt-1.5" />
          {!output && conn !== "ended" && <p className="pointer-events-none absolute inset-x-0 top-1/3 text-center font-mono text-[12px] text-[#6b7079]">{conn === "open" ? "Waiting for the terminal…" : "Connecting…"}</p>}
        </div>
        <div className="no-scrollbar flex shrink-0 items-center gap-1 overflow-x-auto border-t border-white/10 px-2 py-1.5 [mask-image:linear-gradient(to_right,black_88%,transparent)] lg:hidden" role="toolbar" aria-label="Terminal keys">
          <button type="button" onPointerDown={(e) => e.preventDefault()} onClick={() => void paste()} className="h-10 min-w-10 shrink-0 rounded-[8px] bg-white/[0.06] px-3 font-mono text-[12.5px] text-[#c9ccd3] active:bg-white/15">
            Paste
          </button>
          {KEYS.map(([text, seq]) => (
            <button
              key={text}
              type="button"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => press(seq)}
              aria-pressed={seq === mod || undefined}
              className={`h-10 min-w-10 shrink-0 rounded-[8px] px-3 font-mono text-[12.5px] active:bg-white/15 ${seq === mod ? "bg-white/25 text-white" : "bg-white/[0.06] text-[#c9ccd3]"}`}
            >
              {text}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
