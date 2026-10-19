"use client";

import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { Bell, ChatLines, Cpu, Database, EditPencil, GitBranch, InfoCircle, KeyCommand, Palette, Settings as SettingsIcon, Terminal } from "iconoir-react";
import { api } from "@/lib/client/api";
import { disablePush, enablePush, pushStatus, type PushStatus } from "@/lib/client/push";
import { settingsIn, type SectionId } from "@/lib/settings-schema";
import { ShortcutList } from "../ShortcutsDialog";
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
      <Switch checked={status === "on"} onChange={(v) => void toggle(v)} label="Push notifications" disabled={busy || status === null || Boolean(blocked)} />
    </Row>
  );
}

function SignOutRow({ everywhere = false }: { everywhere?: boolean }) {
  const label = everywhere ? "Sign out everywhere" : "Sign out";
  return (
    <Row label={label} note={everywhere ? "Ends the session on every device, this one too. Agents keep running." : "Ends this browser's session. Agents keep running."}>
      <SmallButton
        tone="danger"
        onClick={() =>
          void api("/api/auth/logout", everywhere ? { everywhere: true } : {})
            .catch(() => undefined)
            .then(() => {
              window.location.href = "/login";
            })
        }
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
    <Card>
      <PushRow />
    </Card>
  );
}

function Keyboard() {
  return (
    <section className="flex flex-col">
      <div className="rounded-card border border-line bg-surface px-3.5 py-3">
        <ShortcutList />
      </div>
      <p className="px-1 pt-2 text-[12px] text-ink-3">Press ? outside a text field to see these anywhere.</p>
    </section>
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
  keyboard: Keyboard,
  agents: Agents,
  git: Git,
  data: DataSection,
  about: AboutSection,
};

export function SectionBody({ id, ...props }: SectionProps & { id: SectionId }): ReactNode {
  const View = SECTION_VIEWS[id];
  return View ? <View {...props} /> : <RegistryCards section={id} />;
}
