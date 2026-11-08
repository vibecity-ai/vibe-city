/* The open office: a cut-away room drawn as pixel art at 1 art pixel per world unit.
   Static shell (floor, walls, windows, rugs, elevator frame, posters) is cached per department;
   furniture, people and screens are depth-sorted every frame. Lights are registered as we go. */
import type { QuestStatus } from '@vibe-city/shared';
import type { AgentStatus, Dept } from '../data/types';
import { Pix, Lights, textWidth, type Pt } from './pix';
import { shade, mix } from './sprites';

export const U = 240, V = 140, WH = 56;
export type PFn = (u: number, v: number, h?: number) => Pt;
export const mkP = (T: number): PFn => (u, v, h = 0) => [u + v, T + 56 + 0.5 * u - 0.5 * v - h];

export const C = {
  pink: '#FF3EA5', cyan: '#2EE6F0', violet: '#9B5CFF', gold: '#FFC75A', mint: '#7CF5B4', red: '#FF5C7A', amber: '#FFB547', orange: '#FF9A55', lav: '#B3ACDD', ash: '#9A94B8', ink: '#F4EEFF',
};
export const STATUS_COL: Record<AgentStatus, string> = { running: C.cyan, idle: C.lav, completed: C.mint, failed: C.red, disconnected: C.ash, awaiting: C.amber };

/* layout (u, v in room units) */
export const DESKS: Pt[] = [[136, 94], [180, 94], [136, 48], [180, 48], [92, 94], [92, 48]];
export const seatOf = (i: number): Pt => { const d = DESKS[i % DESKS.length]; return [d[0] + 14, d[1] - 8]; };
export const CHIEF_SEAT: Pt = [32, 111];
export const ELEVATOR: Pt = [24, 34];
export const BOARD_SPOT: Pt = [128, 122];
export const COFFEE: Pt = [210, 117];
export const LOUNGE: Pt = [214, 46];
export const COOLER: Pt = [172, 118];
export const OFFICE_DOOR: Pt = [60, 96];
export const AISLE = 74;
export const GAPS = [84, 128, 172, 216];

export const hash = (a: number, b = 0) => { let h = Math.imul(a * 374761393 + b * 668265263, 1274126177) ^ 0x5bd1e995; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

export interface IC { px: Pix; L: Lights; t: number; P: PFn; power: number }

/** Iso box with three shaded faces and pixel edge highlights. Visible faces: top, v-face (front-left), u-face (front-right). */
export function box(c: IC, u: number, v: number, h: number, du: number, dv: number, dh: number, col: string, o: { top?: string; right?: string; em?: number; edge?: boolean; left?: string } = {}) {
  const { P, px } = c, em = o.em ?? 0;
  const top = o.top ?? shade(col, 0.16), left = o.left ?? col, right = o.right ?? shade(col, -0.24);
  if (dh > 0) {
    px.poly([P(u, v, h), P(u + du, v, h), P(u + du, v, h + dh), P(u, v, h + dh)], left, em);
    px.poly([P(u + du, v, h), P(u + du, v + dv, h), P(u + du, v + dv, h + dh), P(u + du, v, h + dh)], right, em);
  }
  px.poly([P(u, v, h + dh), P(u + du, v, h + dh), P(u + du, v + dv, h + dh), P(u, v + dv, h + dh)], top, em);
  if (o.edge !== false && du >= 3 && dv >= 2) {
    px.line(P(u, v, h + dh), P(u + du, v, h + dh), shade(top, 0.3), 1, em);
    px.line(P(u + du, v, h + dh), P(u + du, v + dv, h + dh), shade(top, 0.14), 1, em);
    if (dh >= 3) px.line(P(u + du, v, h), P(u + du, v, h + dh), shade(left, 0.12), 1, em);
  }
}
/** Soft cast shadow on the floor: footprint swept away from the windows. */
export function cast(c: IC, u: number, v: number, du: number, dv: number, dh: number, a = 0.3) {
  const su = 0.42 * dh, sv = -0.32 * dh, P = c.P;
  const pts: Pt[] = [[u, v], [u + du, v], [u + du, v + dv], [u, v + dv], [u + su, v + sv], [u + du + su, v + sv], [u + du + su, v + dv + sv], [u + su, v + dv + sv]];
  c.px.shade(hull(pts).map(([a1, b1]) => P(a1, b1, 0)), a);
  c.px.shade([P(u - 1, v - 1), P(u + du + 1, v - 1), P(u + du + 1, v + dv + 1), P(u - 1, v + dv + 1)], 0.25);
}
export function hull(p: Pt[]): Pt[] {
  const s = p.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: Pt[] = [], up: Pt[] = [];
  for (const q of s) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = s.length - 1; i >= 0; i--) { const q = s[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

/* ------------------------------------------------------------------ static shell (cached) */
type Map2 = (a: number, h: number) => Pt;
export function shell(c: IC, d: Dept) {
  const { P, px } = c;
  const fl = shade(d.theme.floor, 0.3), flB = shade(fl, -0.07), grout = shade(fl, -0.3);
  // floor slab + cutaway edges
  px.poly([P(0, 0, 0), P(U, 0, 0), P(U, 0, -8), P(0, 0, -8)], '#3A3060');
  px.poly([P(U, 0, 0), P(U, V, 0), P(U, V, -8), P(U, 0, -8)], '#2A2248');
  px.line(P(0, 0, -3), P(U, 0, -3), '#26204A'); px.line(P(U, 0, -3), P(U, V, -3), '#1E1A3A');
  px.poly([P(0, 0), P(U, 0), P(U, V), P(0, V)], fl);
  for (let iu = 0; iu < U / 20; iu++) for (let iv = 0; iv < V / 20; iv++) {
    const u = iu * 20, v = iv * 20, hh = hash(iu + 7, iv + 3);
    const base = shade((iu + iv) % 2 ? fl : flB, (hh - 0.5) * 0.06);
    px.poly([P(u, v), P(u + 20, v), P(u + 20, v + 20), P(u, v + 20)], base);
    // polished sheen + specks
    px.poly([P(u + 2, v + 14), P(u + 9, v + 14), P(u + 9, v + 18), P(u + 2, v + 18)], shade(base, 0.05));
    for (let k = 0; k < 3; k++) { const p = P(u + 2 + hash(iu, iv * 9 + k) * 16, v + 2 + hash(iv, iu * 5 + k) * 16); px.dot(Math.floor(p[0]), Math.floor(p[1]), shade(base, k ? -0.12 : 0.14)); }
  }
  for (let u = 20; u < U; u += 20) px.line(P(u, 0), P(u, V), grout);
  for (let v = 20; v < V; v += 20) px.line(P(0, v), P(U, v), grout);
  // rugs: chief office + lounge
  rug(c, 6, 92, 58, 44, '#6E2A63', '#C8478F', '#FFC75A');
  rug(c, 196, 4, 42, 34, '#1E5A6A', '#2EB8C8', '#7CF5B4');
  // ambient occlusion where floor meets the walls
  for (const [w, a] of [[2, 0.34], [5, 0.2], [9, 0.09]] as [number, number][]) {
    px.shade([P(0, 0), P(w, 0), P(w, V - w), P(0, V)], a);
    px.shade([P(0, V - w), P(U, V - w), P(U, V), P(0, V)], a);
  }

  // back walls
  const WL: Map2 = (v, h) => P(0, v, h), WR: Map2 = (u, h) => P(u, V, h);
  wall(c, WL, 0, V, '#433878');
  wall(c, WR, 0, U, '#4E4288');
  // wall caps + cut ends (the room is sliced open)
  px.poly([P(0, 0, WH), P(0, V, WH), P(-5, V + 5, WH), P(-5, 0, WH)], '#5D52A0');
  px.poly([P(0, V, WH), P(U, V, WH), P(U, V + 5, WH), P(-5, V + 5, WH)], '#5D52A0');
  px.poly([P(-5, 0, 0), P(0, 0, 0), P(0, 0, WH), P(-5, 0, WH)], '#2A2350');
  px.poly([P(U, V, 0), P(U, V + 5, 0), P(U, V + 5, WH), P(U, V, WH)], '#231D45');
  px.line(P(-5, 0, WH), P(0, 0, WH), '#7A6EC0'); px.line(P(U, V, WH), P(U, V + 5, WH), '#7A6EC0');
  // neon tube along the top of both walls
  for (const [a, b] of [[P(0, 0, 52), P(0, V, 52)], [P(0, V, 52), P(U, V, 52)]] as [Pt, Pt][]) {
    const on = c.power > 0.3;
    c.px.line(a, b, on ? '#FF3EA5' : '#5A2A50', 1, on ? 1 : 0);
    c.px.line([a[0], a[1] + 1], [b[0], b[1] + 1], on ? '#FFB0DA' : '#4A2444', 1, on ? 1 : 0);
  }

  // windows
  windowOn(c, WL, 94, 132, 16, 46, 11);
  windowOn(c, WR, 10, 62, 16, 46, 23);
  windowOn(c, WR, 186, 236, 16, 48, 37);
  // synthwave poster on the right wall
  poster(c, WR, 72, 90, 18, 44);
  // small framed photo on the left wall
  frame(c, WL, 76, 88, 26, 38, '#2EB8C8');
  // elevator surround (doors are drawn live so they can open)
  px.poly([WL(16, 0), WL(54, 0), WL(54, 46), WL(16, 46)], '#262046');
  px.poly([WL(18, 0), WL(52, 0), WL(52, 42), WL(18, 42)], '#14102A');
  px.line(WL(16, 46), WL(54, 46), '#7A6EC0');
  px.poly([WL(56, 16), WL(60, 16), WL(60, 26), WL(56, 26)], '#3A3460');
  // board bezel
  px.poly([WR(92, 8), WR(180, 8), WR(180, 42), WR(92, 42)], '#1A1434');
  px.poly([WR(94, 10), WR(178, 10), WR(178, 40), WR(94, 40)], '#0C0820', 0.5);
  px.line(WR(92, 42), WR(180, 42), '#6D62B0');
}
function rug(c: IC, u: number, v: number, du: number, dv: number, base: string, border: string, accent: string) {
  const { P, px } = c;
  const q = (a: number, b: number, w: number, h: number, col: string) => px.poly([P(u + a, v + b), P(u + a + w, v + b), P(u + a + w, v + b + h), P(u + a, v + b + h)], col);
  q(0, 0, du, dv, border); q(2, 2, du - 4, dv - 4, base); q(4, 4, du - 8, dv - 8, shade(base, 0.08));
  for (let a = 8; a < du - 6; a += 8) q(a, 4, 1, dv - 8, shade(base, -0.12));
  for (let k = 0; k < Math.floor(du / 10); k++) { const a = 6 + k * 10; q(a, dv / 2 - 1, 2, 2, accent); }
  for (let a = 1; a < du; a += 3) { px.dot(...P(u + a, v - 0.6).map(Math.floor) as Pt, shade(border, 0.2)); }
}
function wall(c: IC, M: Map2, a0: number, a1: number, col: string) {
  const { px } = c;
  px.poly([M(a0, 0), M(a1, 0), M(a1, WH), M(a0, WH)], col);
  // upper wall: soft vertical gradient toward the ceiling (dithered)
  px.dither([M(a0, 40), M(a1, 40), M(a1, WH), M(a0, WH)], shade(col, -0.16), 0.5);
  px.poly([M(a0, 46), M(a1, 46), M(a1, WH), M(a0, WH)], shade(col, -0.16));
  // wainscot + rail + baseboard
  px.poly([M(a0, 0), M(a1, 0), M(a1, 16), M(a0, 16)], shade(col, -0.3));
  for (let a = a0 + 10; a < a1; a += 20) { px.line(M(a, 3), M(a, 14), shade(col, -0.42)); px.line(M(a + 1, 3), M(a + 1, 14), shade(col, -0.18)); }
  px.line(M(a0, 16), M(a1, 16), shade(col, 0.3)); px.line(M(a0, 17), M(a1, 17), shade(col, 0.1));
  px.poly([M(a0, 0), M(a1, 0), M(a1, 3), M(a0, 3)], '#1A1532');
  px.line(M(a0, 3), M(a1, 3), '#3A3264');
  // panel seams
  for (let a = a0 + 20; a < a1; a += 20) { px.line(M(a, 18), M(a, 50), shade(col, -0.14)); px.line(M(a + 1, 18), M(a + 1, 50), shade(col, 0.07)); }
}
/** Night-city window: dithered sky, stars, skyline with lit windows, mullions, glare. */
function windowOn(c: IC, M: Map2, a0: number, a1: number, h0: number, h1: number, seed: number) {
  const { px } = c;
  px.poly([M(a0 - 2, h0 - 3), M(a1 + 2, h0 - 3), M(a1 + 2, h1 + 2), M(a0 - 2, h1 + 2)], '#8C84C0');
  px.poly([M(a0 - 1, h0 - 2), M(a1 + 1, h0 - 2), M(a1 + 1, h1 + 1), M(a0 - 1, h1 + 1)], '#5A5090');
  const bands = ['#170F44', '#24115A', '#3B1468', '#5E1C74', '#8E2A7C', '#C3407F'];
  const H = h1 - h0;
  for (let i = 0; i < bands.length; i++) {
    const t0 = h1 - (i / bands.length) * H, t1 = h1 - ((i + 1) / bands.length) * H;
    px.poly([M(a0, t1), M(a1, t1), M(a1, t0), M(a0, t0)], bands[i], 0.9);
    if (i + 1 < bands.length) px.dither([M(a0, t1), M(a1, t1), M(a1, t1 + 2), M(a0, t1 + 2)], bands[i + 1], 0.5, 0.9);
  }
  for (let k = 0; k < (a1 - a0) / 5; k++) { const p = M(a0 + hash(seed, k) * (a1 - a0), h1 - 1 - hash(k, seed) * H * 0.4); px.dot(Math.floor(p[0]), Math.floor(p[1]), hash(k, 3) > 0.7 ? '#9FE8FF' : '#F4EEFF', 1); }
  // skyline
  let a = a0;
  while (a < a1) {
    const w = 3 + Math.floor(hash(seed, a) * 7), bh = 3 + hash(a, seed) * H * 0.55, e = Math.min(a1, a + w);
    const col = hash(a, 7) > 0.5 ? '#120A2A' : '#1A0F36';
    px.poly([M(a, h0), M(e, h0), M(e, h0 + bh), M(a, h0 + bh)], col);
    for (let wy = h0 + 2; wy < h0 + bh - 1; wy += 2) for (let wx = a + 1; wx < e - 1; wx += 2) if (hash(wx * 3 + seed, wy) > 0.62) { const p = M(wx, wy); px.dot(Math.floor(p[0]), Math.floor(p[1]), hash(wx, wy) > 0.45 ? '#FFC77A' : '#7FE9F5', 0.9); }
    if (hash(a, 11) > 0.75) { const p = M(a + w / 2, h0 + bh + 2); px.dot(Math.floor(p[0]), Math.floor(p[1]), '#FF5C7A', 1); }
    a = e + (hash(a, 5) > 0.7 ? 1 : 0);
  }
  // mullions + transom + glare
  const n = Math.max(1, Math.round((a1 - a0) / 16));
  for (let i = 1; i < n; i++) { const x = a0 + ((a1 - a0) * i) / n; px.line(M(x, h0), M(x, h1), '#8C84C0'); px.line(M(x + 1, h0), M(x + 1, h1), '#4A4280'); }
  const tr = h0 + (h1 - h0) * 0.68; px.line(M(a0, tr), M(a1, tr), '#8C84C0');
  const g = (a1 - a0) * 0.18;
  px.push(0.16); px.poly([M(a0 + g, h1), M(a0 + g + 6, h1), M(a0 + g - 4, h0), M(a0 + g - 10, h0)], '#FFFFFF', -1); px.pop();
  // sill
  px.poly([M(a0 - 3, h0 - 4), M(a1 + 3, h0 - 4), M(a1 + 3, h0 - 2), M(a0 - 3, h0 - 2)], '#B8AFE0');
}
function poster(c: IC, M: Map2, a0: number, a1: number, h0: number, h1: number) {
  const { px } = c;
  px.poly([M(a0 - 1, h0 - 1), M(a1 + 1, h0 - 1), M(a1 + 1, h1 + 1), M(a0 - 1, h1 + 1)], '#1A1430');
  const H = h1 - h0;
  const sky = ['#2A1060', '#5A1C7C', '#B23A86', '#FF7A6B'];
  sky.forEach((col, i) => px.poly([M(a0, h1 - (H * i) / 4), M(a1, h1 - (H * i) / 4), M(a1, h1 - (H * (i + 1)) / 4), M(a0, h1 - (H * (i + 1)) / 4)], col, 0.4));
  // sun
  const cx = (a0 + a1) / 2, cy = h0 + H * 0.45;
  for (let r = 0; r < 6; r++) { const w = Math.sqrt(36 - (r - 0.5) * (r - 0.5)); if (r % 2 === 0 || r < 3) px.poly([M(cx - w, cy + r), M(cx + w, cy + r), M(cx + w, cy + r + 1), M(cx - w, cy + r + 1)], r < 3 ? '#FFD36B' : '#FF9A55', 0.6); }
  px.poly([M(a0, h0), M(a1, h0), M(a1, h0 + H * 0.3), M(a0, h0 + H * 0.3)], '#140A2A');
  px.line(M(a0, h0 + H * 0.3), M(a1, h0 + H * 0.3), '#FF3EA5', 1, 0.8);
  px.line(M(a0 + 3, h0 + 2), M(a0 + 4, h0 + 14), '#140A2A', 1); px.line(M(a0 + 4, h0 + 14), M(a0 + 9, h0 + 12), '#140A2A');
  px.line(M(a0 + 4, h0 + 14), M(a0 + 1, h0 + 11), '#140A2A');
}
function frame(c: IC, M: Map2, a0: number, a1: number, h0: number, h1: number, col: string) {
  c.px.poly([M(a0, h0), M(a1, h0), M(a1, h1), M(a0, h1)], '#C9B37A');
  c.px.poly([M(a0 + 1, h0 + 1), M(a1 - 1, h0 + 1), M(a1 - 1, h1 - 1), M(a0 + 1, h1 - 1)], shade(col, -0.4));
  c.px.poly([M(a0 + 2, h0 + 2), M(a1 - 2, h0 + 2), M(a1 - 2, h0 + 6), M(a0 + 2, h0 + 6)], shade(col, -0.1));
  c.px.ellipse(...M((a0 + a1) / 2, h1 - 4), 2, 2, '#FFD36B');
}

/* ------------------------------------------------------------------ live wall content */
export function wallLive(c: IC, d: Dept, quests: QuestStatus[], floorNo: number, elevOpen: number, lit: boolean) {
  const { P, px, L, t } = c;
  const WL: Map2 = (v, h) => P(0, v, h), WR: Map2 = (u, h) => P(u, V, h);
  // elevator doors slide open when someone arrives
  const gap = elevOpen * 15;
  for (const [a0, a1, hi] of [[18, 35 - gap, 22 - gap], [35 + gap, 52, 38 + gap]] as [number, number, number][]) {
    if (a1 - a0 < 0.5) continue;
    px.poly([WL(a0, 0), WL(a1, 0), WL(a1, 41), WL(a0, 41)], '#A39CCB');
    px.line(WL(hi, 1), WL(hi, 40), '#D8D2F4'); px.line(WL(a1 - 0.5, 0), WL(a1 - 0.5, 41), '#5A5488');
    px.line(WL(a0, 20), WL(a1, 20), '#8A82BA');
  }
  if (elevOpen > 0.05) { L.add(...P(4, 35, 18), 40 * elevOpen, '#FFE7B0', 0.8 * elevOpen, 0.8); }
  // floor indicator above the doors
  px.poly([WL(28, 44), WL(42, 44), WL(42, 51), WL(28, 51)], '#0E0A1E');
  const fn = String(floorNo);
  px.text(fn, (a, b) => WL(31 + a, 50 - b), 1, C.amber, 1);
  const arr = Math.floor(t * 2) % 2;
  px.poly([WL(38, 46 + arr), WL(40, 49 + arr), WL(36, 49 + arr)], C.amber, 1);
  px.dot(...(WL(58, 20).map(Math.floor) as Pt), lit ? C.cyan : '#3A3460', lit ? 1 : 0, 1);
  L.add(...WL(35, 47), 18, C.amber, 0.4, 1);

  // Kanban wall screen: live counts from Hermes Kanban
  const cols: [string, string, number][] = [
    ['QUED', C.lav, quests.filter((q) => q === 'queued').length], ['RUN', C.cyan, quests.filter((q) => q === 'planning' || q === 'running' || q === 'cancelling').length],
    ['ATTN', C.orange, quests.filter((q) => q === 'awaiting_input' || q === 'in_review' || q === 'failed').length], ['DONE', C.mint, quests.filter((q) => q === 'completed' || q === 'cancelled').length],
  ];
  const on = lit ? 1 : 0.15;
  cols.forEach(([label, col, n], i) => {
    const a = 97 + i * 20.5;
    px.text(label, (x, y) => WR(a + x, 38 - y), 1, col, on);
    px.line(WR(a, 32), WR(a + 17, 32), col, 1, on);
    for (let k = 0; k < Math.min(5, n); k++) {
      const h = 29 - k * 4, pulse = i === 1 && Math.sin(t * 3 + k) > 0.6;
      px.poly([WR(a, h), WR(a + 17, h), WR(a + 17, h - 3), WR(a, h - 3)], pulse ? shade(col, 0.4) : shade(col, -0.35), on * 0.8);
      px.line(WR(a + 1, h - 1), WR(a + 9 + (hash(i, k) * 6), h - 1), shade(col, 0.2), 1, on);
    }
    if (n > 5) px.text('+' + (n - 5), (x, y) => WR(a + x, 9 - y), 1, col, on);
  });
  if (lit) L.add(...P(136, V - 6, 24), 80, C.cyan, 0.38, 0.75);

  // neon department sign above the board
  const name = d.name.toUpperCase().replace(/[^A-Z0-9 &]/g, '');
  const s = textWidth(name, 2) <= 86 ? 2 : 1, w = textWidth(name, s);
  const flick = d.state === 'attention' ? (Math.sin(t * 13) > 0.2 || Math.sin(t * 3.1) > 0 ? 1 : 0.25) : 1;
  const signOn = lit && d.state !== 'unconfigured' ? flick : 0;
  const acc = d.theme.accent;
  const a0 = 136 - w / 2;
  px.text(name, (x, y) => WR(a0 + x + 1, 54 - y - 1), s, '#1A0F30', -1); // drop shadow on the wall
  px.text(name, (x, y) => WR(a0 + x, 54 - y), s, signOn ? acc : shade(acc, -0.6), signOn);
  if (signOn) L.add(...WR(136, 48), 70, acc, 0.42 * signOn, 0.8);
  // twinkling city through the windows
  for (const [M2, a, b] of [[WR, 186, 236], [WR, 10, 62], [WL, 94, 132]] as [Map2, number, number][]) {
    const k = Math.floor(t * 1.3);
    for (let i = 0; i < 3; i++) { const p = M2(a + hash(k + i, a) * (b - a), 17 + hash(i, k) * 12); px.dot(Math.floor(p[0]), Math.floor(p[1]), hash(i, k + 1) > 0.5 ? '#FFC77A' : '#7FE9F5', 1); }
  }
}

/* ------------------------------------------------------------------ furniture */
export function deskStatic(c: IC, i: number, accent: string) {
  const { P, px } = c;
  const [u, v] = DESKS[i % DESKS.length];
  box(c, u + 2, v + 13, 2, 24, 2, 10, '#3D3366', { edge: false });
  box(c, u + 1, v + 1, 0, 2, 2, 12, '#57507E', { edge: false }); box(c, u + 25, v + 1, 0, 2, 2, 12, '#57507E', { edge: false });
  box(c, u, v, 12, 28, 16, 2, '#7A5442', { top: '#9C6E56' });
  px.line(P(u + 2, v + 4, 14), P(u + 26, v + 4, 14), '#A87A60');
  box(c, u + 2, v + 2, 14, 6, 5, 1, '#D9D3F0', { top: '#EEE9FF', edge: false });
  px.line(P(u + 3, v + 4, 15), P(u + 7, v + 4, 15), '#9A92C0');
  box(c, u + 3, v + 10, 14, 3, 3, 4, '#EDE8FF', { top: '#5A3020', edge: false });
  px.line(P(u + 3, v + 10, 16), P(u + 6, v + 10, 16), accent, 1);
  box(c, u + 9, v + 4, 14, 10, 4, 1, '#2E2848', { top: '#4A4370', edge: false });
  for (let k = 0; k < 4; k++) px.line(P(u + 10, v + 5 + k * 0.8, 15), P(u + 18, v + 5 + k * 0.8, 15), k % 2 ? '#5D5590' : '#3A335C');
  box(c, u + 21, v + 5, 14, 2, 3, 1, '#4A4370', { edge: false });
  box(c, u + 13, v + 12, 14, 2, 2, 4, '#2A2440', { edge: false });
  box(c, u + 11, v + 11, 14, 6, 4, 1, '#2A2440', { edge: false });
  box(c, u + 5, v + 12, 17, 18, 2, 12, '#1C1730', { top: '#2E2850', edge: false });
  if (i % 2 === 0) {
    box(c, u + 23, v + 11, 14, 3, 3, 1, '#2A2440', { edge: false });
    px.line(P(u + 24.5, v + 12.5, 15), P(u + 24.5, v + 12.5, 23), '#4A4370');
    box(c, u + 21, v + 10, 23, 6, 5, 3, shade(accent, -0.25), { top: shade(accent, 0.1), edge: false });
  } else {
    box(c, u + 23, v + 3, 14, 3, 3, 3, '#B8613E', { top: '#4A2A1A', edge: false });
    const p = P(u + 24.5, v + 4.5, 19);
    px.ellipse(p[0], p[1], 2.5, 2, '#2E7A4E'); px.ellipse(p[0] - 0.5, p[1] - 1, 1.5, 1, '#6FD08A');
  }
}
/** What a working agent's monitor shows: the tools of its trade (see data/floor.ts STATIONS). */
export type ScreenKind = 'code' | 'candles' | 'odds' | 'recon';
export const screenKindFor = (templateId: string | undefined): ScreenKind =>
  templateId === 'trading-desk' || templateId === 'treasury-ops' ? 'candles' : templateId === 'prediction-desk' ? 'odds' : templateId === 'red-team' ? 'recon' : 'code';

export function deskLive(c: IC, i: number, st: AgentStatus | undefined, lit: boolean, kind: ScreenKind = 'code') {
  const { P, px, L, t } = c;
  const [u, v] = DESKS[i % DESKS.length];
  screen(c, u + 6, v + 12, 18, 16, 10, st, lit, kind);
  if (i % 2 === 0 && lit) { px.poly([P(u + 22, v + 11, 23), P(u + 26, v + 11, 23), P(u + 26, v + 14, 23), P(u + 22, v + 14, 23)], '#FFF1C8', 1); L.add(...P(u + 24, v + 10, 14), 34, '#FFB46B', 0.62); }
  if (st === 'running') for (let k = 0; k < 2; k++) { const f = (t * 0.7 + k * 0.5) % 1, p = P(u + 4.5, v + 11.5, 19 + f * 8); px.push(0.4 * (1 - f)); px.dot(Math.floor(p[0] + Math.sin(t * 3 + k) * 1.2), Math.floor(p[1]), '#FFFFFF', 0.3); px.pop(); }
  if (lit && st && st !== 'disconnected') {
    const col = STATUS_COL[st], k = st === 'running' ? 0.95 : st === 'failed' ? 0.7 + 0.3 * Math.sin(t * 8) : st === 'completed' ? 0.75 : 0.32;
    L.add(...P(u + 14, v + 6, 20), 34, col, 0.85 * k, 0.8);
    L.add(...P(u + 14, v - 2, 0), 46, col, 0.28 * k);
  }
}
/** Monitor face on the v-plane: status-driven content, emissive. */
export function screen(c: IC, u: number, v: number, h: number, w: number, hh: number, st: AgentStatus | undefined, lit: boolean, kind: ScreenKind = 'code') {
  const { P, px, t } = c;
  const S = (a: number, b: number): Pt => P(u + a, v, h + hh - b);
  const quad = (a: number, b: number, ww: number, h2: number, col: string, em = 1) => px.poly([S(a, b), S(a + ww, b), S(a + ww, b + h2), S(a, b + h2)], col, em);
  if (!lit || !st || st === 'disconnected') {
    quad(0, 0, w, hh, '#0B0816', 0);
    px.line(S(3, 1), S(9, hh - 1), '#2A2448', 1, 0);
    if (st === 'disconnected') px.text('OFF', (a, b) => S(4 + a, 3 + b), 1, '#4A4468', 0);
    return;
  }
  if (st === 'running' && kind === 'candles') {
    quad(0, 0, w, hh, '#07121A', 0.9);
    for (let i = 0; i < 5; i++) {
      const k = Math.floor(t * 1.2) + i, up = hash(k, 3) > 0.42, body = 1 + hash(k, 5) * 2, mid = 5 + Math.sin(k * 0.8) * 1.5;
      quad(1.5 + i * 3, mid - body, 1.6, body * 2, up ? C.mint : C.red);
    }
  } else if (st === 'running' && kind === 'odds') {
    quad(0, 0, w, hh, '#120A20', 0.9);
    for (let r = 0; r < 3; r++) { const p = 0.3 + 0.5 * (0.5 + 0.5 * Math.sin(t * 0.5 + r * 2)); quad(1, 1.5 + r * 2.8, (w - 2) * p, 1.6, r === 1 ? C.violet : C.cyan); }
  } else if (st === 'running' && kind === 'recon') {
    quad(0, 0, w, hh, '#0C140F', 0.9);
    for (let a = 2; a < w; a += 4) quad(a, 0.5, 0.5, hh - 1, '#1E3A28', 0.6);
    for (let i = 0; i < 2; i++) { const on = Math.sin(t * 4 + i * 2) > 0; quad(3 + hash(i, Math.floor(t * 0.3)) * (w - 6), 2 + hash(i + 3, Math.floor(t * 0.3)) * (hh - 5), 1.5, 1.5, on ? C.red : '#5A1A26'); }
  } else if (st === 'running') {
    quad(0, 0, w, hh, '#06202C', 0.9);
    const k = Math.floor(t * 4);
    for (let r = 0; r < 4; r++) {
      const len = 3 + Math.floor(hash(r + k, 3) * (w - 6)), ind = r % 3 === 1 ? 2 : 0;
      quad(1 + ind, 1 + r * 2.2, len - ind, 1, r === 0 ? C.pink : hash(r, k) > 0.5 ? C.cyan : C.mint);
    }
    if (Math.floor(t * 3) % 2) quad(1, 9, 2, 1, '#FFFFFF');
  } else if (st === 'failed') {
    const on = Math.sin(t * 8) > -0.3;
    quad(0, 0, w, hh, on ? '#3A0716' : '#1A040C', 0.9);
    if (on) { px.text('ERR', (a, b) => S(3 + a, 2 + b), 1, C.red, 1); quad(2, 8, w - 4, 1, C.red); }
  } else if (st === 'completed') {
    quad(0, 0, w, hh, '#06281C', 0.9);
    px.line(S(5, 5), S(7, 7), C.mint, 1, 1); px.line(S(7, 7), S(11, 2), C.mint, 1, 1);
  } else if (st === 'awaiting') {
    quad(0, 0, w, hh, '#2A1A06', 0.8); px.text('?', (a, b) => S(6 + a, 2 + b), 1, C.amber, 1);
  } else {
    // idle screensaver: a slow bouncing diamond
    quad(0, 0, w, hh, '#120E2E', 0.55);
    const x = 2 + Math.abs(((t * 3) % ((w - 5) * 2)) - (w - 5)), y = 2 + Math.abs(((t * 2) % ((hh - 5) * 2)) - (hh - 5));
    quad(x, y, 2, 2, C.lav, 0.8);
  }
}
export function chairItem(c: IC, su: number, sv: number, col: string, part: 'seat' | 'back', tall = false) {
  const { P, px } = c;
  if (part === 'seat') {
    for (let k = 0; k < 5; k++) { const a = (k / 5) * Math.PI * 2 + 0.3, e = P(su + Math.cos(a) * 5, sv + Math.sin(a) * 5, 0); px.line(P(su, sv, 1), e, '#1E1A30'); px.dot(Math.floor(e[0]) - 1, Math.floor(e[1]), '#0E0B18', 0, 2); }
    px.line(P(su, sv, 1), P(su, sv, 7), '#3A3458');
    box(c, su - 5, sv - 4, 7, 10, 9, 2, col);
  } else {
    const bh = tall ? 13 : 8;
    px.line(P(su, sv - 5, 7), P(su, sv - 5, 10), '#3A3458');
    box(c, su - 5, sv - 6, 10, 10, 2, bh, col, { top: shade(col, 0.2) });
    px.line(P(su - 3, sv - 6, 10 + bh - 3), P(su + 3, sv - 6, 10 + bh - 3), shade(col, 0.18));
  }
}
export function plant(c: IC, u: number, v: number, big: boolean, seed: number) {
  const { P, px } = c;
  const ph = big ? 9 : 6, pw = big ? 9 : 7;
  box(c, u - pw / 2, v - pw / 2, 0, pw, pw, ph, '#B8613E', { top: '#3A2418' });
  px.line(P(u - pw / 2, v - pw / 2, ph - 2), P(u + pw / 2, v - pw / 2, ph - 2), '#D27A50');
  const n = big ? 11 : 6, top = big ? 30 : 16;
  const leaves: [number, number, number, number][] = [];
  for (let k = 0; k < n; k++) {
    const a = hash(seed, k) * Math.PI * 2, r = (big ? 8 : 4) * Math.sqrt(hash(k, seed)), hh = ph + 3 + hash(seed + k, 2) * (top - ph - 3);
    leaves.push([u + Math.cos(a) * r, v + Math.sin(a) * r, hh, big ? 4 + hash(k, 9) * 2 : 3]);
  }
  leaves.sort((p, q) => p[2] - q[2]);
  if (big) for (const [lu, lv, lh] of leaves) px.line(P(u, v, ph), P(lu, lv, lh - 2), '#2A5A3A');
  for (const [lu, lv, lh, r] of leaves) {
    const p = P(lu, lv, lh);
    px.ellipse(p[0], p[1], r, r * 0.62, '#2A6E46');
    px.ellipse(p[0] - 0.6, p[1] - 0.8, r * 0.72, r * 0.42, '#3FA066');
    px.ellipse(p[0] - 1.2, p[1] - 1.3, r * 0.34, r * 0.22, '#7FDA92');
  }
}
export function rackStatic(c: IC) {
  const { P, px } = c;
  box(c, 0, 56, 0, 14, 18, 44, '#2A2348', { top: '#3E3570' });
  for (let h = 4; h < 42; h += 6) { px.line(P(14, 57, h), P(14, 73, h), '#1A1530'); }
  for (let r = 0; r < 6; r++) px.line(P(14, 66, 6 + r * 6), P(14, 72, 6 + r * 6), '#4A4278');
  px.poly([P(0, 56, 2), P(14, 56, 2), P(14, 56, 40), P(0, 56, 40)], '#221C3E');
  for (let h = 6; h < 40; h += 3) px.line(P(2, 56, h), P(12, 56, h), '#2E2752');
}
export function rackLive(c: IC, lit: boolean) {
  const { P, px, L, t } = c;
  for (let r = 0; r < 6; r++) for (let k = 0; k < 4; k++) {
    const on = lit && hash(r * 7 + k, Math.floor(t * (2 + k))) > 0.35;
    const p = P(14, 59 + k * 3.4, 7 + r * 6);
    px.dot(Math.floor(p[0]), Math.floor(p[1]), on ? (k === 3 ? C.amber : C.mint) : '#1E3A2E', on ? 1 : 0);
  }
  if (lit) L.add(...P(18, 65, 20), 34, C.mint, 0.32, 0.9);
}
export function coolerItem(c: IC) {
  box(c, COOLER[0] - 2, COOLER[1] + 8, 0, 8, 8, 14, '#C9C3EA', { top: '#E4DFF8' });
  box(c, COOLER[0] - 1, COOLER[1] + 9, 14, 6, 6, 8, '#5AB8F0', { top: '#9FE0FF', em: 0.25 });
  c.px.dot(...(c.P(COOLER[0] + 6, COOLER[1] + 10, 9).map(Math.floor) as Pt), C.red, 1);
}
export function counterStatic(c: IC) {
  const { P, px } = c;
  box(c, 190, 126, 0, 48, 14, 13, '#3A2F5E', { top: '#544686' });
  box(c, 189, 125, 13, 50, 15, 2, '#B8AED8', { top: '#D6CEF0' });
  for (let u = 196; u < 236; u += 12) { px.line(P(u, 126, 2), P(u, 126, 11), '#2A2248'); px.dot(...(P(u + 5, 126, 8).map(Math.floor) as Pt), '#8C84C0'); }
  box(c, 196, 130, 15, 12, 8, 11, '#C0B8E0', { top: '#E4DEF8' });
  box(c, 198, 129.5, 18, 8, 1, 5, '#2A2440', { edge: false });
  box(c, 201, 128, 15, 3, 3, 3, '#EDE8FF', { top: '#5A3020', edge: false });
  box(c, 220, 130, 15, 12, 9, 7, '#2E2848', { top: '#4A4370' });
  px.poly([P(221, 130, 16), P(228, 130, 16), P(228, 130, 21), P(221, 130, 21)], '#120E24');
  const fb = P(234, 133, 15); px.ellipse(fb[0], fb[1] - 1, 4, 2, '#E4DEF8'); px.ellipse(fb[0] - 1, fb[1] - 3, 1.5, 1.5, C.orange); px.ellipse(fb[0] + 1.5, fb[1] - 3, 1.5, 1.5, '#FFD36B');
}
export function counterLive(c: IC, lit: boolean) {
  const { P, px, L, t } = c;
  px.dot(...(P(206, 130, 23).map(Math.floor) as Pt), lit ? C.mint : '#2A4A3A', lit ? 1 : 0);
  px.dot(...(P(209, 130, 23).map(Math.floor) as Pt), lit ? C.amber : '#4A3A2A', lit ? 1 : 0);
  for (let i = 0; i < 3; i++) { const p = P(202.5, 129.5, 19 + ((t * 6 + i * 4) % 12)); px.push(0.35 * (1 - ((t * 6 + i * 4) % 12) / 12)); px.dot(Math.floor(p[0] + Math.sin(t * 2 + i) * 1.5), Math.floor(p[1]), '#FFFFFF', 0.3); px.pop(); }
  px.text('12', (a, b) => P(229 + a * 0.9, 130, 21 - b * 0.9), 0.9, lit ? C.mint : '#2A4A3A', lit ? 1 : 0);
  if (lit) L.add(...P(206, 124, 22), 30, '#FFB46B', 0.4);
}
export const LOUNGE_PROPS: { key: string; y: [number, number]; draw: (c: IC) => void }[] = [
  { key: 'table', y: [204, 28], draw: (c) => {
    const { P, px } = c;
    box(c, 205, 13, 0, 2, 2, 5, '#3A3458', { edge: false }); box(c, 215, 13, 0, 2, 2, 5, '#3A3458', { edge: false });
    box(c, 204, 12, 5, 14, 16, 1, '#7FE9F5', { top: '#B8F6FB', em: 0.12 });
    box(c, 207, 18, 6, 7, 5, 1, '#3A3458', { top: '#5A5488', edge: false });
    px.poly([P(207, 23, 7), P(214, 23, 7), P(214, 23, 12), P(207, 23, 12)], '#1E1A38');
    box(c, 210, 14, 6, 5, 4, 1, C.pink, { edge: false });
  } },
  { key: 'sofa', y: [224, 40], draw: (c) => {
    const sc = '#7A2E6A';
    box(c, 224, 6, 0, 12, 34, 6, sc, { top: shade(sc, 0.12) });
    for (let k = 0; k < 3; k++) box(c, 224, 8 + k * 10.3, 6, 10, 10, 2, shade(sc, 0.06), { top: shade(sc, 0.22) });
    box(c, 233, 6, 6, 4, 34, 10, shade(sc, -0.1), { top: shade(sc, 0.1) });
    box(c, 224, 4, 0, 13, 3, 10, shade(sc, -0.05)); box(c, 224, 39, 0, 13, 3, 10, shade(sc, -0.05));
    box(c, 226, 30, 8, 6, 5, 4, C.gold, { edge: false });
  } },
  { key: 'lamp', y: [233, 47], draw: (c) => {
    const { P, px } = c;
    box(c, 234, 42, 0, 4, 4, 1, '#2A2440', { edge: false });
    px.line(P(236, 44, 1), P(236, 44, 29), '#4A4370');
    box(c, 233, 41, 29, 6, 6, 5, '#C9A070', { top: '#E8C890', em: 0.35 });
  } },
];
export function loungeLive(c: IC, lit: boolean, which: string) {
  const { P, px, L } = c;
  if (which === 'table') px.poly([P(208, 23, 8), P(213, 23, 8), P(213, 23, 11), P(208, 23, 11)], lit ? '#6E4FB8' : '#120E24', lit ? 0.8 : 0);
  if (which === 'lamp' && lit) { px.poly([P(234, 42, 29), P(238, 42, 29), P(238, 46, 29), P(234, 46, 29)], '#FFE6B8', 0.8); L.add(...P(236, 44, 22), 64, '#FFB46B', 0.55, 0.75); }
}
export function chiefDeskStatic(c: IC) {
  const { P, px } = c;
  box(c, 14, 118, 0, 36, 14, 12, '#4A2C20', { top: '#6B4230' });
  box(c, 13, 117, 12, 38, 16, 2, '#6B4230', { top: '#8A5A40' });
  px.line(P(13, 117, 13), P(51, 117, 13), C.gold, 1, 0.5);
  for (let k = 0; k < 3; k++) px.line(P(18 + k * 10, 118, 3), P(18 + k * 10, 118, 10), '#3A2018');
  box(c, 30, 127, 14, 3, 2, 4, '#2A2440', { edge: false });
  box(c, 21, 128, 17, 22, 2, 12, '#2A2018', { top: '#4A3A20', edge: false });
  box(c, 16, 120, 14, 6, 5, 1, '#EDE8FF', { edge: false });
  box(c, 44, 126, 14, 3, 3, 1, '#6B5530', { edge: false });
  px.line(P(45.5, 127.5, 15), P(45.5, 127.5, 24), C.gold);
  box(c, 42, 124, 24, 7, 6, 3, '#B8862E', { top: C.gold });
}
export function chiefDeskLive(c: IC, st: AgentStatus | undefined, lit: boolean) {
  const { P, px, L, t } = c;
  const S = (a: number, b: number): Pt => P(22 + a, 128, 28 - b);
  const on = lit && st && st !== 'disconnected' && st !== 'awaiting';
  px.poly([S(0, 0), S(20, 0), S(20, 10), S(0, 10)], on ? '#241A06' : '#0B0816', on ? 0.9 : 0);
  if (on) {
    for (let k = 0; k < 6; k++) { const hgt = 2 + Math.floor((st === 'running' ? (0.5 + 0.5 * Math.sin(t * 2 + k)) : hash(k, 4)) * 6); px.poly([S(2 + k * 3, 9 - hgt), S(4 + k * 3, 9 - hgt), S(4 + k * 3, 9), S(2 + k * 3, 9)], k === 5 ? C.pink : C.gold, 1); }
    L.add(...P(32, 122, 20), 36, C.gold, 0.7, 0.8);
  }
  if (lit) { px.poly([P(43, 125, 24), P(48, 125, 24), P(48, 129, 24), P(43, 129, 24)], '#FFF1C8', 1); L.add(...P(45, 124, 14), 40, '#FFC75A', 0.75); }
}
export function shelfItem(c: IC) {
  const { P, px } = c;
  box(c, 0, 118, 0, 8, 20, 40, '#4A3020', { top: '#6B4630' });
  const BOOK = ['#FF7A6B', '#2EB8F0', '#FFC75A', '#9B5CFF', '#7CF5B4', '#F4EEFF', '#FF3EA5'];
  for (let r = 0; r < 4; r++) {
    const h = 2 + r * 10;
    px.poly([P(8, 119, h + 8), P(8, 137, h + 8), P(8, 137, h + 9), P(8, 119, h + 9)], '#2A1A12');
    let v = 119.5;
    while (v < 136) { const w = 1.5 + hash(r, Math.floor(v)) * 1.5, bh = 5 + hash(Math.floor(v), r) * 3; px.poly([P(8, v, h), P(8, v + w, h), P(8, v + w, h + bh), P(8, v, h + bh)], BOOK[Math.floor(hash(v * 3, r) * BOOK.length)]); v += w + 0.4; }
  }
  const p = P(4, 128, 41); px.rect(Math.floor(p[0]) - 1, Math.floor(p[1]) - 5, 3, 4, C.gold, 0.4); px.rect(Math.floor(p[0]) - 2, Math.floor(p[1]) - 1, 5, 1, '#B8862E');
}
/** Glass walls of the chief's office (drawn in front of what's inside). */
export function glassWalls(c: IC, which: 'front' | 'side') {
  const { P, px } = c;
  const pane = (a: Pt, b: Pt, posts: number[], along: (k: number, h: number) => Pt, label?: boolean) => {
    px.push(0.16); px.poly([along(a[0], 2), along(a[1], 2), along(a[1], 40), along(a[0], 40)], '#7FE9F5', 0.05); px.pop();
    px.push(0.28); for (const k of posts.slice(0, -1)) { px.line(along(k + 3, 36), along(k + 8, 6), '#FFFFFF', 1, -1); } px.pop();
    px.line(along(a[0], 40), along(a[1], 40), '#B8B0E0'); px.line(along(a[0], 41), along(a[1], 41), '#6D62B0');
    px.line(along(a[0], 1), along(a[1], 1), '#6D62B0');
    for (const k of posts) { px.line(along(k, 0), along(k, 41), '#B8B0E0'); }
    if (label) px.text('LEAD', (x, y) => along(14 + x, 33 - y), 1, C.gold, 0.9);
    void b;
  };
  if (which === 'front') pane([0, 50], [0, 0], [0, 16.6, 33.3, 50], (k, h) => P(k, 88, h), true);
  else pane([106, 140], [0, 0], [106, 123, 140], (k, h) => P(70, k, h));
}

/* ------------------------------------------------------------------ lights + shafts */
export function roomLights(c: IC, lit: boolean) {
  const { P, L } = c;
  // moonlight + neon city spill through the windows, as soft shafts with a floor patch
  const shaft = (a0: number, a1: number, h0: number, h1: number, right: boolean, panes: number) => {
    const w = (a1 - a0) / panes;
    for (let i = 0; i < panes; i++) {
      const s = a0 + i * w + 1, e = a0 + (i + 1) * w - 1;
      const win = right ? [P(s, V, h1), P(e, V, h1), P(e, V, h0), P(s, V, h0)] : [P(0, s, h1), P(0, e, h1), P(0, e, h0), P(0, s, h0)];
      const off = (hh: number) => (right ? ([0.35 * hh, -1.05 * hh] as Pt) : ([1.05 * hh, -0.35 * hh] as Pt));
      const fp = (a: number, hh: number): Pt => { const o = off(hh); return right ? P(a + o[0], V + o[1], 0) : P(o[0], a + o[1], 0); };
      const floor = [fp(s, h1), fp(e, h1), fp(e, h0), fp(s, h0)];
      const mid = (q: Pt[]): Pt => [(q[0][0] + q[2][0]) / 2, (q[0][1] + q[2][1]) / 2];
      L.shaft(hull([...win, ...floor]), '#8E7CFF', 0.17, 0.04, mid(win), mid(floor));
      L.shaft(floor, '#A08CFF', 0.2, 0.08, floor[3], floor[0]);
    }
  };
  shaft(186, 236, 16, 48, true, 3);
  shaft(10, 62, 16, 46, true, 3);
  shaft(94, 132, 16, 46, false, 2);
  if (!lit) return;
  // warm downlight pools (implied ceiling fixtures)
  for (const [u, v] of [[114, 76], [170, 76], [150, 30], [36, 112], [214, 118]] as Pt[]) L.add(...P(u, v, 0), 70, '#FFE2C0', 0.2);
  // neon tube wash on the walls
  for (let v = 15; v < V; v += 40) L.add(...P(0, v, 50), 46, '#FF3EA5', 0.26, 0.9);
  for (let u = 20; u < U; u += 44) L.add(...P(u, V, 50), 46, '#FF3EA5', 0.24, 0.9);
}
export const mixC = mix;

/** Meeting nook in the front-left: table, stools, a rolling whiteboard with scribbles. */
export function meetingStatic(c: IC) {
  const { P, px } = c;
  for (const [u, v] of [[26, 22], [52, 22], [39, 8], [39, 36]] as Pt[]) {
    px.line(P(u, v, 0), P(u, v, 7), '#3A3458');
    box(c, u - 3, v - 3, 7, 6, 6, 2, '#3A2448', { top: '#5A3A6A' });
  }
  box(c, 37, 20, 0, 4, 4, 10, '#3A3458', { edge: false });
  box(c, 30, 13, 10, 18, 18, 2, '#C9C3EA', { top: '#E8E3FA' });
  box(c, 34, 16, 12, 6, 4, 1, '#2A2440', { top: '#4A4370', edge: false });
  box(c, 43, 24, 12, 3, 3, 3, '#EDE8FF', { top: '#5A3020', edge: false });
  box(c, 38, 26, 12, 5, 4, 1, '#FFC75A', { edge: false });
  // whiteboard on wheels, facing the room
  for (const v of [10, 34]) { px.line(P(66, v, 0), P(66, v, 14), '#4A4370'); px.dot(...(P(66, v, 0).map(Math.floor) as Pt), '#140F22', 0, 2); }
  box(c, 64, 8, 14, 2, 28, 20, '#8C84B8', { right: '#F4F0FF', top: '#B8B0E0' });
  const W = (v: number, h: number) => P(66, v, h);
  px.line(W(12, 30), W(22, 30), '#2EB8F0'); px.line(W(12, 27), W(26, 27), '#2EB8F0'); px.line(W(12, 24), W(19, 24), '#FF3EA5');
  px.line(W(25, 21), W(32, 31), '#2A2440'); px.line(W(28, 22), W(31, 22), '#2A2440');
  px.poly([W(12, 18), W(16, 18), W(16, 20), W(12, 20)], '#7CF5B4'); px.poly([W(18, 18), W(22, 18), W(22, 20), W(18, 20)], '#FFB547');
}
