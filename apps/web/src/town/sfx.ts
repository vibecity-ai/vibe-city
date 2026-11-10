/* Little synthesized sounds for the city's big moments (no audio files): a chime per kind of event, quiet by default
   and easy to mute (the speaker key in the top bar; remembered in this browser). Browsers only allow sound after the
   player has clicked or typed something, so the first sounds of a visit may be skipped. */

export type Sfx = 'floor' | 'job' | 'done' | 'hire' | 'scout' | 'shortlist' | 'input' | 'tick' | 'fail' | 'lift' | 'pass' | 'coin';

const KEY = 'vc-sound';
let muted = (() => { try { return localStorage.getItem(KEY) === 'off'; } catch { return false; } })();
const subs = new Set<(m: boolean) => void>();
export const isMuted = () => muted;
export function setMuted(m: boolean) {
  muted = m;
  try { localStorage.setItem(KEY, m ? 'off' : 'on'); } catch { /* private window: forget it */ }
  for (const f of subs) f(m);
}
export function onMuted(f: (m: boolean) => void) { subs.add(f); return () => { subs.delete(f); }; }

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
function audio(): AudioContext | null {
  if (typeof window === 'undefined' || !('AudioContext' in window)) return null;
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain(); master.gain.value = 0.16; master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
  return ctx;
}

const N = (name: string) => {
  const m = /^([A-G])(#?)(\d)$/.exec(name)!;
  const semis = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 }[m[1] as 'C'] + (m[2] ? 1 : 0) + (Number(m[3]) - 4) * 12;
  return 440 * 2 ** (semis / 12);
};

/** One enveloped note: quick attack, exponential tail. */
function note(c: AudioContext, freq: number, at: number, dur: number, type: OscillatorType, vol: number, glideTo?: number) {
  const o = c.createOscillator(), g = c.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, at);
  if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, at + dur * 0.8);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(vol, at + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g); g.connect(master!);
  o.start(at); o.stop(at + dur + 0.02);
}
/** A short burst of filtered noise (paper, a stamp). */
function noise(c: AudioContext, at: number, dur: number, vol: number, hz: number) {
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
  src.buffer = buf; f.type = 'bandpass'; f.frequency.value = hz; g.gain.value = vol;
  src.connect(f); f.connect(g); g.connect(master!); src.start(at);
}

const last = new Map<Sfx, number>();
export function play(kind: Sfx) {
  if (muted) return;
  const c = audio(); if (!c) return;
  // the same sound twice within a beat is one sound (several tasks finishing in one refresh)
  const now = c.currentTime; if (now - (last.get(kind) ?? -9) < (kind === 'pass' ? 0.08 : 0.35)) return; last.set(kind, now);
  const t = now + 0.02;
  const seq = (notes: string[], step: number, dur: number, type: OscillatorType, vol: number) => notes.forEach((n, i) => note(c, N(n), t + i * step, dur, type, vol));
  switch (kind) {
    case 'floor': // a rising neon arpeggio with a sparkle on top
      seq(['C5', 'E5', 'G5', 'C6'], 0.085, 0.5, 'square', 0.18); seq(['C4', 'G4'], 0.17, 0.7, 'triangle', 0.3);
      seq(['E6', 'G6', 'C7'], 0.3, 0.35, 'sine', 0.08); note(c, N('C7'), t + 0.42, 0.6, 'sine', 0.1);
      break;
    case 'job': // paper out of the printer, then a two-note go
      noise(c, t, 0.18, 0.35, 2600); seq(['G5', 'D6'], 0.09, 0.3, 'square', 0.16);
      break;
    case 'done': // a little fanfare
      seq(['G4', 'C5', 'E5', 'G5'], 0.07, 0.35, 'square', 0.16); note(c, N('C6'), t + 0.3, 0.9, 'triangle', 0.26); note(c, N('E6'), t + 0.3, 0.9, 'sine', 0.12);
      break;
    case 'hire': // the elevator ding
      note(c, N('E6'), t, 1.4, 'sine', 0.3); note(c, N('C6'), t + 0.22, 1.6, 'sine', 0.28); note(c, N('E7'), t, 0.25, 'triangle', 0.05);
      break;
    case 'scout': // a radar sweep: three pings fading away
      for (let i = 0; i < 3; i++) note(c, 1320, t + i * 0.28, 0.4, 'sine', 0.22 / (i + 1), 980);
      break;
    case 'shortlist': // the desk phone, twice
      for (let i = 0; i < 2; i++) { note(c, N('A5'), t + i * 0.22, 0.12, 'square', 0.12); note(c, N('C#6'), t + i * 0.22 + 0.06, 0.12, 'square', 0.1); }
      break;
    case 'input': // a polite two-tone nudge
      seq(['A5', 'E5'], 0.16, 0.32, 'triangle', 0.28);
      break;
    case 'tick': // a task done: a small bright blip
      note(c, N('E6'), t, 0.12, 'square', 0.07); note(c, N('B6'), t + 0.05, 0.14, 'sine', 0.06);
      break;
    case 'lift': // the lift arrives: one soft bell
      note(c, N('E6'), t, 0.9, 'sine', 0.2); note(c, N('E7'), t, 0.18, 'triangle', 0.035);
      break;
    case 'pass': // the lift passes a floor: a tiny click
      note(c, 2400, t, 0.03, 'square', 0.03);
      break;
    case 'coin': // money in: two bright notes
      seq(['B5', 'E6'], 0.07, 0.22, 'square', 0.1);
      break;
    case 'fail': // a soft low thud
      note(c, 180, t, 0.35, 'triangle', 0.3, 90);
      break;
  }
}
