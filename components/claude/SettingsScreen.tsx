"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Menu } from "iconoir-react";
import { api } from "@/lib/client/api";
import { disablePush, enablePush, pushStatus, type PushStatus } from "@/lib/client/push";
import { applyTheme, useSetting, type Settings } from "@/lib/client/settings";
import { ShortcutList } from "./ShortcutsDialog";

const PUSH_NOTE: Partial<Record<PushStatus, string>> = {
  install: "On iPhone and iPad, add agent-u to the Home Screen first.",
  denied: "Blocked. Allow notifications in site settings.",
  unsupported: "Not supported in this browser.",
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col">
      <h2 className="px-1 pb-2 text-[12px] font-medium text-ink-3">{title}</h2>
      <div className="divide-y divide-line rounded-[10px] border border-line bg-surface">{children}</div>
    </section>
  );
}

function Row({ label, note, children }: { label: string; note?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center gap-4 px-3.5 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] text-ink">{label}</div>
        {note && <div className="mt-0.5 text-[12px] text-ink-3">{note}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`tap relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-150 disabled:opacity-50 ${on ? "bg-accent-solid" : "bg-line-strong"}`}
    >
      <span className={`size-4 rounded-full bg-white shadow-sm transition-transform duration-150 ${on ? "translate-x-[18px]" : "translate-x-0.5"}`} />
    </button>
  );
}

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-[8px] bg-field p-0.5">
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={`tap relative h-7 rounded-[6px] px-2.5 text-[12.5px] font-medium transition-colors duration-150 ${value === v ? "bg-surface text-ink shadow-btn" : "text-ink-3 hover:text-ink-2"}`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function Notifications() {
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    void pushStatus()
      .then(setStatus)
      .catch(() => setStatus("unsupported"));
  }, []);
  const toggle = async (on: boolean) => {
    setBusy(true);
    setNote(null);
    try {
      if (on) {
        await enablePush();
        setNote("Test notification sent.");
      } else await disablePush();
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setStatus(await pushStatus().catch(() => "unsupported" as const));
      setBusy(false);
    }
  };
  const blocked = status ? PUSH_NOTE[status] : undefined;
  return (
    <Row label="Push notifications" note={note ?? blocked ?? "Finished turns, approvals and failures."}>
      <Switch on={status === "on"} onChange={(v) => void toggle(v)} label="Push notifications" disabled={busy || status === null || Boolean(blocked)} />
    </Row>
  );
}

/** Device preferences: appearance, composer, terminal, notifications, shortcuts. */
export function SettingsScreen({ onMenu, extra, onAgents }: { onMenu: () => void; extra?: ReactNode; onAgents: () => void }) {
  const [theme] = useSetting("theme");
  const [sendWithEnter, setSendWithEnter] = useSetting("sendWithEnter");
  const [docked, setDocked] = useSetting("terminalDocked");

  return (
    <section className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="on-page safe-top safe-x flex shrink-0 items-center bg-page">
        <div className="flex h-14 w-full min-w-0 items-center gap-1 px-1.5 sm:px-3 lg:h-[52px]">
          <button type="button" onClick={onMenu} aria-label="Open sessions" aria-haspopup="dialog" data-drawer-opener className="icon-btn lg:hidden">
            <Menu width={19} height={19} strokeWidth={1.8} />
          </button>
          <h1 className="min-w-0 flex-1 truncate px-1.5 text-[15px] font-medium tracking-[-0.01em] text-ink sm:text-[14.5px]">Settings</h1>
          {extra}
        </div>
      </header>
      <div className="safe-x safe-bottom min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex w-full max-w-[680px] flex-col gap-7 px-3 pt-2 pb-16 sm:px-6">
          <Section title="Appearance">
            <Row label="Theme">
              <Segmented<Settings["theme"]>
                label="Theme"
                value={theme}
                onChange={applyTheme}
                options={[
                  ["system", "System"],
                  ["light", "Light"],
                  ["dark", "Dark"],
                ]}
              />
            </Row>
          </Section>

          <Section title="Composer">
            <Row label="Send with Enter" note={sendWithEnter ? "Shift+Enter adds a new line." : "Enter adds a new line. Ctrl+Enter sends."}>
              <Switch on={sendWithEnter} onChange={setSendWithEnter} label="Send with Enter" />
            </Row>
          </Section>

          <Section title="Terminal">
            <Row label="Open in a panel" note="On desktop, terminals open under the session. Off opens them full size.">
              <Switch on={docked} onChange={setDocked} label="Open terminals in a panel" />
            </Row>
          </Section>

          <Section title="Notifications">
            <Notifications />
          </Section>

          <Section title="Agents">
            <Row label="Profiles and terminals" note="Accounts, proxies, models and running agents.">
              <button type="button" onClick={onAgents} className="tap relative h-8 rounded-[8px] px-3 text-[12.5px] font-medium text-ink shadow-btn hover:bg-hover">
                Open
              </button>
            </Row>
          </Section>

          <section className="flex flex-col">
            <h2 className="px-1 pb-2 text-[12px] font-medium text-ink-3">Keyboard shortcuts</h2>
            <div className="rounded-[10px] border border-line bg-surface px-3.5 py-3">
              <ShortcutList />
            </div>
          </section>

          <Section title="Account">
            <Row label="Sign out" note="Ends this browser's session. Agents keep running.">
              <button
                type="button"
                onClick={() =>
                  void api("/api/auth/logout", {})
                    .catch(() => undefined)
                    .then(() => {
                      window.location.href = "/login";
                    })
                }
                className="tap relative h-8 rounded-[8px] px-3 text-[12.5px] font-medium text-red-ink shadow-btn hover:bg-hover"
              >
                Sign out
              </button>
            </Row>
            <Row label="Sign out everywhere" note="Ends the session on every device, this one too. Agents keep running.">
              <button
                type="button"
                onClick={() =>
                  void api("/api/auth/logout", { everywhere: true })
                    .catch(() => undefined)
                    .then(() => {
                      window.location.href = "/login";
                    })
                }
                className="tap relative h-8 rounded-[8px] px-3 text-[12.5px] font-medium text-red-ink shadow-btn hover:bg-hover"
              >
                Sign out everywhere
              </button>
            </Row>
          </Section>
        </div>
      </div>
    </section>
  );
}
