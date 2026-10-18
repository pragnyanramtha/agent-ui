"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Page, Xmark } from "iconoir-react";
import { api } from "@/lib/client/api";
import { formatBytes, uploadFile } from "@/lib/client/upload";
import { attachName, isImagePath } from "@/lib/attachments";

export type Attachment = {
  id: string;
  name: string;
  size: number;
  /* an object URL for images, so the chip shows the picture before the upload ends */
  preview: string | null;
  state: "uploading" | "done" | "error";
  sent: number;
  path: string | null;
  error: string | null;
};

const MAX_FILES = 10;
const MAX_BYTES = 200 * 1024 * 1024;

/** Files picked, pasted or dropped into the composer: uploaded right away into one server folder per message. */
export function useAttachments() {
  const [items, setItems] = useState<Attachment[]>([]);
  const dir = useRef<Promise<string> | null>(null);
  const aborts = useRef(new Map<string, AbortController>());
  const files = useRef(new Map<string, File>());

  const patch = useCallback((id: string, p: Partial<Attachment>) => setItems((list) => list.map((a) => (a.id === id ? { ...a, ...p } : a))), []);

  const upload = useCallback(
    async (id: string) => {
      const file = files.current.get(id);
      if (!file) return;
      const ac = new AbortController();
      aborts.current.set(id, ac);
      patch(id, { state: "uploading", error: null, sent: 0 });
      try {
        dir.current ??= api<{ dir: string }>("/api/attachments", {}).then((r) => r.dir);
        const folder = await dir.current.catch((err) => {
          dir.current = null;
          throw err;
        });
        await uploadFile(folder, file, { replace: true, signal: ac.signal, onProgress: (p) => patch(id, { sent: p.sent }) });
        patch(id, { state: "done", sent: file.size, path: `${folder}/${file.name}` });
      } catch (err) {
        if (ac.signal.aborted) return;
        patch(id, { state: "error", error: err instanceof Error ? err.message : String(err) });
      } finally {
        aborts.current.delete(id);
      }
    },
    [patch],
  );

  /** returns a note when some files were left out */
  const add = useCallback(
    (picked: FileList | File[]): string | null => {
      const list = [...picked];
      if (!list.length) return null;
      let note: string | null = null;
      const taken = new Set(items.map((a) => a.name));
      const room = MAX_FILES - items.length;
      const next: Attachment[] = [];
      for (const f of list) {
        if (next.length >= room) {
          note = `Up to ${MAX_FILES} files per message.`;
          break;
        }
        if (f.size > MAX_BYTES) {
          note = `${f.name} is over ${formatBytes(MAX_BYTES)}. Upload it in Files.`;
          continue;
        }
        /* pasted screenshots all arrive as image.png */
        let name = attachName(f.name || "pasted");
        for (let n = 2; taken.has(name); n++) name = name.replace(/(-\d+)?(\.[^.]+)?$/, (_m, _d, ext = "") => `-${n}${ext}`);
        taken.add(name);
        const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
        files.current.set(id, new File([f], name, { type: f.type, lastModified: f.lastModified }));
        next.push({ id, name, size: f.size, preview: f.type.startsWith("image/") ? URL.createObjectURL(f) : null, state: "uploading", sent: 0, path: null, error: null });
      }
      if (next.length) {
        setItems((cur) => [...cur, ...next]);
        for (const a of next) void upload(a.id);
      }
      return note;
    },
    [items, upload],
  );

  const remove = useCallback((id: string) => {
    aborts.current.get(id)?.abort();
    files.current.delete(id);
    setItems((list) => {
      const gone = list.find((a) => a.id === id);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return list.filter((a) => a.id !== id);
    });
  }, []);

  /** after a send: the next message gets a new folder */
  const clear = useCallback(() => {
    for (const ac of aborts.current.values()) ac.abort();
    aborts.current.clear();
    files.current.clear();
    dir.current = null;
    setItems((list) => {
      for (const a of list) if (a.preview) URL.revokeObjectURL(a.preview);
      return [];
    });
  }, []);

  useEffect(() => clear, [clear]);

  const uploading = items.some((a) => a.state === "uploading");
  const failed = items.some((a) => a.state === "error");
  const paths = items.filter((a) => a.state === "done" && a.path).map((a) => a.path!);
  return { items, add, remove, retry: upload, clear, uploading, failed, paths };
}

export function AttachmentChips({ items, onRemove, onRetry }: { items: Attachment[]; onRemove: (id: string) => void; onRetry: (id: string) => void }) {
  if (!items.length) return null;
  return (
    <ul className="no-scrollbar flex gap-1.5 overflow-x-auto pb-0.5" aria-label="Attachments">
      {items.map((a) => {
        const pct = a.size ? Math.round((a.sent / a.size) * 100) : 100;
        return (
          <li key={a.id} className={`relative flex h-12 max-w-[14rem] shrink-0 items-center gap-2 rounded-[12px] pr-8 pl-1.5 text-[12.5px] shadow-hairline ${a.state === "error" ? "bg-red-tint" : "bg-inset"}`} title={a.error ?? a.name}>
            {a.preview ? (
              <img src={a.preview} alt="" className="size-9 shrink-0 rounded-[8px] object-cover" />
            ) : (
              <span className="flex size-9 shrink-0 items-center justify-center rounded-[8px] bg-surface text-ink-2">
                <Page width={16} height={16} strokeWidth={1.8} aria-hidden />
              </span>
            )}
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-ink">{a.name}</span>
              {a.state === "error" ? (
                <button type="button" onClick={() => onRetry(a.id)} className="text-left text-[11.5px] font-medium text-red-ink underline-offset-2 hover:underline">
                  Upload failed. Retry
                </button>
              ) : (
                <span className="text-[11.5px] text-ink-3 tabular-nums">{a.state === "uploading" ? `Uploading… ${pct}%` : formatBytes(a.size)}</span>
              )}
            </span>
            <button type="button" onClick={() => onRemove(a.id)} aria-label={`Remove ${a.name}`} className="tap absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded-full text-ink-3 hover:bg-hover hover:text-ink">
              <Xmark width={13} height={13} strokeWidth={2.2} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Files a sent message names, as thumbnails (images) and chips; each opens the file. */
export function SentFiles({ paths }: { paths: string[] }) {
  if (!paths.length) return null;
  const raw = (p: string) => `/api/files/raw?path=${encodeURIComponent(p)}`;
  return (
    <ul className="mb-1.5 flex flex-wrap justify-end gap-1.5" aria-label="Attached files">
      {paths.map((p) => {
        const name = p.split("/").pop() || p;
        return (
          <li key={p}>
            <a href={raw(p)} target="_blank" rel="noreferrer" title={p} className="block">
              {isImagePath(p) ? (
                <img src={raw(p)} alt={name} loading="lazy" decoding="async" className="max-h-40 max-w-[12rem] rounded-[10px] object-cover shadow-hairline" />
              ) : (
                <span className="inline-flex h-8 max-w-[14rem] items-center gap-1.5 rounded-[10px] bg-inset px-2.5 text-[12.5px] text-ink-2 shadow-hairline hover:text-ink">
                  <Page width={14} height={14} strokeWidth={1.8} className="shrink-0" aria-hidden />
                  <span className="truncate">{name}</span>
                </span>
              )}
            </a>
          </li>
        );
      })}
    </ul>
  );
}
