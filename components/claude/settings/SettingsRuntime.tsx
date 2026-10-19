"use client";

import { useEffect } from "react";
import { startSettings } from "@/lib/client/settings";

/** Keeps synced settings fresh and <html> in step with every settings change. Renders nothing. */
export function SettingsRuntime() {
  useEffect(() => {
    /* signed out, /api/settings answers 401; the cached copy is enough for the login page */
    if (window.location.pathname.startsWith("/login")) return;
    return startSettings();
  }, []);
  return null;
}
