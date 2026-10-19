"use client";

import { Fragment, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Search, Undo, Xmark } from "iconoir-react";
import { setSetting } from "@/lib/client/settings";
import { comboFor, isMac, setRecording, useBindings } from "@/lib/client/shortcuts";
import {
  allConflicts,
  chordFromEvent,
  chordLabel,
  chordParts,
  COMMAND_GROUPS,
  COMMANDS,
  commandById,
  conflictsFor,
  isCustom,
  keysFor,
  reservedBy,
  serializeBindings,
  withKeys,
  type Bindings,
  type Command,
  type CommandId,
} from "@/lib/keybindings";
import { Card } from "./controls";

const save = (b: Bindings) => setSetting("keybindings", serializeBindings(b));

function Caps({ chord, mac }: { chord: string; mac: boolean }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {chordParts(chord, mac).map((k, i) => (
        <kbd key={i} className="inline-flex h-[20px] min-w-[20px] items-center justify-center rounded-[5px] border border-line bg-field px-1.5 font-sans text-xs leading-none text-ink-2 tabular-nums">
          {k}
        </kbd>
      ))}
    </span>
  );
}

function ShortcutRow({ cmd, bindings, mac, conflicts, recording, onRecord }: { cmd: Command; bindings: Bindings; mac: boolean; conflicts: CommandId[]; recording: boolean; onRecord: (on: boolean) => void }) {
  const id = cmd.id as CommandId;
  const keys = keysFor(id, bindings);
  const custom = isCustom(id, bindings);
  const [warn, setWarn] = useState<string | null>(null);
  useEffect(() => {
    if (!warn) return;
    const t = setTimeout(() => setWarn(null), 8000);
    return () => clearTimeout(t);
  }, [warn]);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    /* Tab keeps moving focus, so the list can't trap the keyboard */
    if (e.key === "Tab" && plain) return onRecord(false);
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape" && plain && !e.shiftKey) return onRecord(false);
    if ((e.key === "Backspace" || e.key === "Delete") && plain && !e.shiftKey) {
      save(withKeys(bindings, id, []));
      setWarn(null);
      return onRecord(false);
    }
    const chord = chordFromEvent(e.nativeEvent, mac);
    if (!chord) return;
    const next = withKeys(bindings, id, [chord]);
    save(next);
    const clash = conflictsFor(id, chord, next, mac).map((o) => commandById(o)!.label);
    setWarn(reservedBy(chord, mac) ?? (clash.length ? `${chordLabel(chord, mac)} is also used by ${clash.join(", ")}.` : null));
    onRecord(false);
  };

  const others = conflicts.map((o) => commandById(o)!.label);
  const note = cmd.fixed ?? warn ?? (others.length ? `Same keys as ${others.join(", ")}.` : null);
  const tone = !cmd.fixed && (warn || others.length) ? "text-orange-ink" : "text-ink-3";
  return (
    <div className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-1.5 px-3.5 py-2">
      <div className="min-w-[min(100%,12rem)] flex-1">
        <div className="text-sm text-ink">{cmd.label}</div>
        {note && (
          <div className={`mt-0.5 text-xs leading-relaxed ${tone}`} role={warn ? "status" : undefined}>
            {note}
          </div>
        )}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {cmd.fixed ? (
          <span className="flex items-center gap-1.5 px-1.5 text-2xs text-ink-3">
            {keys.map((k) => (
              <Caps key={k} chord={k} mac={mac} />
            ))}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => onRecord(!recording)}
            onKeyDown={onKeyDown}
            onBlur={() => recording && onRecord(false)}
            aria-label={recording ? `Press the new keys for ${cmd.label}` : `Change shortcut for ${cmd.label}: ${keys.length ? keys.map((k) => chordLabel(k, mac)).join(" or ") : "none"}`}
            aria-pressed={recording}
            className={`tap relative flex h-8 min-w-24 items-center justify-end gap-1.5 rounded-control border px-2 text-2xs text-ink-3 transition-colors ${
              recording ? "border-accent bg-accent-tint text-accent-ink" : "border-transparent hover:border-line hover:bg-hover"
            }`}
          >
            {recording ? (
              <span className="text-xs font-medium">Press keys…</span>
            ) : keys.length ? (
              keys.map((k, i) => (
                <Fragment key={k}>
                  {i > 0 && <span aria-hidden>or</span>}
                  <Caps chord={k} mac={mac} />
                </Fragment>
              ))
            ) : (
              <span className="text-xs">None</span>
            )}
          </button>
        )}
        {!cmd.fixed && (
          <button
            type="button"
            onClick={() => {
              save(withKeys(bindings, id, cmd.keys));
              setWarn(null);
            }}
            disabled={!custom}
            aria-label={`Reset ${cmd.label} to ${cmd.keys.map((k) => chordLabel(k, mac)).join(" or ")}`}
            title="Reset to default"
            className="tap relative flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-hover hover:text-ink disabled:invisible"
          >
            <Undo width={14} height={14} strokeWidth={1.9} />
          </button>
        )}
      </div>
    </div>
  );
}

/** Settings > Keyboard: every command with its shortcuts; click one and press new keys to change it. */
export function KeyboardSection() {
  const bindings = useBindings();
  const [mac, setMac] = useState(false);
  useEffect(() => setMac(isMac()), []);
  const [query, setQuery] = useState("");
  const [recording, setRecordingId] = useState<CommandId | null>(null);
  useEffect(() => {
    setRecording(recording !== null);
    return () => setRecording(false);
  }, [recording]);
  const conflicts = useMemo(() => allConflicts(bindings, mac), [bindings, mac]);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = COMMANDS.filter((c) => {
    if (!words.length) return true;
    const hay = [c.label, c.group, ...(((c as Command).keywords) ?? []), ...keysFor(c.id, bindings).map((k) => `${k} ${chordLabel(k, mac)}`)].join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const changed = COMMANDS.filter((c) => isCustom(c.id, bindings)).length;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <div className="field-ring relative flex h-9 min-w-[min(100%,16rem)] flex-1 items-center gap-2 rounded-control border border-line bg-field px-2.5 md:h-8">
          <Search width={14} height={14} strokeWidth={2} className="shrink-0 text-ink-3" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && query && (e.preventDefault(), e.stopPropagation(), setQuery(""))}
            placeholder="Search shortcuts"
            aria-label="Search shortcuts"
            className="min-w-0 flex-1 bg-transparent text-[16px] text-ink outline-none placeholder:text-ink-3 md:text-sm md:pointer-coarse:text-[16px] [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button type="button" aria-label="Clear search" onClick={() => setQuery("")} className="tap relative -mr-1 flex size-6 items-center justify-center rounded-[6px] text-ink-3 hover:bg-hover hover:text-ink">
              <Xmark width={14} height={14} strokeWidth={2} />
            </button>
          )}
        </div>
        {changed > 0 && <span className="text-xs text-ink-3">{changed === 1 ? "1 shortcut changed" : `${changed} shortcuts changed`}</span>}
      </div>
      {COMMAND_GROUPS.map((g) => {
        const rows = shown.filter((c) => c.group === g);
        if (!rows.length) return null;
        return (
          <Card key={g} title={g}>
            {rows.map((c) => (
              <ShortcutRow
                key={c.id}
                cmd={c}
                bindings={bindings}
                mac={mac}
                conflicts={conflicts.get(c.id) ?? []}
                recording={recording === c.id}
                onRecord={(on) => setRecordingId(on ? c.id : null)}
              />
            ))}
          </Card>
        );
      })}
      {!shown.length && <p className="px-1 py-6 text-center text-sm text-ink-3">No shortcuts match &ldquo;{query.trim()}&rdquo;.</p>}
      <p className="px-1 text-xs leading-relaxed text-ink-3">
        Click a shortcut, then press the new keys. Esc cancels, Backspace removes it.
        {comboFor("shortcuts", mac, { bindings }) && ` Press ${comboFor("shortcuts", mac, { bindings })} outside a text field to see them anywhere.`}
      </p>
    </>
  );
}
