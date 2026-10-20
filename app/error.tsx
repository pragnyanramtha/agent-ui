"use client";

import { useEffect } from "react";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main className="flex h-[100dvh] items-center justify-center bg-page p-6 text-ink">
      <div className="max-w-sm text-center">
        <h1 className="text-md font-semibold">Something went wrong</h1>
        <p className="mt-1.5 text-sm text-ink-2">Sessions keep running.</p>
        {error.message && <p className="mt-3 break-words font-mono text-xs text-ink-3">{error.message}</p>}
        <div className="mt-4 flex justify-center gap-2">
          <button type="button" onClick={reset} className="h-9 rounded-full bg-ink px-4 text-sm font-medium text-surface">
            Try again
          </button>
          <button type="button" onClick={() => location.reload()} className="h-9 rounded-full border border-line px-4 text-sm font-medium">
            Reload
          </button>
        </div>
      </div>
    </main>
  );
}
