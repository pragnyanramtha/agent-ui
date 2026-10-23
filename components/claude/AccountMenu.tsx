"use client";

import { useEffect, useState } from "react";
import { Bell, BellOff, HalfMoon, LogOut, Settings, StatsReport, SunLight, MoreHoriz } from "iconoir-react";
import { signOut } from "@/lib/client/push";
import { applyTheme, useSetting } from "@/lib/client/settings";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePush } from "./NotifyButton";
import { Pulse } from "./Pulse";

/** The app's mark: a small ink square with the pixel pulse. */
export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <span className="flex shrink-0 items-center justify-center rounded-[7px] bg-ink" style={{ width: size, height: size }} aria-hidden>
      <Pulse busy={false} size={3} cellClass="bg-page" />
    </span>
  );
}

const THEMES = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

/**
 * The sidebar's foot, ChatGPT style: one row naming the server, opening a menu with Settings, Usage,
 * notifications for this browser, the theme and Sign out.
 */
export function AccountMenu({ onView, activeView }: { onView?: (v: "@settings" | "@usage") => void; activeView?: string | null }) {
  const push = usePush();
  const [theme] = useSetting("theme");
  /* after mount: the server render can't know the host, and a mismatch would throw hydration away */
  const [host, setHost] = useState("");
  useEffect(() => setHost(window.location.hostname), []);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-current={activeView === "@settings" || activeView === "@usage" ? "page" : undefined}
          className="side-row h-11! gap-2.5 data-[state=open]:bg-sidebar-active"
        >
          <BrandMark />
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-sm font-medium text-ink">agent-u</span>
            {host && (
              <span className="truncate text-xs text-ink-3" translate="no">
                {host}
              </span>
            )}
          </span>
          <MoreHoriz width={15} height={15} strokeWidth={1.8} className="shrink-0 text-ink-3" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" sideOffset={6} className="min-w-60">
        {onView && (
          <>
            <DropdownMenuItem onSelect={() => onView("@settings")}>
              <Settings strokeWidth={1.8} />
              Settings
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onView("@usage")}>
              <StatsReport strokeWidth={1.8} />
              Usage and cost
            </DropdownMenuItem>
          </>
        )}
        {push.status !== null && (
          <DropdownMenuItem onSelect={(e) => (e.preventDefault(), void push.toggle())} disabled={push.busy}>
            {push.on ? <Bell strokeWidth={1.8} /> : <BellOff strokeWidth={1.8} />}
            {push.on ? "Turn off notifications" : "Turn on notifications"}
          </DropdownMenuItem>
        )}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            {theme === "light" ? <SunLight strokeWidth={1.8} /> : <HalfMoon strokeWidth={1.8} />}
            Theme
            <span className="ml-auto text-xs text-ink-3">{THEMES.find((t) => t.value === theme)?.label}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-40">
            <DropdownMenuLabel>Theme</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={theme} onValueChange={(v) => applyTheme(v as (typeof THEMES)[number]["value"])}>
              {THEMES.map((t) => (
                <DropdownMenuRadioItem key={t.value} value={t.value}>
                  {t.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut()}>
          <LogOut strokeWidth={1.8} />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
