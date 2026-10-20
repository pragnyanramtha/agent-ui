import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentId } from "@/lib/types";
import { codexHome } from "./codex-files";
import { childEnv } from "../child-env";
import { pickProfile, type ResolvedProfile } from "../profiles";

/* The models each agent CLI offers, asked from the CLI itself (they change with accounts and releases). */

export type ModelChoice = { key: string; name: string };

const TTL = 10 * 60_000;
const cache = new Map<string, { at: number; list: Promise<ModelChoice[]> }>();

function run(p: ResolvedProfile, args: string[]): Promise<string> {
  if (!p.binPath) return Promise.resolve("");
  return new Promise((resolve) =>
    execFile(p.binPath!, args, { env: childEnv(p.env, { NO_COLOR: "1" }), timeout: 30_000, maxBuffer: 4 << 20 }, (_err, stdout) => resolve(String(stdout ?? ""))),
  );
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const lines = (out: string) => out.replace(ANSI, "").replace(/[\u200b-\u200d\ufeff]/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
const ID = /^[A-Za-z0-9][\w.:/@-]*$/;

/** `id - Name` rows (cursor-agent models); a trailing "(current, default)" is dropped */
export function dashRows(out: string): ModelChoice[] {
  const rows: ModelChoice[] = [];
  for (const l of lines(out)) {
    const m = /^(\S+)\s+-\s+(.+?)(?:\s+\((?:current|default)[^)]*\))?$/.exec(l);
    if (m && ID.test(m[1])) rows.push({ key: m[1], name: m[2].trim() });
  }
  return rows;
}

/** `slug  Display Name` rows (agy models): two or more spaces between the columns */
export function spacedRows(out: string): ModelChoice[] {
  const rows: ModelChoice[] = [];
  for (const l of lines(out)) {
    const m = /^(\S+)\s{2,}(.+)$/.exec(l);
    if (m && ID.test(m[1]) && !/:$/.test(m[1]) && !/^(slug|id|models?)$/i.test(m[1])) rows.push({ key: m[1], name: m[2].trim() });
  }
  return rows;
}

/* gemini has no models command; aliases first, then the ids its model router knows */
export const GEMINI_MODELS: ModelChoice[] = [
  { key: "auto", name: "Auto" },
  { key: "pro", name: "Pro" },
  { key: "flash", name: "Flash" },
  { key: "flash-lite", name: "Flash Lite" },
  { key: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro (preview)" },
  { key: "gemini-3.5-flash", name: "Gemini 3.5 Flash" },
  { key: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite" },
  { key: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
];

async function codexModels(p: ResolvedProfile): Promise<ModelChoice[]> {
  const home = p.env.CODEX_HOME || codexHome();
  try {
    const d = JSON.parse(await fs.readFile(path.join(home, "models_cache.json"), "utf8")) as { models?: { slug?: string; display_name?: string; visibility?: string }[] };
    return (d.models ?? [])
      .filter((m) => m.slug && m.visibility !== "hide" && !/auto-review/.test(m.slug))
      .map((m) => ({ key: m.slug!, name: m.display_name || m.slug! }));
  } catch {
    return [];
  }
}

async function load(agent: AgentId, p: ResolvedProfile): Promise<ModelChoice[]> {
  switch (agent) {
    case "cursor":
      return dashRows(await run(p, ["models"])).filter((m) => m.key !== "auto");
    case "opencode":
      return lines(await run(p, ["models"]))
        .filter((l) => /^[\w.-]+\/\S+$/.test(l))
        .map((l) => ({ key: l, name: l }));
    case "codex":
      return codexModels(p);
    case "devin": {
      const out = await run(p, ["models", "list"]);
      const dash = dashRows(out);
      if (dash.length) return dash;
      return lines(out)
        .map((l) => l.replace(/^[-*•]\s*/, "").split(/\s+/)[0])
        .filter((t) => ID.test(t) && /\d|-/.test(t) && !/:$/.test(t))
        .map((t) => ({ key: t, name: t }));
    }
    case "gemini":
      return GEMINI_MODELS;
    case "antigravity":
      return spacedRows(await run(p, ["models"]));
    default:
      return [];
  }
}

/** Models for an agent under a profile (its binary and env); empty when the CLI can't say. */
export function agentModels(agent: AgentId, profile: unknown): Promise<ModelChoice[]> {
  const p = pickProfile(agent, profile);
  const key = `${agent}:${p.id}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.list;
  const list = load(agent, p).catch(() => []);
  cache.set(key, { at: Date.now(), list });
  /* an empty answer (logged out, slow start) is retried sooner */
  void list.then((l) => !l.length && cache.get(key)?.list === list && cache.set(key, { at: Date.now() - TTL + 30_000, list }));
  return list;
}
