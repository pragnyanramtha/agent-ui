"use client";

import { useCallback, useSyncExternalStore } from "react";
import { ApiError } from "./api";
import { transient } from "./send";
import {
  DEFAULTS,
  DOM_ATTRS,
  DOM_VARS,
  PALETTES,
  SETTING_KEYS,
  SETTINGS,
  SYNCED_CACHE_KEY,
  decodeStored,
  diffSettings,
  domState,
  encodeStored,
  parseSettingsFile,
  parseValue,
  pickValid,
  serializeSettings,
  settingsIn,
  storageKey,
  type SectionId,
  type SettingChange,
  type SettingDef,
  type SettingKey,
  type Settings,
} from "@/lib/settings-schema";
import { migrateDeviceSettings } from "./settings-migrate";

/* The settings store. Device settings live in localStorage under their own keys (older keys keep their old format).
 * Synced settings are cached in localStorage for the first paint, fetched from /api/settings on load and on focus,
 * and written back as debounced JSON merges that survive reloads and flaky networks. Every tab updates through the
 * storage event. */

export type { Settings, SettingKey } from "@/lib/settings-schema";

const CHANGE = "agent-u:settings";
/* changes not yet confirmed by the server, kept so a reload or a dropped connection doesn't lose them */
const PENDING_KEY = "cui:synced-pending";
const PUSH_DELAY_MS = 400;
const PULL_EVERY_MS = 5_000;

const isSynced = (key: SettingKey) => SETTINGS[key].scope === "synced";
const def = (key: SettingKey) => SETTINGS[key] as SettingDef;

function lsGet(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

/* before the first read, so older stored choices come through */
if (typeof window !== "undefined") {
  try {
    migrateDeviceSettings(localStorage);
  } catch {}
}

/* ── synced cache ─────────────────────────────────────────── */

let cacheRaw: string | null | undefined;
let cache: Partial<Settings> = {};

function syncedValues(): Partial<Settings> {
  const raw = lsGet(SYNCED_CACHE_KEY);
  if (raw !== cacheRaw) {
    cacheRaw = raw;
    try {
      cache = pickValid(JSON.parse(raw ?? "{}"), "synced").values;
    } catch {
      cache = {};
    }
  }
  return cache;
}

function saveSynced(next: Partial<Settings>) {
  lsSet(SYNCED_CACHE_KEY, JSON.stringify(next));
  /* if storage is unavailable the memory copy still holds for this tab */
  cacheRaw = lsGet(SYNCED_CACHE_KEY);
  cache = next;
}

/* ── reads and writes ─────────────────────────────────────── */

function read<K extends SettingKey>(key: K): Settings[K] {
  if (isSynced(key)) {
    const v = syncedValues()[key];
    return (v === undefined ? DEFAULTS[key] : v) as Settings[K];
  }
  return decodeStored(key, lsGet(storageKey(key)));
}

let snap: Settings | null = null;

/** All settings as one object; the same object until a value changes, so it can feed useSyncExternalStore. */
function snapshot(): Settings {
  const next = {} as Record<SettingKey, unknown>;
  let same = snap !== null;
  for (const key of SETTING_KEYS) {
    next[key] = read(key);
    if (same && snap![key] !== next[key]) same = false;
  }
  if (same) return snap!;
  return (snap = next as Settings);
}

function changed() {
  applyAppearance();
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGE));
}

/** Writes several settings at once (one event, one server update). Invalid values are ignored. */
export function setSettings(values: Partial<Settings>) {
  const synced: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values) as [SettingKey, unknown][]) {
    const parsed = parseValue(def(key), value);
    if (!parsed.ok) continue;
    if (isSynced(key)) synced[key] = parsed.value;
    else lsSet(storageKey(key), encodeStored(key, parsed.value as Settings[typeof key]));
  }
  if (Object.keys(synced).length) {
    saveSynced({ ...syncedValues(), ...synced });
    queuePush(synced);
  }
  changed();
}

function write<K extends SettingKey>(key: K, value: Settings[K]) {
  setSettings({ [key]: value } as Partial<Settings>);
}

/** Puts settings back to their defaults. */
export function resetSettings(keys: readonly SettingKey[]) {
  const synced: Record<string, unknown> = { ...syncedValues() };
  const patch: Record<string, null> = {};
  for (const key of keys) {
    if (isSynced(key)) {
      delete synced[key];
      patch[key] = null;
    } else lsSet(storageKey(key), null);
  }
  if (Object.keys(patch).length) {
    saveSynced(synced as Partial<Settings>);
    queuePush(patch);
  }
  changed();
}

export const resetSection = (section: SectionId) => resetSettings(settingsIn(section).map((d) => d.key));
export const resetAllSettings = () => resetSettings(SETTING_KEYS);

/** True when every setting the section lists is at its default. */
export const sectionIsDefault = (values: Settings, section: SectionId) => settingsIn(section).every((d) => values[d.key] === d.default);

/* ── React ────────────────────────────────────────────────── */

const OWN_KEYS = new Set<string>([SYNCED_CACHE_KEY, ...SETTING_KEYS.filter((k) => !isSynced(k)).map(storageKey)]);

function subscribe(cb: () => void) {
  const onStorage = (e: StorageEvent) => (!e.key || OWN_KEYS.has(e.key)) && cb();
  window.addEventListener(CHANGE, cb);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE, cb);
    window.removeEventListener("storage", onStorage);
  };
}

export function useSetting<K extends SettingKey>(key: K): [Settings[K], (value: Settings[K]) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => DEFAULTS[key],
  );
  const set = useCallback((v: Settings[K]) => write(key, v), [key]);
  return [value, set];
}

/** Every setting at once, for screens that show many. */
export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, snapshot, () => DEFAULTS);
}

export const getSetting = read;
export const setSetting = write;
export const getSettings = snapshot;

/* ── appearance on <html> ─────────────────────────────────── */

/* Browser chrome color for the default palette, matched to --page. Other palettes carry their own (PALETTES). */
export const THEME_COLOR = { dark: PALETTES[0].dark.page, light: PALETTES[0].light.page } as const;

export const prefersDark = () => typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;

const COLOR_ATTRS = ["data-palette", "data-accent", "data-contrast"];

/** Puts the current settings on <html>: theme class, data attributes, CSS variables and the browser chrome color.
 * A change of colors swaps every token in one repaint instead of hundreds of mismatched fades. */
export function applyAppearance(values: Settings = snapshot()) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const next = domState(values, prefersDark());
  const recolor =
    root.classList.contains("dark") !== next.dark ||
    COLOR_ATTRS.some((a) => root.getAttribute(a) !== (next.attrs[a] ?? null)) ||
    root.style.getPropertyValue("--ah") !== (next.vars["--ah"] ?? "");
  if (recolor) root.classList.add("theme-switching");
  root.classList.toggle("dark", next.dark);
  for (const attr of DOM_ATTRS) {
    const v = next.attrs[attr];
    if (v === undefined) root.removeAttribute(attr);
    else if (root.getAttribute(attr) !== v) root.setAttribute(attr, v);
  }
  for (const name of DOM_VARS) {
    const v = next.vars[name];
    if (v === undefined) root.style.removeProperty(name);
    else root.style.setProperty(name, v);
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", next.themeColor);
  if (recolor) requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
}

/** Applies a theme choice to the page at once and stores it. */
export function applyTheme(theme: Settings["theme"]) {
  write("theme", theme);
}

/* ── server sync ──────────────────────────────────────────── */

type Patch = Partial<Record<SettingKey, unknown>>;

function loadPending(): Patch {
  try {
    const raw = JSON.parse(lsGet(PENDING_KEY) ?? "{}") as Record<string, unknown>;
    const out: Patch = {};
    for (const [k, v] of Object.entries(raw ?? {})) if (k in SETTINGS && isSynced(k as SettingKey) && (v === null || parseValue(def(k as SettingKey), v).ok)) out[k as SettingKey] = v;
    return out;
  } catch {
    return {};
  }
}

let pending: Patch = {};
let inflight: Patch = {};
let pendingLoaded = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let flushing = false;
let attempt = 0;
let lastPull = 0;

function ensurePending() {
  if (pendingLoaded) return;
  pendingLoaded = true;
  pending = { ...loadPending(), ...pending };
}

const savePending = () => lsSet(PENDING_KEY, Object.keys(pending).length ? JSON.stringify(pending) : null);

function queuePush(patch: Patch) {
  ensurePending();
  Object.assign(pending, patch);
  savePending();
  schedule(PUSH_DELAY_MS);
}

function schedule(ms: number) {
  clearTimeout(timer);
  timer = setTimeout(() => void flush(), ms);
}

async function request(method: "GET" | "PUT", body?: unknown): Promise<{ settings?: unknown }> {
  const res = await fetch("/api/settings", {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const data = (await res.json().catch(() => ({}))) as { settings?: unknown; error?: string };
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status);
  return data;
}

/** Sends the queued changes. Network trouble retries with backoff; a refusal drops them and reloads the server's copy. */
export async function flush(): Promise<void> {
  ensurePending();
  if (flushing || !Object.keys(pending).length) return;
  clearTimeout(timer);
  flushing = true;
  inflight = pending;
  pending = {};
  let again = false;
  try {
    const res = await request("PUT", inflight);
    attempt = 0;
    inflight = {};
    savePending();
    merge(res.settings);
    again = Object.keys(pending).length > 0;
  } catch (err) {
    pending = { ...inflight, ...pending };
    inflight = {};
    if (err instanceof ApiError && err.status === 400) {
      pending = {};
      void pull(true);
    } else if (transient(err) && attempt < 6) schedule(Math.min(30_000, 1000 * 2 ** attempt++));
    savePending();
  } finally {
    flushing = false;
  }
  if (again) schedule(PUSH_DELAY_MS);
}

/** Takes the server's settings, keeping local changes it hasn't confirmed yet. */
function merge(server: unknown) {
  ensurePending();
  const next: Record<string, unknown> = { ...pickValid(server, "synced").values };
  for (const [k, v] of Object.entries({ ...inflight, ...pending })) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  const sorted = (o: object) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  if (JSON.stringify(sorted(next)) === JSON.stringify(sorted(syncedValues()))) return;
  saveSynced(sorted(next) as Partial<Settings>);
  changed();
}

/** Fetches the server's settings (at most every few seconds unless forced). Failures keep the cached copy. */
export async function pull(force = false): Promise<void> {
  if (!force && Date.now() - lastPull < PULL_EVERY_MS) return;
  lastPull = Date.now();
  try {
    merge((await request("GET")).settings);
  } catch {}
}

let started = false;

/** Starts syncing and keeps <html> in step with settings changed in other tabs or by the OS. Safe to call twice. */
export function startSettings(): () => void {
  if (started || typeof window === "undefined") return () => undefined;
  started = true;
  ensurePending();
  applyAppearance();
  const onFocus = () => {
    void pull();
    void flush();
  };
  const onVisible = () => document.visibilityState === "visible" && onFocus();
  const onOnline = () => {
    attempt = 0;
    void flush();
  };
  const onStorage = (e: StorageEvent) => (!e.key || OWN_KEYS.has(e.key)) && applyAppearance();
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onScheme = () => read("theme") === "system" && applyAppearance();
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", onOnline);
  window.addEventListener("storage", onStorage);
  mq.addEventListener("change", onScheme);
  void pull(true).then(() => flush());
  return () => {
    started = false;
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("storage", onStorage);
    mq.removeEventListener("change", onScheme);
  };
}

/* ── export and import ────────────────────────────────────── */

export const exportSettings = (): string => serializeSettings(snapshot());

export type ImportResult = { ok: true; changes: SettingChange[]; skipped: string[]; previous: Partial<Settings> } | { ok: false; error: string };

/** Applies an exported settings file. Returns what changed, and the values before so the import can be undone. */
export function importSettings(text: string): ImportResult {
  const parsed = parseSettingsFile(text);
  if (!parsed.ok) return parsed;
  const current = snapshot();
  const changes = diffSettings(current, parsed.values);
  const previous = Object.fromEntries(changes.map((c) => [c.key, current[c.key]])) as Partial<Settings>;
  if (changes.length) setSettings(Object.fromEntries(changes.map((c) => [c.key, parsed.values[c.key]])) as Partial<Settings>);
  return { ok: true, changes, skipped: parsed.skipped, previous };
}
