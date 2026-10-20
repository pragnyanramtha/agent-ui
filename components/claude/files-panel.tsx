"use client";

import { lazyComponent } from "@/lib/client/lazy";

/** The session's files beside the conversation; loads on first open. */
export const FilesPanel = lazyComponent(
  () => import("./FilesPanel").then((m) => m.FilesPanel),
  () => (
    <div
      role="status"
      className="absolute inset-0 z-20 flex items-center justify-center bg-page p-6 text-sm text-ink-3 lg:static lg:inset-auto lg:w-[440px] lg:shrink-0 lg:border-l lg:border-line xl:w-[520px]"
    >
      Loading files…
    </div>
  ),
);

export type { FileTarget } from "./FilesPanel";
