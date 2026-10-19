"use client";

import { useEffect, useState } from "react";
import type { ProjectConfig, ProjectEntry, ScriptSeed } from "@/lib/projects";
import { api, ApiError } from "./api";

/* Settings > Projects on the server (/api/projects): the project a folder belongs to, cached a little per folder so
 * the new session screen and the Run menu don't ask on every keystroke or render. Saving anywhere refreshes them. */

export const PROJECTS_CHANGED = "agentu:projects";
const TTL = 30_000;

type ForDir = { project: ProjectConfig | null; runDir: string | null };
const cache = new Map<string, { at: number; p: Promise<ForDir> }>();

function lookup(dir: string): Promise<ForDir> {
  const hit = cache.get(dir);
  if (hit && Date.now() - hit.at < TTL) return hit.p;
  const p = api<ForDir>(`/api/projects?for=${encodeURIComponent(dir)}`).catch(() => {
    cache.delete(dir);
    return { project: null, runDir: null };
  });
  cache.set(dir, { at: Date.now(), p });
  return p;
}

/** The project `dir` belongs to (null while loading, for none, and for "" or relative folders). */
export function useProjectFor(dir: string, delayMs = 0): ForDir {
  const [state, setState] = useState<{ dir: string; data: ForDir } | null>(null);
  const [rev, setRev] = useState(0);
  useEffect(() => {
    const on = () => {
      cache.clear();
      setRev((n) => n + 1);
    };
    window.addEventListener(PROJECTS_CHANGED, on);
    return () => window.removeEventListener(PROJECTS_CHANGED, on);
  }, []);
  useEffect(() => {
    if (!dir.startsWith("/")) return;
    let live = true;
    const t = setTimeout(() => void lookup(dir).then((data) => live && setState({ dir, data })), delayMs);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [dir, delayMs, rev]);
  return state?.dir === dir ? state.data : { project: null, runDir: null };
}

async function send<T>(method: "PUT" | "DELETE", body: unknown): Promise<T> {
  const res = await fetch("/api/projects", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status);
  return data;
}

const changed = () => {
  cache.clear();
  window.dispatchEvent(new Event(PROJECTS_CHANGED));
};

export const listProjects = () => api<{ projects: ProjectEntry[] }>("/api/projects").then((d) => d.projects);
export const scriptsIn = (dir: string) => api<ScriptSeed>(`/api/projects?scripts=${encodeURIComponent(dir)}`);

export async function saveProject(project: ProjectConfig): Promise<ProjectConfig> {
  const r = await send<{ project: ProjectConfig }>("PUT", { project });
  changed();
  return r.project;
}

export async function forgetProject(path: string): Promise<void> {
  await send("DELETE", { path });
  changed();
}

export const runAction = (cwd: string, action: string) => api<{ id: string; backing: "tmux" | "pty"; label: string; cwd: string }>("/api/projects/run", { cwd, action });
