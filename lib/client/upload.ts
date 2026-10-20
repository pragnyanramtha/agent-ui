import { ApiError } from "./api";

/* Uploads in 8 MB chunks. A dropped connection or a server restart resumes from what the server
 * already has (it answers a wrong offset with how much it received), so big files get there on
 * flaky mobile data too. */

const CHUNK = 8 * 1024 * 1024;

export type UploadProgress = { sent: number; total: number; retrying: boolean };

export async function uploadFile(dir: string, file: File, opts: { replace?: boolean; signal?: AbortSignal; onProgress?: (p: UploadProgress) => void } = {}) {
  let offset = 0;
  let failures = 0;
  const q = (o: number) => new URLSearchParams({ dir, name: file.name, offset: String(o), total: String(file.size), key: `${file.size}-${file.lastModified}`, ...(opts.replace ? { replace: "1" } : {}) });
  for (;;) {
    if (opts.signal?.aborted) throw new DOMException("Upload cancelled", "AbortError");
    const chunk = file.slice(offset, Math.min(file.size, offset + CHUNK));
    let res: Response;
    try {
      res = await fetch(`/api/files/upload?${q(offset)}`, { method: "POST", body: chunk, signal: opts.signal, headers: { "Content-Type": "application/octet-stream" } });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      if (++failures > 40) throw new ApiError("Connection lost. Try again.", 0);
      opts.onProgress?.({ sent: offset, total: file.size, retrying: true });
      await new Promise((r) => setTimeout(r, Math.min(10_000, 800 * 2 ** Math.min(failures, 4))));
      if (!navigator.onLine) await new Promise<void>((r) => window.addEventListener("online", () => r(), { once: true }));
      continue;
    }
    const body = (await res.json().catch(() => ({}))) as { done?: boolean; received?: number; error?: string; code?: string };
    if (res.status === 409 && body.code === "offset" && typeof body.received === "number") {
      offset = body.received;
      continue;
    }
    if (res.status >= 500 && res.status !== 501) {
      if (++failures > 40) throw new ApiError(body.error ?? `Upload failed (${res.status})`, res.status);
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    if (!res.ok) throw new ApiError(body.error ?? `Upload failed (${res.status})`, res.status, body.code);
    failures = 0;
    offset = body.received ?? offset + chunk.size;
    opts.onProgress?.({ sent: offset, total: file.size, retrying: false });
    if (body.done) return;
  }
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}
