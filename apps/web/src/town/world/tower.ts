/* Exterior: Vice-City night sky, stepped sunset, skyline, wet plaza with street lamps and palms,
   the lobby, stacked department floors and the gold penthouse. All pixel-rastered via Pix. */
import type { AgentStatus, Dept, DeptState } from '../data/types';
import { Pix, Lights, Bakery, NULL_LIGHTS, textWidth, type Pt } from './pix';
import { box, hash, C, STATUS_COL, type IC, type PFn } from './interior';
import { shade, getSprite, ghostSprite, lookFor, AX, AY, type Look } from './sprites';
import { clouds, farSkyline, bay, cityBack, skyLife, HZ } from './citybg';

export const FH = 56, PH_H = 88;
export const HEX = (T: number): Pt[] => [[0, T], [240, T + 120], [380, T + 50], [380, T + 106], [240, T + 176], [0, T + 56]];

/* ------------------------------------------------------------------ sky + city */
const SKY = ['#090516', '#0D0720', '#120929', '#180B34', '#210E41', '#2D114E', '#3D155A', '#521963', '#6B1E6B', '#882470', '#A82E76', '#C83C7C', '#E2507E'];
export function backdrop(px: Pix, L: Lights, t: number, openA: number, intro: number, bk: Bakery) {
  // sky bands (dithered transitions), emissive so lighting never muddies them
  const top = -1500, hz = HZ;
  px.rect(-2600, -4000, 6000, 4000 + top, SKY[0], 0.9);
  const n = SKY.length;
  let y0 = top;
  for (let i = 0; i < n; i++) {
    const f = (i + 1) / n, y1 = top + (hz - top) * Math.pow(f, 0.55);
    px.rect(-2600, y0, 6000, y1 - y0 + 1, SKY[i], 0.9);
    if (i + 1 < n) { px.dither([[-2600, y1 - 10], [3400, y1 - 10], [3400, y1], [-2600, y1]], SKY[i + 1], 0.25, 0.9); px.dither([[-2600, y1 - 5], [3400, y1 - 5], [3400, y1], [-2600, y1]], SKY[i + 1], 0.5, 0.9); }
    y0 = y1;
  }
  // stars
  for (let i = 0; i < 120; i++) {
    const x = -900 + hash(i, 1) * 2200, y = -1300 + hash(i, 2) * 1050, tw = 0.5 + 0.5 * Math.sin(t * (1 + hash(i, 3) * 2) + i);
    if (tw < 0.2) continue;
    const c = hash(i, 4) > 0.85 ? '#9FE8FF' : hash(i, 4) > 0.7 ? '#FFC7E8' : '#F4EEFF';
    px.push(tw); px.dot(Math.floor(x), Math.floor(y), c, 1, hash(i, 5) > 0.9 ? 2 : 1); px.pop();
  }
  skyLife(px, L, t, openA, bk);
  // stepped sunset sun with halo (baked per stripe-drift frame)
  const rise = 1 - Math.pow(1 - Math.min(1, intro * 1.3), 3);
  const cx = 190, cy = -312 + (1 - rise) * 160;
  const fr = Math.floor((t * 7) % 6);
  px.push(1 - openA * 0.8);
  bk.draw(px, bk.get('sun' + fr, (q) => sun(q, fr)), cx, Math.round(cy));
  px.pop();
  clouds(px, t, openA, bk);
  farSkyline(px, t, bk);
  px.rect(-2600, HZ, 6000, 1, '#FF3EA5', 1);
  bay(px, L, t, bk);
  cityBack(px, L, t, bk);
  L.add(190, cy, 520, '#FF6A8E', 0.22 * (1 - openA), 1);
}
function sun(px: Pix, fr: number) {
  const r = 230;
  circle(px, 0, 0, r + 46, '#5A1A66', 0.18, 0.9);
  circle(px, 0, 0, r + 20, '#B8337E', 0.3, 0.9);
  const STOPS = ['#FFF1A0', '#FFE07A', '#FFC864', '#FFAA58', '#FF8A5C', '#FF6A6E', '#F5508C', '#DC3CA0', '#B235AE', '#8C2FAE'];
  const stripes: [number, number][] = [[46, 3], [72, 4], [98, 6], [126, 8], [156, 10], [188, 13], [222, 16]];
  for (let yy = -r; yy < r; yy++) {
    let gap = false;
    for (const [o, w] of stripes) { const st = o + fr - 3; if (yy >= st && yy < st + w) { gap = true; break; } }
    if (gap) continue;
    const w = Math.sqrt(r * r - (yy + 0.5) * (yy + 0.5));
    const f = ((yy + r) / (2 * r)) * (STOPS.length - 1), i = Math.floor(f), fq = f - i;
    const col = STOPS[Math.min(STOPS.length - 1, i + (fq > (yy % 2 ? 0.66 : 0.33) ? 1 : 0))];
    px.rect(-w, yy, w * 2, 1, col, 1);
  }
}
function circle(px: Pix, cx: number, cy: number, r: number, col: string, level: number, em: number) {
  const pts: Pt[] = []; for (let i = 0; i < 48; i++) { const a = (i / 48) * Math.PI * 2; pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
  px.dither(pts, col, level, em);
}
export function palm(px: Pix, frame: number, x: number, y: number, s: number, rim: string) {
  const n = 22, Ht = 124 * s, bend = 26 * s;
  px.shadeEllipse(x + 30 * s, y, 26 * s, 6 * s, 0.35);
  let cx = x, cy = y;
  for (let k = 0; k < n; k++) {
    const f = k / n, nx = x + bend * f * f, ny = y - Ht * f, w = (7 - 3 * f) * s;
    px.rect(nx - w / 2, ny - Ht / n - 1, w, Ht / n + 1, k % 2 ? '#3A2234' : '#4A2E3E');
    px.rect(nx - w / 2, ny - Ht / n - 1, 1, Ht / n + 1, shade(rim, -0.35), 0.4);
    cx = nx; cy = ny;
  }
  const sway = Math.sin((frame / 8) * Math.PI * 2) * 3 * s;
  const fr: [number, number][] = [[-1, 0.15], [-0.75, -0.55], [-0.2, -1], [0.35, -0.9], [0.85, -0.45], [1, 0.2], [0.2, 0.55]];
  for (const [dx, dy] of fr) {
    const len = 62 * s; let px0 = cx, py0 = cy - 2;
    for (let k = 1; k <= 8; k++) {
      const f = k / 8, nx = cx + dx * len * f + sway * f, ny = cy - 2 + dy * len * f * 0.6 + 26 * s * f * f;
      px.line([px0, py0], [nx, ny], '#1A2A2A', 3 * s * (1 - f * 0.6));
      px.line([px0, py0 - 1.5 * s], [nx, ny - 1.5 * s], rim, 1, 0.75);
      if (k % 2 === 0) px.line([nx, ny], [nx + dx * 5 * s, ny + 7 * s], '#16262A', 1);
      px0 = nx; py0 = ny;
    }
  }
  px.ellipse(cx, cy, 5 * s, 4 * s, '#3A2234');
}

/* ------------------------------------------------------------------ lobby */
export function lobby(px: Pix, L: Lights, t: number, company: string, alpha: number, bk: Bakery) {
  const P: PFn = (u, v, h = 0) => [u + v, 64 + 0.5 * u - 0.5 * v - h];
  px.push(alpha); bk.draw(px, bk.get('lobby|' + company, (q) => lobbyStatic(q, company))); px.pop();
  // warm spill onto the plaza
  L.add(...P(120, -26, 0), 140, '#FFB46B', 0.62 * alpha);
  L.add(...P(120, 0, 26), 90, '#FFB46B', 0.3 * alpha, 0.9);
  L.add(...P(250, 70, 0), 80, C.cyan, 0.3 * alpha);
  void t;
}
function lobbyStatic(px: Pix, company: string) {
  const P: PFn = (u, v, h = 0) => [u + v, 64 + 0.5 * u - 0.5 * v - h];
  const c: IC = { px, L: NULL_LIGHTS, t: 0, P, power: 1 };
  px.poly([P(0, 0, 0), P(240, 0, 0), P(240, 0, 64), P(0, 0, 64)], '#2C2250');
  px.poly([P(240, 0, 0), P(240, 140, 0), P(240, 140, 64), P(240, 0, 64)], '#3B2F6A');
  px.poly([P(0, 0, 0), P(240, 0, 0), P(240, 0, 5), P(0, 0, 5)], '#1E1838'); px.line(P(0, 0, 5), P(240, 0, 5), '#5A4E90');
  // storefront: warm lobby glowing through the glass
  const LF = (a: number, h: number) => P(a, 0, h);
  const bands = ['#F0A060', '#D88050', '#B0603E', '#7A3E3A', '#4E2638'];
  bands.forEach((b, i) => px.poly([LF(10, 7 + i * 8.4), LF(230, 7 + i * 8.4), LF(230, 7 + (i + 1) * 8.4 + 0.5), LF(10, 7 + (i + 1) * 8.4 + 0.5)], b, 0.85));
  px.poly([LF(96, 7), LF(146, 7), LF(146, 15), LF(96, 15)], '#3A1E20');
  px.line(LF(96, 15), LF(146, 15), '#FFC75A', 1, 0.8);
  for (let a = 30; a < 230; a += 36) { px.line(LF(a, 49), LF(a, 42), '#2A1A1E'); px.rect(...(LF(a - 1, 42).map(Math.floor) as Pt), 3, 2, '#FFF1C8', 1); }
  for (const a of [26, 206]) { const p = LF(a, 12); px.ellipse(p[0], p[1], 7, 6, '#1E3A2A'); px.ellipse(p[0] - 1, p[1] - 2, 4, 3, '#2E5A3A'); }
  for (let a = 10; a <= 230; a += 20) px.line(LF(a, 7), LF(a, 49), a >= 98 && a <= 142 ? '#C9C3EA' : '#9C95C9');
  px.line(LF(10, 38), LF(230, 38), '#9C95C9'); px.line(LF(10, 49), LF(230, 49), '#C9C3EA');
  px.push(0.14); px.poly([LF(40, 49), LF(52, 49), LF(36, 7), LF(24, 7)], '#FFFFFF', -1); px.poly([LF(160, 49), LF(168, 49), LF(152, 7), LF(144, 7)], '#FFFFFF', -1); px.pop();
  // doors + canopy
  px.poly([LF(100, 7), LF(140, 7), LF(140, 36), LF(100, 36)], '#FFE2B0', 0.95);
  px.line(LF(120, 7), LF(120, 36), '#8C84B8', 1); px.line(LF(117, 18), LF(117, 24), '#3A2E50'); px.line(LF(123, 18), LF(123, 24), '#3A2E50');
  box(c, 92, -12, 40, 56, 12, 4, '#1E1838', { top: '#2E2650' });
  px.line(P(92, -12, 40), P(148, -12, 40), C.cyan, 1, 1);
  // company sign
  const name = company.toUpperCase().replace(/[^A-Z0-9 &.]/g, '');
  const s = textWidth(name, 2) <= 200 ? 2 : 1, w = textWidth(name, s);
  px.text(name, (a, b) => LF(120 - w / 2 + a + 1, 61 - b - 1), s, '#120A22', -1);
  px.text(name, (a, b) => LF(120 - w / 2 + a, 61 - b), s, C.pink, 1);
  // right face: service door + neon slits
  const RF = (b: number, h: number) => P(240, b, h);
  for (const b0 of [20, 58, 96]) px.poly([RF(b0, 10), RF(b0 + 14, 10), RF(b0 + 14, 50), RF(b0, 50)], C.cyan, 0.85);
  px.poly([RF(118, 0), RF(132, 0), RF(132, 26), RF(118, 26)], '#1E1838'); px.rect(...(RF(129, 13).map(Math.floor) as Pt), 1, 2, C.gold, 0.8);
  // trims
  px.line(P(0, 0, 64), P(240, 0, 64), C.pink, 2, 1); px.line(P(240, 0, 64), P(240, 140, 64), shade(C.pink, -0.2), 2, 1);
  px.line(P(240, 0, 0), P(240, 0, 64), '#6A5AA8');
  // reflections on the wet stone
  px.push(0.22);
  for (let a = 14; a < 230; a += 10) { const p = P(a, -4, 0); px.rect(p[0], p[1] + 2, 3, 10 + hash(a, 2) * 18, a > 96 && a < 146 ? '#FFD39A' : '#F0A060', 0.5); }
  px.pop();
}

/* ------------------------------------------------------------------ department floor */
const GLASS: Record<DeptState, { base: string; em: number; slit: string }> = {
  active: { base: '#1E527E', em: 0.75, slit: C.cyan },
  idle: { base: '#2E2864', em: 0.45, slit: '#8A7FD0' },
  attention: { base: '#5E1A3E', em: 0.65, slit: C.red },
  offline: { base: '#120E20', em: 0, slit: '#2A2540' },
  unconfigured: { base: '#0E0B18', em: 0, slit: '#2A2540' },
};
export interface FaceAgent { id: string; st: AgentStatus; look: Look; ghost?: boolean }
const faceP = (T: number, shift = 0): PFn => (u, v, h = 0) => [u + v + shift, T + 56 + 0.5 * u - 0.5 * v - h];
/** Facade, back layer: walls, spandrels and the lit interior seen through the glass. */
function facadeBack(px: Pix, state: DeptState, em: number) {
  const P = faceP(0), G = GLASS[state];
  const LF = (a: number, h: number) => P(a, 0, h), RF = (b: number, h: number) => P(240, b, h);
  px.poly([LF(0, 0), LF(240, 0), LF(240, 56), LF(0, 56)], '#30265A');
  px.poly([RF(0, 0), RF(140, 0), RF(140, 56), RF(0, 56)], '#43357A');
  px.poly([LF(0, 0), LF(240, 0), LF(240, 6), LF(0, 6)], '#211A40'); px.line(LF(0, 3), LF(240, 3), '#2E2552');
  px.poly([LF(0, 45), LF(240, 45), LF(240, 53), LF(0, 53)], '#2A2150');
  for (let a = 8; a < 236; a += 8) px.dot(...(LF(a, 49).map(Math.floor) as Pt), '#1A1434');
  px.poly([LF(6, 7), LF(234, 7), LF(234, 44), LF(6, 44)], G.base, em);
  px.poly([LF(6, 7), LF(234, 7), LF(234, 16), LF(6, 16)], shade(G.base, 0.16), em);
  px.dither([LF(6, 16), LF(234, 16), LF(234, 20), LF(6, 20)], shade(G.base, 0.16), 0.5, em);
  if (em > 0.1) for (let a = 14; a < 230; a += 16) px.line(LF(a, 42), LF(a + 8, 42), '#FFF1D8', 1, 1);
  for (let k = 0; k < 5; k++) {
    const a = 24 + k * 44;
    px.poly([LF(a, 7), LF(a + 22, 7), LF(a + 22, 13), LF(a, 13)], '#120E22');
    px.line(LF(a, 13), LF(a + 22, 13), '#2A2244');
    if (em > 0.1) { const mc = k % 3 === 0 ? C.cyan : k % 3 === 1 ? C.mint : '#B8B0E0'; px.poly([LF(a + 6, 14), LF(a + 13, 14), LF(a + 13, 19), LF(a + 6, 19)], mc, 1); }
    // plant + lamp silhouettes between desks
    if (k < 4) { const p = LF(a + 33, 14); px.ellipse(p[0], p[1], 4, 3, '#14241E'); }
  }
}
/** Facade, front layer: glass tint, mullions, right face, trims. */
function facadeFront(px: Pix, state: DeptState, em: number, num: number, power: number) {
  const P = faceP(0), G = GLASS[state];
  const c: IC = { px, L: NULL_LIGHTS, t: 0, P, power };
  const LF = (a: number, h: number) => P(a, 0, h), RF = (b: number, h: number) => P(240, b, h);
  px.push(0.16); px.poly([LF(6, 7), LF(234, 7), LF(234, 44), LF(6, 44)], '#BFEFFF', -1); px.pop();
  for (let a = 6; a <= 234; a += 24) { px.line(LF(a, 7), LF(a, 44), '#8C84C0'); px.line(LF(a + 1, 7), LF(a + 1, 44), '#4A4280'); }
  px.line(LF(6, 34), LF(234, 34), '#8C84C0'); px.line(LF(6, 44), LF(234, 44), '#B8B0E0'); px.line(LF(6, 7), LF(234, 7), '#5A5090');
  for (let b = 20; b < 140; b += 20) px.line(RF(b, 6), RF(b, 52), '#3A2D6A');
  px.line(RF(0, 6), RF(140, 6), '#2E2458'); px.line(RF(0, 45), RF(140, 45), '#5A4C98');
  for (const b0 of [16, 50, 84]) {
    const q: Pt[] = [RF(b0, 9), RF(b0 + 12, 9), RF(b0 + 12, 42), RF(b0, 42)];
    px.poly(q, G.slit, em > 0 ? Math.min(1, em + 0.2) : 0);
    px.line(RF(b0, 42), RF(b0 + 12, 42), shade(G.slit, 0.4), 1, em > 0 ? 1 : 0);
  }
  px.text('F' + num, (a, b) => RF(106 + a, 36 - b), 2, '#B8B0E0', 0.35);
  box(c, 240, 112, 8, 7, 18, 12, '#8C84B8', { top: '#B8B0E0' });
  for (let k = 0; k < 4; k++) px.line(P(247, 115 + k * 3.5, 10), P(247, 115 + k * 3.5, 18), '#5A5288');
  const trim = power > 0.3 ? 1 : 0;
  px.line(LF(0, 55), LF(240, 55), trim ? C.pink : '#5A2A50', 1, trim); px.line(LF(0, 56), LF(240, 56), trim ? '#FFB0DA' : '#4A2444', 1, trim);
  px.line(RF(0, 55), RF(140, 55), trim ? shade(C.pink, -0.25) : '#4A2444', 1, trim);
  px.line(LF(240, 0), LF(240, 56), '#6A5AA8');
}
/** What an agent seen through a floor's glass is doing, from its status and the clock (deterministic per seat, so
 *  floors do not move in step): at work they sit at a desk typing; idle they wander to the coffee machine or a
 *  colleague and back; a finished job gets a hop; a failure paces at the desk. `u` is the spot along the facade. */
function behave(st: AgentStatus, j: number, t: number, num: number) {
  const home = [44, 92, 136, 180, 214][j];
  const desk = 24 + j * 44 + 11;
  const still = { u: home, lift: 0, dir: 'f' as const, seated: false, frame: 0, flip: j % 2 === 1, mug: false, moving: false };
  if (st === 'running') return { ...still, u: desk, dir: 'b' as const, seated: true };
  if (st === 'failed') return { ...still, u: desk + Math.round(Math.sin(t * 1.3 + j) * 6), frame: Math.floor(t * 5) % 4, flip: Math.cos(t * 1.3 + j) < 0, moving: true };
  if (st === 'completed') { const k = (t + j * 1.9 + num) % 6; return { ...still, lift: k < 0.6 ? Math.round(Math.sin((k / 0.6) * Math.PI) * 7) : 0 }; }
  if (st !== 'idle') return still;
  // idle: stay, walk to a spot, linger, walk back
  const away = (j + num) % 3 === 0 ? 226 : Math.max(16, Math.min(226, home + ((j + num) % 2 ? 30 : -30)));
  const per = 15 + ((j * 7 + num * 3) % 6), k = ((t + j * 4.3 + num * 2.1) % per) / per;
  const go = (f: number) => home + (away - home) * f;
  const walking = (f: number, back: boolean) => ({ ...still, u: go(back ? 1 - f : f), frame: Math.floor(t * 7 + j) % 4, flip: (away > home) !== back, moving: true });
  if (k < 0.35) return still;
  if (k < 0.5) return walking((k - 0.35) / 0.15, false);
  if (k < 0.82) return { ...still, u: away, mug: away === 226, flip: away > home };
  if (k < 0.97) return walking((k - 0.82) / 0.15, true);
  return still;
}
export function floorFacade(px: Pix, L: Lights, t: number, d: Dept, T: number, shift: number, num: number, bk: Bakery, o: { faceA: number; hover: boolean; sel: boolean; flash: number; flashCol: string; shimmer: number; power: number; agents: FaceAgent[] }) {
  const P = faceP(T, shift);
  const blackout = o.power < 0.05;
  const look: DeptState = blackout ? 'offline' : d.state;
  const G = GLASS[look];
  const flick = d.state === 'attention' && Math.sin(t * 9) > 0.6 ? 0.55 : 1;
  const em = Math.round(G.em * flick * o.power * 20) / 20;
  const LF = (a: number, h: number) => P(a, 0, h), RF = (b: number, h: number) => P(240, b, h);
  px.push(o.faceA);
  bk.draw(px, bk.get(`fb|${look}|${em}`, (q) => facadeBack(q, look, em)), shift, T);
  const crew = o.agents.slice(0, 5).map((ag, j) => ({ ag, j, ...behave(ag.st, j, t, num) }));
  for (const { ag, j, u, lift, dir, seated, frame, flip, mug } of crew) {
    const foot = LF(u, 7);
    if (ag.ghost) { const g = ghostSprite(); px.sprite(g.img, null, foot[0] - AX, foot[1] - AY, false, 0.8); pip(px, 'awaiting', foot[0], foot[1] - 38); continue; }
    const sp = getSprite(ag.look, { dir, frame, seated, type: seated ? Math.floor(t * 7 + j) % 2 : 0 });
    px.push(ag.st === 'disconnected' ? 0.45 : 1); px.sprite(sp.img, sp.sil, foot[0] - AX, foot[1] - AY - lift, flip); px.pop();
    if (mug) { px.rect(Math.round(foot[0]) + 5, Math.round(foot[1]) - 15 - lift, 2, 3, '#F4EEFF'); px.dot(Math.round(foot[0]) + 7, Math.round(foot[1]) - 14 - lift, '#F4EEFF'); }
    // a finished job: a hop and a pop of confetti
    if (lift > 1) for (let k = 0; k < 4; k++) px.dot(Math.round(foot[0] - 6 + k * 4), Math.round(foot[1] - 44 - lift - (k % 2) * 3), [C.pink, C.cyan, C.gold, C.mint][k], 1, 1);
    // typing: a few bright pixels float up off the screen
    if (seated && ag.st === 'running') { const k = (t * 1.4 + j * 0.37) % 1; px.push(1 - k); px.dot(Math.round(foot[0] - 2 + j), Math.round(foot[1] - 30 - k * 12), C.cyan, 1, 1); px.pop(); }
    pip(px, ag.st, foot[0], foot[1] - 39 - lift + (seated ? 3 : 0));
  }
  // two idle agents standing together chat: a speech bubble takes turns over their heads
  for (const x of crew) for (const y of crew) {
    if (x.j >= y.j || x.moving || y.moving || x.seated || y.seated || Math.abs(x.u - y.u) > 26) continue;
    const who = Math.floor(t / 1.6 + x.j) % 2 ? x : y, q = LF(who.u, 7), bx = Math.round(q[0]) + 3, by = Math.round(q[1]) - 52;
    px.rect(bx, by, 11, 7, '#F4EEFF'); px.dot(bx + 1, by + 7, '#F4EEFF'); for (let k = 0; k < 3; k++) if (Math.floor(t * 4) % 4 > k) px.dot(bx + 2 + k * 3, by + 3, '#2A2244');
  }
  bk.draw(px, bk.get(`ff|${look}|${em}|${num}|${o.power}`, (q) => facadeFront(q, look, em, num, o.power)), shift, T);
  // drifting reflections on the glass
  px.push(0.12);
  for (let k = 0; k < 3; k++) { const a = ((t * 10 + k * 90 + num * 37) % 300) - 30; const cl = (x: number) => Math.max(6, Math.min(234, x)); px.poly([LF(cl(a), 44), LF(cl(a + 10), 44), LF(cl(a - 4), 7), LF(cl(a - 14), 7)], '#FFFFFF', 0.2); }
  px.pop();
  // blackout: only the battery-backed exit lights blink, slowly and out of step floor to floor
  if (blackout && Math.floor(t * 0.9 + num * 0.37) % 3 !== 0) {
    for (const a of [10, 228]) { const p = LF(a, 41); px.rect(p[0] - 1, p[1] - 1, 3, 2, C.red, 20); }
    const p = RF(70, 48); px.rect(p[0] - 1, p[1] - 1, 4, 2, '#7CF5B4', 20);
  }
  if (o.shimmer > 0) { const k = 1 - o.shimmer, a = 6 + k * 250; px.push(o.shimmer); px.poly([LF(a, 44), LF(a + 14, 44), LF(a + 4, 7), LF(a - 10, 7)], '#FFFFFF', 1); px.pop(); }
  px.pop();
  // outline: hover / selected / unconfigured / event flash
  const hex = HEX(T).map(([x, y]) => [x + shift, y] as Pt);
  const edge = (col: string, e: number, w = 1, dash?: [number, number]) => { for (let i = 0; i < 6; i++) px.line(hex[i], hex[(i + 1) % 6], col, w, e, dash, Math.floor(t * 8)); };
  px.push(o.faceA);
  if (o.sel || o.hover) edge(C.cyan, 1, 2);
  else if (d.state === 'unconfigured') edge(C.amber, 0.8, 2, [6, 4]);
  if (o.flash > 0) { px.push(Math.min(1, o.flash) * 0.35); px.poly(hex, o.flashCol, 0.6); px.pop(); px.push(Math.min(1, o.flash)); edge(o.flashCol, 1, 2); px.pop(); }
  px.pop();
  if (em > 0.05) L.add(...P(120, -14, 26), 130, G.slit === C.cyan ? '#5AB8FF' : G.slit, 0.22 * em * o.faceA, 0.6);
  if (o.power > 0.3) L.add(...P(120, -6, 56), 120, C.pink, 0.12 * o.faceA, 0.4);
}
/** The next floor, under construction: bare concrete slabs and columns, scaffolding, hazard tape, work lamps and a
 *  hologram "+" where the next department goes. Solid, so the tower never looks cut in half. */
export function ghostFloor(px: Pix, L: Lights, t: number, T: number, a: number, hover: boolean, bk: Bakery) {
  const P = faceP(T);
  const LF = (u: number, h: number) => P(u, 0, h), RF = (b: number, h: number) => P(240, b, h);
  px.push(a);
  bk.draw(px, bk.get('ghost', (q) => ghostStatic(q)), 0, Math.round(T));
  // the hologram plus, breathing; brighter on hover
  const k = hover ? 1 : 0.65 + 0.25 * Math.sin(t * 2.4);
  const c = LF(120, 28);
  px.push(k);
  px.rect(c[0] - 13, c[1] - 1, 26, 3, C.cyan, 1); px.rect(c[0] - 1, c[1] - 13, 3, 26, C.cyan, 1);
  px.rect(c[0] - 11, c[1], 22, 1, '#E8FDFF', 1); px.rect(c[0], c[1] - 11, 1, 22, '#E8FDFF', 1);
  px.pop();
  // scan line sweeping the plus
  const sy = c[1] - 14 + ((t * 18) % 30);
  px.push(0.35 * k); px.rect(c[0] - 16, Math.round(sy), 33, 1, C.cyan, 1); px.pop();
  // the work lamps blink their warning lights out of step
  for (const [u, ph] of [[46, 0], [194, 1.7]] as const) if (Math.sin(t * 3 + ph) > 0.2) { const q = LF(u, 47); px.rect(Math.round(q[0]) - 1, Math.round(q[1]) - 1, 3, 2, C.amber, 1); }
  if (hover) { const hex = HEX(T); for (let i = 0; i < 6; i++) px.line(hex[i], hex[(i + 1) % 6], C.cyan, 2, 1); }
  px.pop();
  L.add(...LF(120, 28), 90, C.cyan, (hover ? 0.5 : 0.3) * a, 0.8);
  L.add(...LF(46, 40), 60, '#FFB46B', 0.25 * a, 0.7); L.add(...LF(194, 40), 60, '#FFB46B', 0.25 * a, 0.7);
  void RF;
}
function ghostStatic(px: Pix) {
  const P = faceP(0);
  const LF = (u: number, h: number) => P(u, 0, h), RF = (b: number, h: number) => P(240, b, h);
  // the shell: an open interior between two slabs, warm where the work lamps hang
  px.poly([LF(0, 0), LF(240, 0), LF(240, 56), LF(0, 56)], '#1E1922');
  px.poly([RF(0, 0), RF(140, 0), RF(140, 56), RF(0, 56)], '#2A2430');
  px.poly([LF(4, 8), LF(236, 8), LF(236, 26), LF(4, 26)], '#2A2228');
  for (const u of [46, 194]) { px.dither([LF(u - 30, 8), LF(u + 30, 8), LF(u + 22, 40), LF(u - 22, 40)], '#5A3E2C', 0.5); px.poly([LF(u - 16, 8), LF(u + 16, 8), LF(u + 10, 30), LF(u - 10, 30)], '#4A3426'); }
  // materials inside: a pallet of blocks and a cement mixer
  px.poly([LF(150, 8), LF(178, 8), LF(178, 15), LF(150, 15)], '#6E6672'); px.poly([LF(152, 15), LF(174, 15), LF(174, 20), LF(152, 20)], '#857C88');
  px.line(LF(150, 11), LF(178, 11), '#4A4450'); px.line(LF(164, 8), LF(164, 20), '#4A4450');
  const m = LF(84, 15).map(Math.round) as Pt; px.ellipse(m[0], m[1], 7, 6, '#C2643A'); px.ellipse(m[0] - 2, m[1] - 2, 3, 2, '#E08A54'); px.rect(m[0] - 1, m[1] + 5, 2, 4, '#3A3440');
  // slabs: thick raw concrete with a lit lip and form-work marks
  px.poly([LF(0, 0), LF(240, 0), LF(240, 8), LF(0, 8)], '#77707E'); px.line(LF(0, 8), LF(240, 8), '#A39CA8'); px.line(LF(0, 1), LF(240, 1), '#4E4856');
  px.poly([LF(0, 48), LF(240, 48), LF(240, 56), LF(0, 56)], '#6A6372'); px.line(LF(0, 48), LF(240, 48), '#3A3440'); px.line(LF(0, 55), LF(240, 55), '#8E8796');
  for (let u = 12; u < 240; u += 24) { px.line(LF(u, 1), LF(u, 7), '#625B6A'); px.line(LF(u, 49), LF(u, 55), '#5A5362'); }
  px.poly([RF(0, 0), RF(140, 0), RF(140, 8), RF(0, 8)], '#5E5866'); px.poly([RF(0, 48), RF(140, 48), RF(140, 56), RF(0, 56)], '#544E5C');
  // columns
  for (const u of [0, 60, 120, 180, 233]) { px.poly([LF(u, 8), LF(u + 7, 8), LF(u + 7, 48), LF(u, 48)], '#77707E'); px.line(LF(u, 8), LF(u, 48), '#A39CA8'); px.line(LF(u + 7, 8), LF(u + 7, 48), '#4E4856'); }
  for (const b of [44, 92, 133]) px.poly([RF(b, 8), RF(b + 7, 8), RF(b + 7, 48), RF(b, 48)], '#5E5866');
  // scaffolding in front of the left face: two-pixel poles, plank decks, braces
  for (const u of [14, 74, 134, 194]) { px.line(LF(u, 0), LF(u, 56), '#E0A84A', 2); px.line(LF(u + 1, 0), LF(u + 1, 56), '#8A5E22', 1); }
  for (const h of [24, 40]) { px.poly([LF(10, h), LF(230, h), LF(230, h + 3), LF(10, h + 3)], '#9A6A34'); px.line(LF(10, h + 3), LF(230, h + 3), '#C88E4A'); }
  for (const u of [14, 134]) { px.line(LF(u, 8), LF(u + 60, 24), '#B88A3A', 1); px.line(LF(u + 60, 27), LF(u, 40), '#B88A3A', 1); }
  // hazard tape across the open edge: yellow and black
  px.line(LF(6, 12), LF(234, 12), '#F0C23C', 3); px.line(LF(6, 12), LF(234, 12), '#1A1418', 3, 0, [5, 5]);
  // work lamps on the ceiling slab
  for (const u of [46, 194]) { const q = LF(u, 47).map(Math.round) as Pt; px.line(LF(u, 48), LF(u, 45), '#3A3440'); px.rect(q[0] - 3, q[1] + 2, 7, 3, '#FFE2B0', 1); }
  // right face: a crane hook on its cable and the stencil
  px.line(RF(112, 56), RF(112, 30), '#A39CA8', 1); px.rect(...(RF(112, 30).map(Math.round) as Pt), 3, 4, '#F0C23C');
  px.text('NEXT', (a, b) => RF(14 + a, 36 - b), 2, '#A39CA8', 0);
  px.line(LF(240, 0), LF(240, 56), '#A39CA8');
}

/* ------------------------------------------------------------------ penthouse */
export function penthouse(px: Pix, L: Lights, t: number, T: number, alpha: number, company: string, sel: boolean, bk: Bakery) {
  const H = PH_H;
  const P: PFn = (u, v, h = 0) => [u + v, T + H + 0.5 * u - 0.5 * v - h];
  const R = (u: number, v: number, h = 0) => P(u, v, H + h);
  const flick = Math.sin(t * 17) > -0.92 ? 1 : 0.3;
  px.push(alpha);
  bk.draw(px, bk.get(`ph|${company}|${flick}`, (q) => phStatic(q, company, flick)), 0, Math.round(T));
  px.ring(205, T + 25, 50, 25, C.cyan, 2, 1, [7, 6], Math.floor(t * 10));
  for (let k = 0; k < 12; k++) { const a = (k / 12) * Math.PI * 2, on = Math.floor(t * 6) % 12 === k; px.dot(Math.floor(205 + Math.cos(a) * 56), Math.floor(T + 25 + Math.sin(a) * 28), on ? '#FFFFFF' : C.cyan, on ? 1 : 0.6, 2); }
  if (Math.sin(t * 3) > 0) { const a = R(170, 120, 64); px.rect(a[0] - 2, a[1] - 2, 4, 4, C.red, 1); L.add(a[0], a[1], 40, C.red, 0.5 * alpha, 1); }
  if (sel) { const LF = (a: number, h: number) => P(a, 0, h), RF = (b: number, h: number) => P(240, b, h); const hex: Pt[] = [LF(0, 0), LF(0, H), P(0, 140, H), RF(140, H), RF(140, 0), LF(240, 0)]; for (let i = 0; i < hex.length; i++) px.line(hex[i], hex[(i + 1) % hex.length], C.gold, 2, 1); }
  px.pop();
  L.add(205, T + 25, 70, C.cyan, 0.25 * alpha, 0.5);
  L.add(...P(80, 128, H + 50), 110, C.pink, 0.4 * alpha, 0.8);
  L.add(...P(120, -10, 40), 150, '#FFB46B', 0.28 * alpha, 0.7);
}
function phStatic(px: Pix, company: string, flick: number) {
  const H = PH_H, T = 0, L = NULL_LIGHTS;
  const P: PFn = (u, v, h = 0) => [u + v, T + H + 0.5 * u - 0.5 * v - h];
  const c: IC = { px, L, t: 0, P, power: 1 };
  const LF = (a: number, h: number) => P(a, 0, h), RF = (b: number, h: number) => P(240, b, h);
  px.poly([LF(0, 0), LF(240, 0), LF(240, H), LF(0, H)], '#3A2C4E');
  px.poly([RF(0, 0), RF(140, 0), RF(140, H), RF(0, H)], '#4E3A66');
  // executive floor: warm room behind tall glass
  const bands = ['#D8964A', '#B87038', '#8A4A2C', '#5A3024', '#3A2018'];
  bands.forEach((b, i) => px.poly([LF(10, 8 + i * 13.6), LF(230, 8 + i * 13.6), LF(230, 8 + (i + 1) * 13.6 + 0.5), LF(10, 8 + (i + 1) * 13.6 + 0.5)], b, 0.8));
  px.poly([LF(50, 8), LF(170, 8), LF(170, 20), LF(50, 20)], '#2A1810'); px.line(LF(50, 20), LF(170, 20), C.gold, 1, 0.9);
  for (let a = 56; a < 170; a += 14) px.poly([LF(a, 20), LF(a + 6, 20), LF(a + 6, 27), LF(a, 27)], '#3A2018');
  for (let a = 40; a < 230; a += 40) { px.line(LF(a, 76), LF(a, 64), '#2A1810'); px.rect(...(LF(a - 2, 64).map(Math.floor) as Pt), 5, 3, '#FFF1C8', 1); }
  px.poly([LF(190, 40), LF(214, 40), LF(214, 58), LF(190, 58)], '#2A1810'); px.poly([LF(192, 42), LF(212, 42), LF(212, 56), LF(192, 56)], '#FF7A6B', 0.6);
  px.push(0.15); for (const a of [30, 110, 180]) px.poly([LF(a, 76), LF(a + 12, 76), LF(a - 8, 8), LF(a - 20, 8)], '#FFFFFF', -1); px.pop();
  for (let a = 10; a <= 230; a += 30) { px.line(LF(a, 8), LF(a, 76), '#C9A45A'); px.line(LF(a + 1, 8), LF(a + 1, 76), '#6B5530'); }
  px.line(LF(10, 60), LF(230, 60), '#C9A45A'); px.line(LF(10, 8), LF(230, 8), '#6B5530');
  for (const b0 of [18, 56, 94]) px.poly([RF(b0, 10), RF(b0 + 14, 10), RF(b0 + 14, 74), RF(b0, 74)], '#E8B65A', 0.85);
  // gold trims
  for (const h of [0, H - 1]) { px.line(LF(0, h), LF(240, h), C.gold, 2, 1); px.line(RF(0, h), RF(140, h), shade(C.gold, -0.2), 2, 1); }
  px.line(LF(240, 0), LF(240, H), '#8A6A30');
  // roof
  const R = (u: number, v: number, h = 0) => P(u, v, H + h);
  px.poly([R(0, 0), R(240, 0), R(240, 140), R(0, 140)], '#3A2E60');
  for (let u = 20; u < 240; u += 20) px.line(R(u, 0), R(u, 140), '#33285A');
  for (let v = 20; v < 140; v += 20) px.line(R(0, v), R(240, v), '#33285A');
  // helipad
  px.ring(205, T + 25, 52, 26, '#2A2250', 3);
  px.ring(205, T + 25, 38, 19, '#FFC75A', 1, 0.35);
  px.text('H', (a, b) => R(121 + a * 1.3, 86 - b * 1.3), 4, '#F4EEFF', 0.4);
  // water tank, AC units
  box(c, 24, 96, H, 3, 3, 10, '#2A2448', { edge: false }); box(c, 40, 96, H, 3, 3, 10, '#2A2448', { edge: false });
  box(c, 22, 94, H + 10, 24, 22, 20, '#6B4A3A', { top: '#8A6048' });
  for (let k = 0; k < 3; k++) px.line(R(22, 94, 14 + k * 6), R(46, 94, 14 + k * 6), '#4A3024');
  box(c, 70, 112, H, 22, 14, 9, '#8C84B8', { top: '#B8B0E0' }); box(c, 100, 112, H, 16, 14, 9, '#8C84B8', { top: '#B8B0E0' });
  // parapet lip
  px.line(R(0, 0, 2), R(240, 0, 2), '#B8A06A'); px.line(R(240, 0, 2), R(240, 140, 2), '#8A7040');
  for (let u = 0; u <= 240; u += 12) px.line(R(u, 0, 0), R(u, 0, 6), '#8A7040');
  px.line(R(0, 0, 6), R(240, 0, 6), C.gold, 1, 0.5);
  // rooftop sign: company name on two lines of neon
  const words = company.toUpperCase().replace(/[^A-Z0-9 &.]/g, '').split(' ');
  let l1 = '', l2 = '';
  for (const w of words) { if (textWidth((l1 + ' ' + w).trim(), 3) <= 140 && !l2) l1 = (l1 + ' ' + w).trim(); else l2 = (l2 + ' ' + w).trim(); }
  const sw = Math.max(textWidth(l1, 3), textWidth(l2, 3)) + 16;
  const S = (a: number, h: number) => P(14 + a, 128, H + h);
  box(c, 20, 127, H, 3, 2, 14, '#2A2448', { edge: false }); box(c, 14 + sw - 10, 127, H, 3, 2, 14, '#2A2448', { edge: false });
  const sh = l2 ? 58 : 36;
  px.poly([S(0, 14), S(sw, 14), S(sw, 14 + sh), S(0, 14 + sh)], '#150C29');
  px.line(S(0, 14 + sh), S(sw, 14 + sh), C.pink, 1, 1); px.line(S(0, 14), S(sw, 14), C.pink, 1, 1); px.line(S(0, 14), S(0, 14 + sh), C.pink, 1, 1); px.line(S(sw, 14), S(sw, 14 + sh), C.pink, 1, 1);
  px.text(l1, (a, b) => S(8 + a, 14 + sh - 6 - b), 3, C.pink, flick);
  if (l2) px.text(l2, (a, b) => S(8 + a, 14 + sh - 29 - b), 3, C.cyan, 1);
  // antenna
  px.line(R(170, 120, 0), R(170, 120, 62), '#5A47A0', 2);
  px.line(R(170, 120, 40), R(176, 120, 30), '#5A47A0');
  void L;
}

/* ------------------------------------------------------------------ the opening bell (IPO) */
const CEO_LOOK = lookFor('ceo', '#3A2A5E', true);
/** The exchange bell on the roof of a listed company: a timber frame beside the helipad with a brass bell hung in it.
 *  `swing` is the bell's angle (radians, 0 at rest). `show` (0..1) brings in what only the ceremony has: the CEO on
 *  the rope and the LISTED ticker running along the parapet. */
export function roofBell(px: Pix, L: Lights, t: number, T: number, alpha: number, o: { swing: number; show: number; symbol: string; hover: boolean }) {
  const H = PH_H;
  const P: PFn = (u, v, h = 0) => [u + v, T + H + 0.5 * u - 0.5 * v - h];
  const R = (u: number, v: number, h = 0) => P(u, v, H + h);
  const c: IC = { px, L: NULL_LIGHTS, t: 0, P, power: 1 };
  // the bell turns about the pin it hangs from; x across, y down from the pin
  const pin = R(69.5, 30.5, 55), cs = Math.cos(o.swing), sn = Math.sin(o.swing);
  const B = (x: number, y: number, k = 1): Pt => { const co = k === 1 ? cs : Math.cos(o.swing * k), si = k === 1 ? sn : Math.sin(o.swing * k); return [pin[0] + 1.2 * (x * co - y * si), pin[1] + 1.2 * (x * si + y * co)]; };
  const side: Pt[] = [[3, 2], [7, 5], [9, 11], [11, 20], [14, 26], [18, 30], [18, 33]];
  const oval = (rx: number, ry: number, y: number, k = 1) => Array.from({ length: 12 }, (_, i) => B(Math.cos((i / 12) * Math.PI * 2) * rx, y + Math.sin((i / 12) * Math.PI * 2) * ry, k));
  px.push(alpha);
  const ground = R(69.5, 30.5);
  px.shadeEllipse(ground[0] + 4, ground[1], 24, 9, 0.4);
  box(c, 44, 29, H, 3, 3, 56, '#6B4A3A', { top: '#8A6048' });
  if (o.show > 0.01) {
    // the CEO on the rope, rising on every pull
    const g = R(33, 31), lift = Math.round(Math.abs(o.swing) * 6), sp = getSprite(CEO_LOOK, { dir: 'f', frame: 0, seated: false, type: 0 });
    px.push(o.show);
    px.shadeEllipse(g[0] + 2, g[1], 8, 3.5, 0.45);
    px.sprite(sp.img, sp.sil, g[0] - AX, g[1] - AY - lift);
    px.line([g[0] + 6, g[1] - 21 - lift], B(0, 38, 1.5), '#E8D8A0');
    px.pop();
  }
  px.poly(oval(3, 3, 38, 1.5), '#8A5A1E'); // the clapper swings wider than the bell
  px.poly([...side.map(([x, y]) => B(-x, y)), ...side.map(([x, y]) => B(x, y)).reverse()], C.gold, 0.55);
  px.poly([B(2, 2), ...side.slice(1).map(([x, y]) => B(x * 0.45, y)), ...side.map(([x, y]) => B(x, y)).reverse()], '#D8962E', 0.45);
  px.poly(oval(18, 4, 33), '#B8782A', 0.4);
  px.line(B(-4, 6), B(-9, 25), '#FFF1B0', 1, 1);
  px.poly([B(-3, -2), B(3, -2), B(3, 3), B(-3, 3)], '#8A6048');
  // the bell is a button (it opens /invest): a rim that breathes at rest, bright cyan under the pointer like a floor
  const rim = [...side.map(([x, y]) => B(-x, y)), ...side.map(([x, y]) => B(x, y)).reverse()];
  const rimA = o.hover ? 1 : 0.45 + 0.3 * Math.sin(t * 2.4);
  rim.forEach((p, i) => px.line(p, rim[(i + 1) % rim.length]!, o.hover ? C.cyan : '#FFE7A0', o.hover ? 2 : 1, rimA));
  box(c, 41, 29, H + 56, 57, 3, 4, '#7A5440', { top: '#9A6E50' });
  box(c, 92, 29, H, 3, 3, 56, '#6B4A3A', { top: '#8A6048' });
  if (o.show > 0.01) {
    // the ticker: an LED band under the roof's edge, the symbol in gold
    const LF = (a: number, h: number) => P(a, 0, h);
    const msg = `${o.symbol} LISTED · SPUTNIK DAO · NEP-141 · `, len = msg.length * 8, off = Math.floor(t * 40) % len;
    px.push(o.show);
    px.poly([LF(4, H - 14), LF(236, H - 14), LF(236, H - 2), LF(4, H - 2)], '#07120E');
    px.line(LF(4, H - 14), LF(236, H - 14), C.mint, 1, 0.8);
    [...msg].forEach((ch, i) => {
      const a0 = (((i * 8 - off) % len) + len) % len;
      if (a0 <= 224) px.text(ch, (a, b) => LF(5 + a0 + a, H - 3 - b), 2, i < o.symbol.length ? C.gold : C.mint, 1);
    });
    px.pop();
    L.add(...LF(120, H - 8), 130, C.mint, 0.3 * o.show * alpha, 0.5);
  }
  px.pop();
  L.add(pin[0], pin[1] + 24, 66, C.gold, (0.3 + 0.5 * o.show) * alpha, 0.8);
}

/* ------------------------------------------------------------------ status pips (pixel) */
export function pip(px: Pix, st: AgentStatus, x: number, y: number, s = 1) {
  const c = STATUS_COL[st];
  x = Math.round(x); y = Math.round(y);
  const r = Math.round(3 * s);
  px.push(1);
  switch (st) {
    case 'running': px.poly([[x, y - r - 1], [x + r + 1, y], [x, y + r + 1], [x - r - 1, y]], '#0B0716'); px.poly([[x, y - r], [x + r, y], [x, y + r], [x - r, y]], c, 1); px.dot(x - 1, y - 1, '#FFFFFF', 1); break;
    case 'idle': px.rect(x - r - 1, y - 2, 2 * r + 2, 4, '#0B0716'); px.rect(x - r, y - 1, 2 * r, 2, c, 1); break;
    case 'completed': px.line([x - r, y], [x - 1, y + r - 1], c, 2, 1); px.line([x - 1, y + r - 1], [x + r, y - r], c, 2, 1); break;
    case 'failed': px.line([x - r, y - r], [x + r, y + r], c, 2, 1); px.line([x + r, y - r], [x - r, y + r], c, 2, 1); break;
    case 'disconnected': px.line([x - r, y - r], [x + r, y - r], c, 1, 0.6); px.line([x + r, y - r], [x + r, y + r], c, 1, 0.6); px.line([x + r, y + r], [x - r, y + r], c, 1, 0.6); px.line([x - r, y + r], [x - r, y - r], c, 1, 0.6); break;
    case 'awaiting': px.poly([[x, y - r - 1], [x + r + 1, y + r], [x - r - 1, y + r]], c, 1); px.dot(x, y - 1, '#0B0716', 0); break;
  }
  px.pop();
}
