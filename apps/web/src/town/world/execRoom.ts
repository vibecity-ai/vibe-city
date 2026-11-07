/* The Executive Office interior (feature spec 3.1): the penthouse opened up like a department floor. It is the
   company's control room, and every object is a control (see EXEC_OBJECTS and ui/ExecRoom.tsx for what each opens).
   Built from the same pieces as a department office (shell, desk, shelf, meeting nook) plus a few exec-only props;
   the wall map is drawn live from the real floors. */
import type { Dept } from '../data/types';
import type { Pt } from './pix';
import { box, chiefDeskStatic, shelfItem, meetingStatic, plant, chairItem, C, STATUS_COL, type IC } from './interior';
import { shade } from './sprites';

export type ExecObjectId = 'desk' | 'phone' | 'org' | 'safe' | 'table' | 'calendar' | 'trophy' | 'ar' | 'assistant';
/** Footprint boxes (u, v, h, du, dv, dh) for hit-testing and the hover outline, and where the label sits. */
export const EXEC_OBJECTS: { id: ExecObjectId; label: string; b: [number, number, number, number, number, number] }[] = [
  { id: 'phone', label: 'Phone', b: [15, 119, 13, 9, 7, 6] },
  { id: 'desk', label: 'Your desk', b: [13, 117, 0, 38, 16, 26] },
  { id: 'trophy', label: 'Trophy shelf', b: [0, 118, 0, 8, 20, 46] },
  { id: 'safe', label: 'Safe', b: [0, 70, 0, 16, 18, 20] },
  { id: 'calendar', label: 'Calendar', b: [-1, 76, 21, 2, 15, 19] },
  { id: 'ar', label: 'Hiring office', b: [-1, 56, 0, 2, 18, 42] },
  { id: 'org', label: 'Tower map', b: [92, 138, 6, 88, 2, 38] },
  { id: 'table', label: 'Meeting table', b: [24, 6, 0, 44, 32, 16] },
  { id: 'assistant', label: 'Chief of Staff', b: [104, 92, 0, 8, 8, 34] },
];
export const ASSISTANT_SPOT: Pt = [108, 96];

/** Exec-only static props, drawn on top of the shared shell (baked by the caller). */
export function execProps(c: IC) {
  const { P, px } = c;
  const WL = (v: number, h: number) => P(0, v, h), WR = (u: number, h: number) => P(u, 140, h);
  // elevator doors (closed)
  px.poly([WL(18, 0), WL(34.5, 0), WL(34.5, 42), WL(18, 42)], '#3A3460'); px.poly([WL(35.5, 0), WL(52, 0), WL(52, 42), WL(35.5, 42)], '#332D58');
  px.line(WL(35, 0), WL(35, 42), '#15112A'); px.line(WL(20, 40), WL(33, 40), '#5A52A0'); px.line(WL(37, 40), WL(50, 40), '#5A52A0');
  // AR's door: mint door with a sign
  px.poly([WL(56, 0), WL(74, 0), WL(74, 42), WL(56, 42)], '#1C3A34');
  px.poly([WL(57.5, 0), WL(72.5, 0), WL(72.5, 40), WL(57.5, 40)], '#2E6A5C');
  px.poly([WL(59, 22), WL(71, 22), WL(71, 37), WL(59, 37)], shade('#2E6A5C', 0.12));
  px.poly([WL(59, 3), WL(71, 3), WL(71, 19), WL(59, 19)], shade('#2E6A5C', -0.08));
  px.poly([WL(69, 17), WL(71, 17), WL(71, 19), WL(69, 19)], C.gold);
  px.poly([WL(60, 47), WL(70, 47), WL(70, 54), WL(60, 54)], '#0E2A24');
  px.text('AR', (a, b) => WL(61.5 + a, 52.5 - b), 1, '#7CF5B4', 1);
  // calendar (over the photo frame): month grid with a few marked days
  px.poly([WL(76, 21), WL(91, 21), WL(91, 40), WL(76, 40)], '#EDE8FF');
  px.poly([WL(76, 36), WL(91, 36), WL(91, 40), WL(76, 40)], C.pink);
  for (let r = 0; r < 3; r++) for (let k = 0; k < 4; k++) {
    const v0 = 77.5 + k * 3.4, h0 = 23 + r * 4;
    px.poly([WL(v0, h0), WL(v0 + 2.4, h0), WL(v0 + 2.4, h0 + 2.6), WL(v0, h0 + 2.6)], (r * 4 + k) % 5 === 2 ? C.cyan : '#B8B0E0');
  }
  // the safe: heavy box with a dial on its front face
  box(c, 0, 70, 0, 16, 18, 20, '#2C2C3A', { top: '#4A4A5E', right: '#1C1C28' });
  box(c, 16, 72, 3, 0.5, 14, 14, '#3A3A4C', { edge: false });
  const d = P(16.5, 79, 10); px.ring(d[0], d[1], 3, 3, '#B8B0D0', 1); px.dot(Math.floor(d[0]), Math.floor(d[1]), C.gold, 1);
  px.line(P(16.5, 84, 6), P(16.5, 84, 14), '#8C84B8');
  // the phone on the desk (cherry red, with a cord)
  box(c, 17, 120, 14, 6, 4, 2, '#A82848', { top: '#E0406A' });
  box(c, 17, 121, 16, 6, 2, 1, '#C8325A', { top: '#FF5C8A', edge: false });
  px.line(P(23, 122, 14), P(26, 126, 14), '#6A1A30');
  // trophies on top of the shelf
  for (const [v, hh] of [[121, 6], [127, 8], [133, 5]] as Pt[]) {
    box(c, 2, v, 40, 4, 3, 1, '#6B5530', { edge: false });
    box(c, 3, v + 0.5, 41, 2, 2, hh, '#B8862E', { top: C.gold, edge: false });
  }
  // exec chair at the desk (tall back)
  chairItem(c, 32, 111, '#5A2A36', 'seat'); chairItem(c, 32, 111, '#5A2A36', 'back', true);
  void STATUS_COL;
}

export function execFurniture(c: IC) {
  chiefDeskStatic(c);
  shelfItem(c);
  meetingStatic(c);
  plant(c, 84, 132, true, 7); plant(c, 12, 8, true, 11); plant(c, 232, 112, false, 5); plant(c, 100, 10, false, 9);
}

/** The tower map on the back wall: one lit row per floor, coloured by its state. Drawn live. */
export function orgMap(c: IC, depts: Dept[], t: number, lit: boolean) {
  const { P, px, L } = c;
  const WR = (u: number, h: number) => P(u, 140, h);
  px.poly([WR(94, 10), WR(178, 10), WR(178, 40), WR(94, 40)], '#0A0618');
  if (!lit) return;
  px.text('TOWER', (a, b) => WR(97 + a, 38 - b), 1, C.gold, 1);
  const rows = [{ label: 'PH', col: C.gold, n: 0 }, ...depts.map((d, i) => ({ label: `F${depts.length - i}`, col: d.state === 'unconfigured' ? C.amber : d.state === 'offline' ? '#6A6488' : d.workers.some((w) => w.status === 'failed') ? C.red : d.workers.some((w) => w.status === 'running') || d.chief?.status === 'running' ? C.cyan : C.lav, n: d.workers.length }))].slice(0, 6);
  const rh = 22 / Math.max(rows.length, 1);
  rows.forEach((r, i) => {
    const h1 = 31 - i * rh, h0 = h1 - rh + 1;
    px.poly([WR(97, h0), WR(130, h0), WR(130, h1), WR(97, h1)], shade(r.col, -0.55));
    px.poly([WR(97, h0), WR(99, h0), WR(99, h1), WR(97, h1)], r.col, 1);
    for (let k = 0; k < Math.min(6, r.n); k++) { const blink = Math.floor(t * 2 + k + i) % 5 === 0 ? 0.5 : 1; px.push(blink); px.poly([WR(102 + k * 4, h0 + 1), WR(104.5 + k * 4, h0 + 1), WR(104.5 + k * 4, h1 - 1), WR(102 + k * 4, h1 - 1)], r.col, 1); px.pop(); }
  });
  // right half: a tiny bar chart of agents per floor
  depts.slice(0, 8).forEach((d, i) => {
    const hgt = 3 + Math.min(18, (d.workers.length + 1) * 3);
    px.poly([WR(136 + i * 5, 12), WR(139 + i * 5, 12), WR(139 + i * 5, 12 + hgt), WR(136 + i * 5, 12 + hgt)], i % 2 ? C.pink : C.cyan, 1);
  });
  L.add(...P(136, 140, 25), 70, C.cyan, 0.35, 0.8);
}

/** Corners of a footprint box, projected (for hit tests and outlines). */
export function boxCorners(P: (u: number, v: number, h?: number) => Pt, b: [number, number, number, number, number, number]): Pt[] {
  const [u, v, h, du, dv, dh] = b;
  const out: Pt[] = [];
  for (const a of [0, du]) for (const bb of [0, dv]) for (const k of [0, dh]) out.push(P(u + a, v + bb, h + k));
  return out;
}
