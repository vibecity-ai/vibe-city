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
    case 'trading-desk': case 'prediction-desk': case 'treasury-ops': {
      standingScreen(c, 202, 26, 34, 10, 20, '#1A1530');
      box(c, 206, 12, 0, 22, 10, 11, '#3A2448', { top: '#5A3A6A' }); // the desk under it
      break;
    }
    case 'marketplace-agency': {
      // the job board: a cork board on legs with a JOBS header, and the delivery desk under it with parcels going out
      standingScreen(c, 202, 26, 34, 10, 20, '#4A2E1C');
      const S = face(c, 202, 26, 10, 34, 20);
      quadOn(c, S, 0, 0, 34, 20, '#8A5A30', 0);
      for (let i = 0; i < 14; i++) { const p = S(1 + hash(i, 11) * 32, 1 + hash(i, 12) * 18); px.dot(Math.floor(p[0]), Math.floor(p[1]), '#6E4424'); }
      px.text('JOBS', (a, b) => S(2 + a, 1.5 + b), 1, '#F6E7C0');
      box(c, 206, 12, 0, 22, 10, 11, '#3A2448', { top: '#5A3A6A' });
      box(c, 209, 14, 11, 5, 4, 4, '#B07A40', { top: '#D09A5A' });
      box(c, 215, 15, 11, 4, 3, 3, '#9A6A38', { top: '#C08A50' });
      break;
    }
  }
}

export function stationLive(c: IC, templateId: string, lit: boolean) {
  const { px, L, t } = c;
  const on = lit ? 1 : 0.2;
  switch (templateId) {
    case 'trading-desk': case 'treasury-ops': {
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
    case 'marketplace-agency': {
      // job cards pinned in two rows; each moves working (cyan) -> delivered (gold) -> paid (mint), then a new one
      const S = face(c, 202, 26, 10, 34, 20);
      const cols = [C.cyan, C.gold, C.mint];
      for (let r = 0; r < 2; r++) for (let k = 0; k < 4; k++) {
        const i = r * 4 + k, x = 1.5 + k * 8, y = 7.5 + r * 6.5, st = Math.floor(t * 0.35 + hash(i, 21) * 3) % 3;
        quadOn(c, S, x, y, 7, 5.5, lit ? '#E6DABA' : '#8C8470', 0);
        quadOn(c, S, x + 1, y + 1.4, 4 + hash(i, 22) * 1.5, 0.6, '#6A6080', 0);
        quadOn(c, S, x + 1, y + 2.6, 3 + hash(i, 23) * 2, 0.6, '#6A6080', 0);
        quadOn(c, S, x, y + 4.2, 7, 1.3, cols[st]!, 0.7 * on);
        const pin = S(x + 3.5, y + 0.3); px.dot(Math.floor(pin[0]), Math.floor(pin[1]), C.red, 0.4 * on);
      }
      // a payout coin on the desk, glinting now and then
      const glint = Math.max(0, Math.sin(t * 1.3)) ** 6, p = c.P(222, 16, 11);
      px.ellipse(p[0], p[1], 2.5, 1.4, C.gold, on);
      if (lit) { L.add(...c.P(219, 26, 22), 40, '#FFD27A', 0.14); L.add(p[0], p[1], 8 + 8 * glint, C.gold, 0.5 * glint); }
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
  }
}
