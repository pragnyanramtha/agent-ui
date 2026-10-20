"use client";

import type { NotifyKind } from "@/lib/notify-events";

/* Short tones made on the spot with WebAudio: no sound files. Browsers only let a page make sound after the user
 * has interacted with it, so the audio context is created (or resumed) on the first tap or key press. */

export type Note = { freq: number; at: number; dur: number; type: OscillatorType };

/** finished: a soft rising pair; needs you: two quick bright pings; failed: a low falling pair */
export function tonePlan(kind: NotifyKind): Note[] {
  switch (kind) {
    case "done":
      return [
        { freq: 659.25, at: 0, dur: 0.14, type: "sine" },
        { freq: 987.77, at: 0.11, dur: 0.22, type: "sine" },
      ];
    case "needs":
      return [
        { freq: 1046.5, at: 0, dur: 0.1, type: "triangle" },
        { freq: 1046.5, at: 0.16, dur: 0.14, type: "triangle" },
      ];
    case "failed":
      return [
        { freq: 392, at: 0, dur: 0.16, type: "triangle" },
        { freq: 293.66, at: 0.14, dur: 0.28, type: "triangle" },
      ];
  }
}

/** 0-100 to a gain: perceived loudness is closer to the square, and full volume stays well short of clipping */
export const gainFor = (volume: number) => 0.3 * (Math.min(100, Math.max(0, volume)) / 100) ** 2;

let ctx: AudioContext | null = null;
let armed = false;

function context(): AudioContext | null {
  if (ctx) return ctx;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  try {
    ctx = new AC();
  } catch {
    return null;
  }
  return ctx;
}

/** Lets later sounds play: call once on load. The first interaction unlocks audio. */
export function armSounds() {
  if (armed || typeof window === "undefined") return;
  armed = true;
  const unlock = () => {
    const c = context();
    if (c && c.state === "suspended") void c.resume().catch(() => undefined);
    if (c?.state === "running") {
      window.removeEventListener("pointerdown", unlock, true);
      window.removeEventListener("keydown", unlock, true);
    }
  };
  window.addEventListener("pointerdown", unlock, true);
  window.addEventListener("keydown", unlock, true);
}

/** Plays the tone for an event at a 0-100 volume. Quietly does nothing where audio isn't allowed yet. */
export function playTone(kind: NotifyKind, volume: number) {
  if (typeof window === "undefined") return;
  const c = context();
  if (!c) return;
  if (c.state === "suspended") void c.resume().catch(() => undefined);
  const peak = gainFor(volume);
  if (peak <= 0) return;
  const start = c.currentTime + 0.02;
  for (const n of tonePlan(kind)) {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = n.type;
    osc.frequency.value = n.freq;
    /* a quick attack and an exponential tail: no clicks at either end */
    const t = start + n.at;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + n.dur);
    osc.connect(gain).connect(c.destination);
    osc.start(t);
    osc.stop(t + n.dur + 0.02);
  }
}
