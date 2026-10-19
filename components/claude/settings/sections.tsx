"use client";

import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { Bell, ChatLines, Cpu, Database, EditPencil, GitBranch, InfoCircle, KeyCommand, Palette, Settings as SettingsIcon, SidebarExpand, Terminal } from "iconoir-react";
import { disablePush, enablePush, pushStatus, signOut, type PushStatus } from "@/lib/client/push";
import { toast } from "@/lib/client/toast";
import { sendTestNotification } from "@/lib/client/useNotifications";
import { settingsIn, type SectionId } from "@/lib/settings-schema";
import { KeyboardSection } from "./KeyboardSection";
import { Card, Row, SmallButton, Switch } from "./controls";
import { SettingField } from "./SettingField";
import { Preview } from "./Preview";
import { DataSection } from "./DataSection";
import { AboutSection } from "./AboutSection";

/* What each section shows. A section without an entry here lists its registry settings (lib/settings-schema.ts),
 * one card per `group`. Give it a component when it needs more than settings rows: buttons, lists, previews. */

export type SectionProps = { onAgents: () => void };

export const SECTION_ICONS: Record<SectionId, ComponentType<{ width?: number; height?: number; strokeWidth?: number }>> = {
  general: SettingsIcon,
  appearance: Palette,
  sidebar: SidebarExpand,
  composer: EditPencil,
  conversation: ChatLines,
  terminal: Terminal,
  notifications: Bell,
  keyboard: KeyCommand,
  agents: Cpu,
  git: GitBranch,
  data: Database,
  about: InfoCircle,
};

/** The section's registry settings as cards, one per group, in registry order. */
export function RegistryCards({ section }: { section: SectionId }) {
  const groups = new Map<string, ReturnType<typeof settingsIn>>();
  for (const d of settingsIn(section)) {
    if (d.hidden) continue;
    /* a setting listed in another section keeps its rows together under that section's name */
    const g = d.section === section ? (d.group ?? "") : "";
    groups.set(g, [...(groups.get(g) ?? []), d]);
  }
  return (
    <>
      {[...groups].map(([group, defs]) => (
        <Card key={group || "_"} title={group || undefined}>
          {defs.map((d) => (
            <SettingField key={d.key} k={d.key} />
          ))}
        </Card>
      ))}
    </>
  );
}

const PUSH_NOTE: Partial<Record<PushStatus, string>> = {
  install: "On iPhone and iPad, add agent-u to the Home Screen first.",
  denied: "Blocked. Allow notifications in site settings.",
  unsupported: "Not supported in this browser.",
};

function PushRow() {
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void pushStatus()
      .then(setStatus)
      .catch(() => setStatus("unsupported"));
  }, []);
  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      if (on) {
        await enablePush();
        toast({ key: "push", tone: "success", title: "Push notifications on", body: "Test notification sent." });
      } else await disablePush();
    } catch (err) {
      toast({ key: "push", tone: "error", title: "Couldn't change push notifications", body: err instanceof Error ? err.message : String(err) });
    } finally {
      setStatus(await pushStatus().catch(() => "unsupported" as const));
      setBusy(false);
    }
  };
  const blocked = status ? PUSH_NOTE[status] : undefined;
  return (
    <Row label="Push notifications" note={blocked ?? "This browser, for the events above, even when agent-u is closed."}>
      <Switch checked={status === "on"} onChange={(v) => void toggle(v)} label="Push notifications" disabled={busy || status === null || Boolean(blocked)} />
    </Row>
  );
}

function TestRow() {
  const [busy, setBusy] = useState(false);
  return (
    <Row label="Send test notification" note="Tries every alert that's on for this device.">
      <SmallButton
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void sendTestNotification().finally(() => setBusy(false));
        }}
      >
        {busy ? "Sending…" : "Send test"}
      </SmallButton>
    </Row>
  );
}

function SignOutRow({ everywhere = false }: { everywhere?: boolean }) {
  const label = everywhere ? "Sign out everywhere" : "Sign out";
  return (
    <Row label={label} note={everywhere ? "Ends the session on every device, this one too. Agents keep running." : "Ends this browser's session. Agents keep running."}>
      <SmallButton
        tone="danger"
        onClick={() => void signOut(everywhere)}
      >
        {label}
      </SmallButton>
    </Row>
  );
}

function General() {
  return (
    <>
      <RegistryCards section="general" />
      <Card title="Account">
        <SignOutRow />
        <SignOutRow everywhere />
      </Card>
    </>
  );
}

function Appearance() {
  return (
    <>
      <Preview />
      <RegistryCards section="appearance" />
    </>
  );
}

function Notifications() {
  return (
    <>
      <RegistryCards section="notifications" />
      <Card title="Push" footer="Push stays quiet while an agent-u window is in front.">
        <PushRow />
      </Card>
      <Card>
        <TestRow />
      </Card>
    </>
  );
}

function Agents({ onAgents }: SectionProps) {
  return (
    <Card>
      <Row label="Profiles and terminals" note="Accounts, proxies, models and running agents.">
        <SmallButton onClick={onAgents}>Open</SmallButton>
      </Row>
    </Card>
  );
}

function Git() {
  return (
    <>
      <RegistryCards section="git" />
      <p className="px-1 text-[12px] leading-relaxed text-ink-3">
        A checkpoint of your files is saved before each message you send here, so a turn can be rewound. Commit, push and pull requests are in each session&apos;s Git panel.
      </p>
    </>
  );
}

export const SECTION_VIEWS: Partial<Record<SectionId, ComponentType<SectionProps>>> = {
  general: General,
  appearance: Appearance,
  notifications: Notifications,
  keyboard: KeyboardSection,
  agents: Agents,
  git: Git,
  data: DataSection,
  about: AboutSection,
};

export function SectionBody({ id, ...props }: SectionProps & { id: SectionId }): ReactNode {
  const View = SECTION_VIEWS[id];
  return View ? <View {...props} /> : <RegistryCards section={id} />;
}
