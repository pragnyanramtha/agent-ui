"use client";

import { useEffect, useState } from "react";

/** A quiet strip while the browser is offline. Work on the server carries on; sends go out when it's back. */
export function OfflineBanner() {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    const sync = () => setOffline(!navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);
  if (!offline) return null;
  return (
    <div role="status" className="safe-top pointer-events-none fixed inset-x-0 top-14 z-[60] flex justify-center px-3 pt-1 lg:top-[52px]">
      <p className="pointer-events-auto max-w-md rounded-[12px] bg-ink px-3.5 py-1.5 text-center text-sm font-medium text-page shadow-overlay">
        Offline. Messages send when you reconnect.
      </p>
    </div>
  );
}
