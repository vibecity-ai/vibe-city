/* A department floor's controls: the objects every floor shares (Kanban wall, the lead's office, meeting table, server
   rack, wall clock, elevator) and the station a template brings in place of the lounge. Footprints are room boxes
   (u, v, h, du, dv, dh), hit-tested and outlined like the Executive Office's (execRoom.ts). What each opens is in
   data/floor.ts and ui/FloorSheet.tsx. */
import type { FloorObjectId } from '../data/floor';
import type { Pt } from './pix';
import { box, C, hash, type IC } from './interior';
import { shade } from './sprites';

export type Box6 = [number, number, number, number, number, number];
export interface FloorObject { id: FloorObjectId; label: string; b: Box6 }

const COMMON: FloorObject[] = [
  { id: 'board', label: 'Kanban wall', b: [95, 138, 4, 82, 2, 38] },
  { id: 'lead', label: 'Lead’s office', b: [12, 114, 0, 40, 20, 26] },
  { id: 'meeting', label: 'Meeting table', b: [24, 6, 0, 44, 32, 16] },
  { id: 'rack', label: 'Tools & access', b: [0, 56, 0, 14, 18, 44] },
  { id: 'clock', label: 'Schedules', b: [-1, 78, 24, 2, 14, 14] },
  { id: 'elevator', label: 'Hire', b: [-1, 18, 0, 2, 34, 44] },
];
/** The station stands where the lounge would be. */
export const STATION_BOX: Box6 = [200, 8, 0, 38, 34, 30];

export function floorObjects(stationName: string | null): FloorObject[] {
  return stationName ? [...COMMON, { id: 'station', label: stationName, b: STATION_BOX }] : COMMON;
}

/* ---------------- wall clock (left wall, above the rack's right) ---------------- */

export function clockLive(c: IC, lit: boolean, now: Date) {
  const { P, px, L } = c;
  const W = (v: number, h: number): Pt => P(0, v, h);
  const cv = 85, ch = 31, r = 5.5;
  px.poly([W(cv - r - 1, ch - r - 1), W(cv + r + 1, ch - r - 1), W(cv + r + 1, ch + r + 1), W(cv - r - 1, ch + r + 1)], '#2A2348');
  px.poly([W(cv - r, ch - r), W(cv + r, ch - r), W(cv + r, ch + r), W(cv - r, ch + r)], lit ? '#E8E3FA' : '#8C84B8');
  for (let k = 0; k < 12; k += 3) { const a = (k / 12) * Math.PI * 2; px.dot(...(W(cv + Math.sin(a) * (r - 1), ch + Math.cos(a) * (r - 1)).map(Math.floor) as Pt), '#2A2348'); }
  const m = now.getMinutes() / 60, h = (now.getHours() % 12 + m) / 12;
  const hand = (k: number, len: number, col: string) => px.line(W(cv, ch), W(cv + Math.sin(k * Math.PI * 2) * len, ch + Math.cos(k * Math.PI * 2) * len), col, 1, 0);
  hand(h, r * 0.55, '#1A1530'); hand(m, r * 0.85, '#FF3EA5');
  if (lit) L.add(...W(cv, ch), 16, '#FFE7B0', 0.18, 1);
}

/* ---------------- stations: one per template ---------------- */

/** A screen face on the plane v = v0 (facing the viewer), from u0 to u0 + w, height h0 to h0 + hh. */
function face(c: IC, u0: number, v0: number, h0: number, w: number, hh: number) {
  const { P } = c;
  return (a: number, b: number): Pt => P(u0 + a, v0, h0 + hh - b);
}
function quadOn(c: IC, S: (a: number, b: number) => Pt, a: number, b: number, w: number, h: number, col: string, em = 1) {
  c.px.poly([S(a, b), S(a + w, b), S(a + w, b + h), S(a, b + h)], col, em);
}
/** A free-standing screen on two legs, facing the room. */
function standingScreen(c: IC, u: number, v: number, w: number, h0: number, hh: number, frame: string) {
  const { P, px } = c;
  for (const du of [3, w - 3]) { px.line(P(u + du, v + 1, 0), P(u + du, v + 1, h0), '#4A4370'); }
  box(c, u - 1, v, h0 - 1, w + 2, 2, hh + 2, frame, { top: shade(frame, 0.2) });
}

export function stationStatic(c: IC, templateId: string) {
  const { P, px } = c;
  switch (templateId) {
    case 'software': {
      // a standing desk with two monitors and a build server
      box(c, 204, 16, 0, 26, 14, 12, '#2E2752', { top: '#4A4370' });
      box(c, 230, 10, 0, 7, 9, 22, '#221C3E', { top: '#3A3460' });
      for (let h = 4; h < 20; h += 4) px.line(P(237, 11, h), P(237, 18, h), '#151129');
      box(c, 205, 24, 12, 11, 2, 9, '#15112A', { top: '#2A2448' });
      box(c, 218, 24, 12, 11, 2, 9, '#15112A', { top: '#2A2448' });
      box(c, 209, 18, 12, 10, 4, 1, '#3A3458', { edge: false }); // keyboard
      break;
    }
    case 'trading-desk': case 'prediction-desk': {
      standingScreen(c, 202, 26, 34, 10, 20, '#1A1530');
      box(c, 206, 12, 0, 22, 10, 11, '#3A2448', { top: '#5A3A6A' }); // the desk under it
      break;
    }
    case 'token-treasury': {
      // the vault: a steel block with a round door facing the room, and a small DAO podium
      box(c, 204, 30, 0, 30, 8, 30, '#3A3A52', { top: '#5A5A78', left: '#4A4A66' });
      const S = face(c, 204, 30, 0, 30, 30);
      px.ellipse(S(15, 15)[0], S(15, 15)[1], 11, 9, '#2A2A40');
      px.ring(S(15, 15)[0], S(15, 15)[1], 11, 9, '#8C8CB0', 1);
      box(c, 210, 12, 0, 10, 8, 14, '#5A3A20', { top: '#7A5230' });
      break;
    }
    case 'red-team': {
      // a map table with a lamp
      for (const [u, v] of [[206, 14], [232, 14], [206, 34], [232, 34]] as Pt[]) px.line(P(u, v, 0), P(u, v, 12), '#4A2030');
      box(c, 204, 12, 12, 30, 24, 2, '#2A1418', { top: '#1E2A22' });
      const T = (a: number, b: number): Pt => P(204 + a, 12 + b, 14);
      for (let a = 3; a < 30; a += 5) px.line(T(a, 1), T(a, 23), '#2E4A36');
      for (let b = 3; b < 24; b += 5) px.line(T(1, b), T(29, b), '#2E4A36');
      px.line(P(236, 40, 0), P(236, 40, 30), '#4A2030');
      box(c, 232, 36, 30, 7, 6, 4, '#5A2030', { top: '#7A2A40' });
      break;
    }
    case 'blue-team': {
      box(c, 204, 16, 0, 32, 14, 12, '#1E2A4A', { top: '#2E3E6A' });
      for (const u of [205, 216, 227]) box(c, u, 26, 12, 9, 2, 10, '#0E1428', { top: '#1E2A4A' });
      // a shield on the wall behind
      const S = (a: number, b: number): Pt => P(238, 6 + a, 26 + b);
      px.poly([S(10, 10), S(22, 10), S(22, 3), S(16, -3), S(10, 3)], '#2E5AA8');
      px.poly([S(12, 8), S(20, 8), S(20, 3), S(16, -1), S(12, 3)], '#4A8AE8');
      break;
    }
  }
}

export function stationLive(c: IC, templateId: string, lit: boolean) {
  const { px, L, t } = c;
  const on = lit ? 1 : 0.2;
  switch (templateId) {
    case 'software': {
      // pipeline runs: rows of steps turning green, one failing now and then
      for (const [u0, seed] of [[205, 1], [218, 2]] as [number, number][]) {
        const S = face(c, u0, 24, 13, 11, 8);
        quadOn(c, S, 0, 0, 11, 8, '#06141E', 0.9 * on);
        const k = Math.floor(t * 1.5 + seed);
        for (let r = 0; r < 3; r++) for (let s = 0; s < 4; s++) {
          const done = (k + r) % 5 > s, bad = hash(k + r, seed) > 0.92 && s === 3;
          quadOn(c, S, 1 + s * 2.5, 1 + r * 2.4, 2, 1.6, bad ? C.red : done ? C.mint : '#2A3A4A', on);
        }
      }
      for (let r = 0; r < 4; r++) { const p = c.P(237, 12 + r * 1.6, 6 + r * 4); px.dot(Math.floor(p[0]), Math.floor(p[1]), lit && hash(r, Math.floor(t * 3)) > 0.4 ? C.mint : '#1E3A2E', on); }
      if (lit) L.add(...c.P(216, 26, 18), 34, C.mint, 0.35);
      break;
    }
    case 'trading-desk': {
      const S = face(c, 202, 26, 10, 34, 20);
      quadOn(c, S, 0, 0, 34, 20, '#07121A', 0.9 * on);
      px.text('ETH', (a, b) => S(2 + a, 2 + b), 1, C.gold, on);
      // candles drifting left
      for (let i = 0; i < 9; i++) {
        const k = Math.floor(t * 0.8) + i, up = hash(k, 3) > 0.42, mid = 12 + Math.sin(k * 0.7) * 3, body = 1.5 + hash(k, 5) * 3;
        const x = 2 + i * 3.6;
        quadOn(c, S, x + 0.8, mid - body - 1.5, 0.4, body * 2 + 3, up ? C.mint : C.red, on);
        quadOn(c, S, x, mid - body, 2, body * 2, up ? C.mint : C.red, on);
      }
      if (lit) L.add(...c.P(219, 26, 22), 46, C.mint, 0.3);
      break;
    }
    case 'prediction-desk': {
      const S = face(c, 202, 26, 10, 34, 20);
      quadOn(c, S, 0, 0, 34, 20, '#120A20', 0.9 * on);
      for (let r = 0; r < 3; r++) {
        const p = 0.25 + 0.5 * (0.5 + 0.5 * Math.sin(t * 0.3 + r * 2));
        quadOn(c, S, 2, 3 + r * 5.5, 30, 3, '#2A1E40', on);
        quadOn(c, S, 2, 3 + r * 5.5, 30 * p, 3, r === 1 ? C.violet : C.cyan, on);
        px.text(`${Math.round(p * 100)}`, (a, b) => S(24 + a * 0.8, 3.2 + r * 5.5 + b * 0.8), 0.8, '#F4EEFF', on);
      }
      if (lit) L.add(...c.P(219, 26, 22), 46, C.violet, 0.3);
      break;
    }
    case 'token-treasury': {
      const S = face(c, 204, 30, 0, 30, 30);
      const [x, y] = S(15, 15), a = t * 0.4;
      for (let k = 0; k < 6; k++) { const q = a + (k / 6) * Math.PI * 2; px.line([x, y], [x + Math.cos(q) * 6, y + Math.sin(q) * 4.5], C.gold, 1, on); }
      px.ellipse(x, y, 1.5, 1.2, C.gold, on);
      const p = c.P(215, 16, 15); px.ellipse(p[0], p[1], 3, 1.6, C.gold, on); // a coin on the podium
      if (lit) L.add(x, y, 40, C.gold, 0.45);
      break;
    }
    case 'red-team': {
      const T = (a: number, b: number): Pt => c.P(204 + a, 12 + b, 14);
      for (let i = 0; i < 4; i++) {
        const [a, b] = [5 + hash(i, 1) * 20, 4 + hash(i, 2) * 16], pulse = 0.5 + 0.5 * Math.sin(t * 3 + i);
        const p = T(a, b); px.dot(Math.floor(p[0]), Math.floor(p[1]) - 1, C.red, on, 2);
        if (lit) L.add(p[0], p[1], 10 + 6 * pulse, C.red, 0.35 * pulse);
      }
      if (lit) L.add(...c.P(235, 39, 30), 40, '#FF6B6B', 0.4);
      break;
    }
    case 'blue-team': {
      for (const [u0, i] of [[205, 0], [216, 1], [227, 2]] as [number, number][]) {
        const S = face(c, u0, 26, 13, 9, 8);
        quadOn(c, S, 0, 0, 9, 8, '#06102A', 0.9 * on);
        const k = Math.floor(t * 2 + i);
        for (let r = 0; r < 3; r++) quadOn(c, S, 1, 1 + r * 2.4, 2 + hash(k + r, i) * 5, 1, hash(k + r, i + 7) > 0.85 ? C.amber : '#4A8AE8', on);
      }
      if (lit) L.add(...c.P(220, 26, 20), 40, '#4A8AE8', 0.35);
      break;
    }
  }
}
