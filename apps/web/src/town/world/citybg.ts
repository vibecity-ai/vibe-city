/* The city around the tower, Vice City style:
   - a layered far skyline with sunset haze, art-deco crowns, spires, billboards and neon
   - a bay with rippling reflections and boats, searchlights, a blimp, birds and a plane in the sky
   - an iso street grid around the tower: coast road + promenade, Ocean-Drive pastel hotels with
     neon trims and blade signs, a pool park, a parking lot, tall towers behind, moving traffic.
   Everything static is baked once; traffic, water, sky life and lights are live. */
import { Pix, Lights, Bakery, NULL_LIGHTS, textWidth, type Pt } from './pix';
import { box, hash, C, type IC, type PFn } from './interior';
import { shade, mix } from './sprites';

export const HZ = -42;
/** Ground projection: the tower lot spans u 0..360, v 0..210 and the tower sits on u 60..300, v 35..175. */
export const G: PFn = (u, v, h = 0) => [-95 + u + v, 51 + 0.5 * u - 0.5 * v - h];
const NEON = [C.pink, C.cyan, C.mint, C.gold, C.violet, '#FF7A6B'];
const PASTEL = ['#E88AB4', '#7FD6C4', '#EFAA84', '#AE9AE8', '#ECE4F6', '#84BEEC', '#F2D486'];
const TALL = ['#4A5A92', '#3E4A7E', '#5A4C8C', '#36446E', '#62568E', '#33587E'];
const WORDS = ['HOTEL', 'VICE', 'CLUB', 'BAR', 'DINER', 'MOTEL', 'DISCO', 'SURF', 'PALMS', 'OCEAN', 'TACOS', '24H', 'ARCADE', 'PIER', 'NEON'];

const clipY = (pts: Pt[], y0: number): Pt[] => {
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length], ia = a[1] >= y0, ib = b[1] >= y0;
    if (ia) out.push(a);
    if (ia !== ib) { const k = (y0 - a[1]) / (b[1] - a[1]); out.push([a[0] + (b[0] - a[0]) * k, y0]); }
  }
  return out;
};
const quad = (u0: number, v0: number, u1: number, v1: number, h = 0): Pt[] => clipY([G(u0, v0, h), G(u1, v0, h), G(u1, v1, h), G(u0, v1, h)], HZ + 1);
const gc = (px: Pix): IC => ({ px, L: NULL_LIGHTS, t: 0, P: G, power: 1 });

/* ================================================================== model (deterministic) */
interface Bld { u: number; v: number; du: number; dv: number; h: number; col: string; neon: string; seed: number; tall: boolean; sign?: string; roof?: string; pool?: boolean }
interface Prop { kind: 'palm' | 'lamp' | 'bench' | 'bin' | 'hydrant' | 'stop' | 'planter' | 'news'; u: number; v: number; s: number; rim: string; axis?: 'u' | 'v' }
interface Lt { x: number; y: number; r: number; c: string; i: number; sy: number }
interface Model { back: Bld[]; front: Bld[]; backProps: Prop[]; frontProps: Prop[]; lotProps: Prop[]; lights: Lt[] }
let MODEL: Model | null = null;
const BU = 424, BV = 274;
function model(): Model {
  if (MODEL) return MODEL;
  const back: Bld[] = [], front: Bld[] = [], backProps: Prop[] = [], frontProps: Prop[] = [], lotProps: Prop[] = [], lights: Lt[] = [];
  const addB = (b: Bld) => {
    (b.u > 300 || b.v < 35 ? front : back).push(b);
    // storefront spill + sign glow
    const pf = G(b.u + b.du / 2, b.v - 6, 0); lights.push({ x: pf[0], y: pf[1], r: Math.min(70, b.du * 0.7), c: b.tall ? '#FFC88A' : b.neon, i: 0.4, sy: 0.5 });
    const pr = G(b.u + b.du + 6, b.v + b.dv / 2, 0); lights.push({ x: pr[0], y: pr[1], r: Math.min(60, b.dv * 0.7), c: '#FFB46B', i: 0.3, sy: 0.5 });
    const top = G(b.u + b.du, b.v, b.h); lights.push({ x: top[0], y: top[1], r: 50, c: b.neon, i: 0.35, sy: 1 });
  };
  // blocks around the tower lot (i, j) in a 424 x 274 grid; i = -1 is the bay
  const blocks: [number, number, string][] = [[1, 0, 'deco'], [2, 0, 'tall'], [1, -1, 'parking'], [2, -1, 'deco'], [0, -1, 'park'], [3, 0, 'tall'], [3, -1, 'deco'], [0, -2, 'court'], [1, -2, 'deco'], [2, -2, 'tall'], [3, -2, 'deco']];
  for (const [i, j, kind] of blocks) {
    const u0 = i * BU, v0 = j * BV;
    if (kind === 'park') {
      for (const [pu, pv] of [[30, 40], [110, 30], [330, 120], [300, 40], [200, 170], [40, 160]] as Pt[]) frontProps.push({ kind: 'palm', u: u0 + pu, v: v0 + pv, s: 0.55 + hash(pu, pv) * 0.25, rim: hash(pv, pu) > 0.5 ? C.pink : C.cyan });
      continue;
    }
    if (kind === 'parking') {
      for (const pu of [40, 180, 320]) frontProps.push({ kind: 'lamp', u: u0 + pu, v: v0 + 105, s: 1, rim: '' });
      continue;
    }
    if (kind === 'court') {
      for (const [pu, pv] of [[6, 6], [176, 6], [6, 204], [176, 204], [354, 6], [354, 204]] as Pt[]) frontProps.push({ kind: 'lamp', u: u0 + pu, v: v0 + pv, s: 1, rim: '' });
      for (const [pu, pv] of [[196, 30], [340, 120], [210, 190]] as Pt[]) frontProps.push({ kind: 'palm', u: u0 + pu, v: v0 + pv, s: 0.6 + hash(pu, pv) * 0.2, rim: hash(pv, pu) > 0.5 ? C.pink : C.cyan });
      streetProps(frontProps, u0, v0, i * 3 + j + 10);
      continue;
    }
    // parcels: 3 along u x 2 along v
    for (let a = 0; a < 3; a++) for (let b = 0; b < 2; b++) {
      const sd = hash(i * 7 + a, j * 5 + b);
      const pu = u0 + a * 120 + 10, pv = v0 + b * 105 + 10;
      const du = 70 + Math.floor(sd * 30), dv = 60 + Math.floor(hash(sd * 99, 3) * 25);
      const tall = kind === 'tall';
      const hh = tall ? 46 + Math.floor(Math.pow(hash(a, j * 3 + b + i), 1.6) * 120) : 26 + Math.floor(hash(a + i, b + 9) * 30);
      if (!tall && hash(a, b + i * 3) > 0.82) continue;
      addB({
        u: pu, v: pv, du, dv, h: hh, tall, seed: sd,
        col: tall ? TALL[Math.floor(sd * TALL.length)] : PASTEL[Math.floor(hash(sd, 5) * PASTEL.length)],
        neon: NEON[Math.floor(hash(sd, 7) * NEON.length)],
        sign: !tall && hash(sd, 11) > 0.35 ? WORDS[Math.floor(hash(sd, 13) * WORDS.length)] : undefined,
        roof: tall && hash(sd, 17) > 0.6 ? WORDS[Math.floor(hash(sd, 19) * WORDS.length)] : undefined,
        pool: !tall && du > 76 && hash(sd, 23) > 0.5,
      });
    }
    // sidewalk props on the block's front edges
    for (let k = 0; k < 4; k++) frontProps.push({ kind: k % 2 ? 'lamp' : 'palm', u: u0 + 30 + k * 95, v: v0 - 6, s: 0.6, rim: NEON[k % NEON.length] });
    streetProps(frontProps, u0, v0, i * 3 + j + 10);
  }
  // promenade along the bay (coast road u -52..-12, seawall at u -64)
  for (let v = -380; v < 640; v += 80) { backProps.push({ kind: 'lamp', u: -58, v, s: 1, rim: '' }); if (Math.abs(v) % 160 === 60 || v % 160 === 0) backProps.push({ kind: 'palm', u: -58, v: v + 40, s: 0.55 + hash(v, 1) * 0.15, rim: hash(v, 2) > 0.5 ? C.pink : C.cyan }); }
  for (let u = -40; u < 1500; u += 80) { backProps.push({ kind: 'lamp', u, v: 268, s: 1, rim: '' }); if (u % 160 === 40) backProps.push({ kind: 'palm', u: u + 40, v: 268, s: 0.6, rim: u % 320 === 40 ? C.pink : C.cyan }); }
  // the tower lot's own sidewalks
  for (const u of [20, 100, 180, 260, 340]) lotProps.push({ kind: 'lamp', u, v: -6, s: 1, rim: '' });
  for (const v of [30, 110, 190]) lotProps.push({ kind: 'lamp', u: 366, v, s: 1, rim: '' });
  lotProps.push({ kind: 'palm', u: 366, v: 150, s: 0.9, rim: C.cyan }); lotProps.push({ kind: 'palm', u: 0, v: -6, s: 1, rim: C.pink });
  lotProps.push({ kind: 'palm', u: -6, v: 60, s: 0.85, rim: C.cyan });
  for (const v of [20, 100, 180]) lotProps.push({ kind: 'lamp', u: -6, v, s: 1, rim: '' });
  for (const u of [40, 140, 240, 340]) lotProps.push({ kind: 'lamp', u, v: 216, s: 1, rim: '' });
  lotProps.push({ kind: 'bench', u: 60, v: -7, s: 1, rim: '', axis: 'u' }, { kind: 'bin', u: 82, v: -7, s: 1, rim: '' }, { kind: 'bench', u: 300, v: -7, s: 1, rim: '', axis: 'u' });
  lotProps.push({ kind: 'stop', u: 220, v: -7, s: 1, rim: C.cyan, axis: 'u' }, { kind: 'hydrant', u: 150, v: -4, s: 1, rim: '' });
  lotProps.push({ kind: 'planter', u: 364, v: 70, s: 1, rim: '' }, { kind: 'news', u: 364, v: 92, s: 1, rim: C.pink }, { kind: 'bench', u: 366, v: 128, s: 1, rim: '', axis: 'v' });
  for (const p of [...backProps, ...frontProps, ...lotProps]) if (p.kind === 'stop') { const g = G(p.u, p.v, 14); lights.push({ x: g[0], y: g[1], r: 40, c: p.rim, i: 0.5, sy: 0.6 }); }
  for (const p of [...backProps, ...frontProps, ...lotProps]) if (p.kind === 'lamp') { const g = G(p.u, p.v, 0); lights.push({ x: g[0] - 4, y: g[1], r: 80, c: '#FFB46B', i: 0.45, sy: 0.5 }, { x: g[0] - 7, y: g[1] - 50, r: 30, c: '#FFC88A', i: 0.5, sy: 1 }); }
  const byDepth = (a: { u: number; v: number; dv?: number }, b: { u: number; v: number; dv?: number }) => G(a.u, a.v + (a.dv ?? 0))[1] - G(b.u, b.v + (b.dv ?? 0))[1];
  back.sort(byDepth); front.sort(byDepth); backProps.sort(byDepth); frontProps.sort(byDepth); lotProps.sort(byDepth);
  MODEL = { back, front, backProps, frontProps, lotProps, lights };
  return MODEL;
}

/** Street furniture along a block's two street-facing sidewalks (the -v edge and the +u edge). */
function streetProps(out: Prop[], u0: number, v0: number, seed: number) {
  const kinds: Prop['kind'][] = ['bench', 'bin', 'hydrant', 'planter', 'news', 'bench'];
  for (const [k, pu] of [75, 125, 170, 220, 265, 320].entries()) {
    if (hash(seed, k) < 0.35) continue;
    const kind = kinds[(k + seed) % kinds.length]!;
    out.push({ kind, u: u0 + pu, v: v0 - (kind === 'hydrant' ? 3 : 7), s: 1, rim: NEON[(k + seed) % NEON.length], axis: 'u' });
  }
  if (hash(seed, 9) > 0.4) out.push({ kind: 'stop', u: u0 + 140, v: v0 - 7, s: 1, rim: NEON[seed % NEON.length], axis: 'u' });
  for (const [k, pv] of [20, 70, 110, 150, 190].entries()) {
    const kind: Prop['kind'] = k % 2 ? 'lamp' : hash(seed, k + 20) > 0.5 ? 'palm' : (['bench', 'planter', 'bin'] as const)[(k + seed) % 3]!;
    out.push({ kind, u: u0 + 366, v: v0 + pv, s: kind === 'palm' ? 0.55 + hash(seed, k) * 0.15 : 1, rim: NEON[(k + seed + 2) % NEON.length], axis: 'v' });
  }
}

/* ================================================================== far skyline */
interface Layer { seed: number; hmin: number; hmax: number; col: string; haze: string; win: number; detail: number }
const LAYERS: Layer[] = [
  { seed: 3, hmin: 150, hmax: 340, col: '#3E1A5E', haze: '#7A2A7A', win: 0.08, detail: 0 },
  { seed: 7, hmin: 100, hmax: 240, col: '#2C1048', haze: '#5E2070', win: 0.18, detail: 1 },
  { seed: 13, hmin: 56, hmax: 160, col: '#1E0A36', haze: '#4A1A62', win: 0.3, detail: 2 },
  { seed: 29, hmin: 18, hmax: 70, col: '#130726', haze: '#3A1452', win: 0.4, detail: 3 },
];
export function skylineLayer(px: Pix, L: Layer) {
  const base = HZ;
  let x = -1200, i = 0;
  while (x < 1700) {
    const w = (L.detail === 3 ? 34 : 24) + Math.floor(hash(L.seed, i) * (L.detail === 0 ? 70 : 56));
    const h = L.hmin + Math.floor(Math.pow(hash(i, L.seed), 1.4) * (L.hmax - L.hmin));
    farBuilding(px, x, w, h, base, L, i);
    x += w + (hash(i, L.seed + 3) > 0.7 ? 3 + Math.floor(hash(i, 9) * 10) : 0); i++;
  }
  // palms on the far shore between low buildings
  if (L.detail === 3) for (let k = 0; k < 18; k++) { const px0 = -1100 + hash(k, 41) * 2700; farPalm(px, px0, base, 0.35 + hash(k, 42) * 0.2); }
  // haze rising from the waterline: depth separation between layers
  px.dither([[-1300, base - 30], [1800, base - 30], [1800, base], [-1300, base]], L.haze, 0.25, 0.4);
  px.dither([[-1300, base - 14], [1800, base - 14], [1800, base], [-1300, base]], L.haze, 0.5, 0.4);
}
function farBuilding(px: Pix, x: number, w: number, h: number, base: number, L: Layer, i: number) {
  const col = L.col, sd = hash(i * 13, L.seed);
  const style = sd < 0.3 ? 'deco' : sd < 0.55 ? 'glass' : sd < 0.75 ? 'slab' : sd < 0.88 ? 'spire' : 'block';
  const top = base - h;
  const side = Math.max(2, Math.floor(w * 0.22)), rimLeft = x + w / 2 > 190; // rim light on the edge facing the sun
  px.rect(x, top, w, h + 1, col);
  if (L.detail >= 1) px.rect(rimLeft ? x : x + w - side, top, side, h + 1, shade(col, -0.25));
  if (L.detail >= 1) px.rect(rimLeft ? x + side : x + w - side - 1, top, 1, h, shade(col, 0.22), 0.25);
  // crowns
  let crownTop = top;
  if (style === 'deco') {
    let cw = w * 0.7, ch = 10 + Math.floor(sd * 14), cy = top;
    for (let k = 0; k < 3 && cw > 6; k++) { px.rect(x + (w - cw) / 2, cy - ch, cw, ch + 1, col); if (L.detail >= 2) px.rect(x + (w - cw) / 2, cy - ch, cw, 1, shade(col, 0.25), 0.3); cy -= ch; cw *= 0.62; ch *= 0.75; }
    px.rect(x + w / 2, cy - 18, 1, 18, col); crownTop = cy - 18;
    if (L.detail >= 1) for (let k = 0; k < 3; k++) px.rect(x + 3 + k * ((w - 6) / 3), top + 4, 1, Math.min(60, h - 8), shade(col, 0.12));
  } else if (style === 'spire') {
    px.rect(x + w * 0.3, top - 16, w * 0.4, 16, col); px.rect(x + w / 2 - 1, top - 50, 2, 34, col); crownTop = top - 50;
  } else if (style === 'glass') {
    for (let k = 2; k < w - 1; k += 4) px.rect(x + k, top + 2, 1, h - 4, shade(col, 0.1), L.detail >= 1 ? 0.15 : 0);
    if (L.detail >= 2) px.rect(x, top, w, 1, C.cyan, 0.8);
  } else if (style === 'slab') {
    for (let y = top + 6; y < base - 4; y += 6) px.rect(x, y, w, 1, shade(col, 0.1));
  }
  // windows
  const lit = L.win * (0.5 + sd);
  const ww = L.detail >= 2 ? 2 : 1;
  for (let wy = top + 5; wy < base - 4; wy += L.detail >= 2 ? 6 : 5) for (let wx = x + 2; wx < x + w - 2; wx += L.detail >= 2 ? 4 : 3) {
    const hv = hash(wx * 7 + L.seed, wy * 3);
    if (hv < lit) px.rect(wx, wy, ww, 2, hv < lit * 0.25 ? '#7FE9F5' : hv < lit * 0.4 ? '#FF9AC8' : '#FFC77A', L.detail === 0 ? 0.5 : 0.95);
  }
  // rooftop details
  if (L.detail >= 2 && style === 'block' && w > 30) {
    // billboard with a pixel ad
    const bw = Math.min(46, w - 6), bx = x + (w - bw) / 2, by = top - 22;
    px.rect(bx + 4, by + 16, 1, 6, col); px.rect(bx + bw - 5, by + 16, 1, 6, col);
    px.rect(bx, by, bw, 16, '#0E0820');
    const ad = Math.floor(sd * 4);
    const ads = [['#FF3EA5', '#FFC75A'], ['#2EE6F0', '#9B5CFF'], ['#7CF5B4', '#2EB8F0'], ['#FF7A6B', '#FFD36B']][ad];
    px.rect(bx + 1, by + 1, bw - 2, 7, ads[0], 0.8); px.rect(bx + 1, by + 8, bw - 2, 7, ads[1], 0.8);
    const word = ['NEAR', 'SODA', 'VICE', 'AI'][ad];
    px.text(word, (a, b) => [bx + (bw - textWidth(word, 1)) / 2 + a, by + 5 + b], 1, '#FFFFFF', 1);
    crownTop = by;
  }
  if (L.detail >= 1 && hash(i, L.seed + 5) > 0.55) { px.rect(x + w * 0.7, crownTop - 14, 1, 14, col); px.rect(x + w * 0.7 - 1, crownTop - 15, 3, 2, '#FF5C7A', 1); }
  if (L.detail >= 2 && hash(i, L.seed + 6) > 0.6) { const n = NEON[Math.floor(hash(i, 8) * NEON.length)]; px.rect(x, top, w, 1, n, 1); px.rect(x, top, 1, Math.min(h, 30), n, 0.9); }
  if (L.detail === 3 && w > 30 && hash(i, 31) > 0.4) {
    // low shore hotels: vertical neon blade sign
    const word = WORDS[Math.floor(hash(i, 33) * WORDS.length)].slice(0, Math.max(2, Math.floor((h - 6) / 6)));
    const n = NEON[Math.floor(hash(i, 34) * NEON.length)];
    const sx = x + 3, sy = top + 3;
    px.rect(sx - 1, sy - 1, 5, word.length * 6 + 1, '#0B0616');
    for (let k = 0; k < word.length; k++) px.text(word[k], (a, b) => [sx + a, sy + k * 6 + b], 1, n, 1);
  }
}
function farPalm(px: Pix, x: number, base: number, s: number) {
  const H = 90 * s;
  for (let k = 0; k < 10; k++) px.rect(x + (k / 10) * (k / 10) * 10 * s, base - (k + 1) * (H / 10), 2, H / 10 + 1, '#0E0620');
  const cx = x + 10 * s, cy = base - H;
  for (const [dx, dy] of [[-1, 0.3], [-0.7, -0.5], [0, -0.9], [0.7, -0.5], [1, 0.3]] as Pt[]) px.line([cx, cy], [cx + dx * 30 * s, cy + dy * 14 * s + 10 * s], '#0E0620', 2);
}

/** Suspension bridge across the bay on the horizon, with lit cables. */
function bridge(px: Pix) {
  const x0 = -820, x1 = -250, deck = HZ - 10, col = '#24103E';
  px.rect(x0 - 40, deck, x1 - x0 + 80, 3, col); px.rect(x0 - 40, deck + 3, x1 - x0 + 80, 1, '#3A1A5E');
  for (const tx of [x0 + 120, x1 - 120]) { px.rect(tx - 3, deck - 70, 2, 74, col); px.rect(tx + 2, deck - 70, 2, 74, col); for (const y of [deck - 66, deck - 40, deck - 16]) px.rect(tx - 3, y, 7, 2, col); px.rect(tx - 1, deck - 73, 2, 2, '#FF5C7A', 1); }
  const cable = (a: number, b: number, sag: number) => { for (let x = a; x < b; x += 2) { const f = (x - a) / (b - a), y = deck - 68 + sag * 4 * f * (1 - f); px.rect(x, y, 2, 1, '#B89AFF', 0.9); if (Math.round(x) % 12 === 0) px.rect(x, y, 1, deck - y, '#3A2060', 0.2); } };
  cable(x0 + 120, x1 - 120, 50);
  const half = (a: number, b: number, up: boolean) => { for (let x = a; x < b; x += 2) { const f = (x - a) / (b - a), y = up ? deck - 4 - f * f * 64 : deck - 68 + (f * f) * 0 + f * 64 * f; px.rect(x, up ? y : deck - 68 + Math.pow(f, 2) * 64, 2, 1, '#B89AFF', 0.9); } };
  half(x0 - 40, x0 + 120, true); half(x1 - 120, x1 + 40, false);
  for (let x = x0 - 40; x < x1 + 40; x += 6) px.rect(x, deck - 1, 2, 1, x % 12 ? '#FFC77A' : '#FF6AB8', 1);
}

/* ================================================================== sky life */
export function skyLife(px: Pix, L: Lights, t: number, openA: number, bk: Bakery) {
  // searchlights sweeping from behind the skyline
  for (const [x0, ph] of [[-420, 0], [720, 2.1], [260, 4.2]] as Pt[]) {
    const a = -Math.PI / 2 + Math.sin(t * 0.32 + ph) * 0.42, len = 1100;
    const ex = x0 + Math.cos(a) * len, ey = HZ - 40 + Math.sin(a) * len, nx = -Math.sin(a) * 46, ny = Math.cos(a) * 46;
    px.glow([[x0 - 3, HZ - 40], [x0 + 3, HZ - 40], [ex + nx, ey + ny], [ex - nx, ey - ny]], '#D8C0FF', 0.26 * (1 - openA * 0.7), 0, [x0, HZ - 40], [ex, ey], 0.5);
  }
  // blimp with a scrolling neon screen
  const bxp = -760 + ((t * 7) % 2000), byp = -600 + Math.sin(t * 0.4) * 5;
  const msg = Math.floor(t / 4) % 2;
  bk.draw(px, bk.get('blimp' + msg, (q) => blimp(q, msg)), Math.round(bxp), Math.round(byp));
  if (Math.floor(t * 2) % 2) px.rect(bxp + 36, byp + 14, 2, 2, '#FF5C7A', 1);
  // airliner blinking across, high up
  const ax = -900 + ((t * 22) % 2600), ay = -980 + ((t * 22) % 2600) * 0.05;
  px.rect(ax, ay, 7, 1, '#2A1A4A'); px.rect(ax + 2, ay - 1, 2, 3, '#2A1A4A');
  if (Math.floor(t * 3) % 3 === 0) px.rect(ax + 7, ay, 2, 1, '#FFFFFF', 1);
  if (Math.floor(t * 1.5) % 2) px.rect(ax - 1, ay, 1, 1, '#FF5C7A', 1);
  // seagulls gliding past the sun
  for (let k = 0; k < 6; k++) {
    const bx = -300 + ((t * (9 + k) + k * 140) % 900), by = -250 - k * 18 + Math.sin(t * 0.8 + k) * 8, f = Math.floor(t * 4 + k) % 3 === 0 ? -2 : 0;
    px.line([bx - 4, by + f], [bx, by + 1], '#140820', 1); px.line([bx, by + 1], [bx + 4, by + f], '#140820', 1);
  }
  void L;
}
function blimp(px: Pix, msg: number) {
  px.ellipse(40, 10, 40, 11, '#3A2E5E'); px.ellipse(38, 7, 34, 6, '#4E4278'); px.ellipse(30, 4, 18, 2, '#6A5E98');
  px.poly([[-2, 4], [8, 8], [8, 12], [-2, 16]], '#2A2048'); px.poly([[0, 10], [10, 10], [10, 11], [0, 11]], '#1E1838');
  px.rect(30, 20, 18, 5, '#1E1838'); for (let k = 0; k < 4; k++) px.rect(32 + k * 4, 22, 2, 1, '#FFC77A', 1);
  px.rect(18, 7, 44, 9, '#0B0616');
  const word = ['VIBE CITY', 'NEAR AI'][msg];
  px.text(word, (a, b) => [18 + (44 - textWidth(word, 1)) / 2 + a, 9 + b], 1, msg === 1 ? C.cyan : C.pink, 1);
}
/** Puffy pixel clouds lit from below by the sun. */
export function clouds(px: Pix, t: number, openA: number, bk: Bakery) {
  for (let i = 0; i < 9; i++) {
    const y = -470 + hash(i, 8) * 330, x = -800 + ((hash(i, 7) * 2200 + t * (2 + i * 0.6)) % 2300);
    const kind = i % 4;
    px.push(0.9 * (1 - openA * 0.6));
    bk.draw(px, bk.get('cloud' + kind, (q) => cloud(q, kind)), Math.round(x), Math.round(y));
    px.pop();
  }
}
function cloud(px: Pix, k: number) {
  const n = 5 + k * 2, lit = k % 2 ? '#FF8FB8' : '#FFB078';
  const parts: [number, number, number, number][] = [];
  for (let i = 0; i < n; i++) parts.push([i * (14 + k * 2) + hash(k, i) * 8, -hash(i, k) * (6 + k * 2), 10 + hash(i + k, 3) * (10 + k * 2), 4 + hash(i, k + 5) * (3 + k)]);
  for (const [x, y, rx, ry] of parts) px.ellipse(x, y + 2, rx, ry, lit, 0.8);
  for (const [x, y, rx, ry] of parts) px.ellipse(x, y, rx, ry, '#4A1E6A', 0.7);
  for (const [x, y, rx, ry] of parts) px.ellipse(x - 2, y - 2, rx * 0.6, ry * 0.5, '#5E2A7E', 0.7);
}

/* ================================================================== bay */
/** Inverse ground projection: is screen point (x, y) over the bay (left of u = -64 or behind v = 274)? */
const isSea = (x: number, y: number) => { const u = (x + 2 * y - 7) / 2, v = (x - 2 * y + 197) / 2; return u < -66 || v > 276; };
export function bay(px: Pix, L: Lights, t: number, bk: Bakery) {
  const bands = ['#5A1E6A', '#44185E', '#341352', '#281046', '#1E0C3A', '#160930', '#100626'];
  let y0 = HZ;
  for (let i = 0; i < bands.length; i++) {
    const y1 = HZ + 4 + i * i * 7;
    px.rect(-2600, y0, 6000, y1 - y0 + (i === bands.length - 1 ? 2000 : 1), bands[i], 0.55);
    if (i + 1 < bands.length) px.dither([[-2600, y1 - 3], [3400, y1 - 3], [3400, y1 + 1], [-2600, y1 + 1]], bands[i + 1], 0.5, 0.55);
    y0 = y1;
  }
  // mirrored skyline, rippling
  px.reflect(bk.get('sky2', (q) => skylineLayer(q, LAYERS[2])), HZ, 110, 0.16, t);
  px.reflect(bk.get('sky3', (q) => skylineLayer(q, LAYERS[3])), HZ, 80, 0.26, t);
  // glassy sheen near the horizon + water scanlines breaking up the reflections
  px.glow([[-2600, HZ], [3400, HZ], [3400, HZ + 60], [-2600, HZ + 60]], '#FF6AA8', 0.22, 0, [0, HZ], [0, HZ + 60], 0.4);
  px.push(0.45); for (let y = HZ + 3, k = 0; y < 420; y += 3 + Math.floor(k / 3), k++) px.rect(-2600, y, 6000, 1, '#120830', 0.3); px.pop();
  // shimmering light columns: the far shore's neon smeared down the water
  for (let i = 0; i < 44; i++) {
    const x0 = -900 + hash(i, 61) * 2400, col = ['#FFC77A', '#7FE9F5', '#FF6AB8', '#FFC77A', '#B89AFF'][i % 5], n = 6 + Math.floor(hash(i, 62) * 10);
    for (let k = 0; k < n; k++) {
      const y = HZ + 2 + k * 3, x = x0 + Math.sin(t * 2.6 + k * 1.3 + i) * (1 + k * 0.25), w = 1 + ((k + i) % 3 === 0 ? 2 : 1);
      if (!isSea(x, y)) continue;
      if ((Math.floor(t * 6) + k + i) % 4 === 0) continue;
      px.push(1 - k / n); px.rect(x, y, w, 1, col, 1); px.pop();
    }
  }
  // ripples: denser and shorter toward the horizon
  for (let i = 0; i < 300; i++) {
    const d = Math.pow(hash(i, 51), 1.8), y = HZ + 2 + d * 340;
    const x = -1200 + hash(i, 52) * 1500 + Math.sin(t * 0.8 + i) * (2 + d * 6);
    if (!isSea(x, y) || !isSea(x + 20, y)) continue;
    const len = 3 + d * 18, br = hash(i, 53) > 0.7;
    px.push(0.55 + 0.45 * Math.sin(t * 1.7 + i * 2.3)); px.rect(x, y, len, 1, br ? (d < 0.2 ? '#FFB0D8' : '#FF8FC8') : '#7A4AAE', br ? 0.9 : 0.55); px.pop();
  }
  // boats: a lit yacht far out and a speedboat cutting a wake
  const yx = -900 + ((t * 3) % 1900), yy = HZ + 14;
  if (isSea(yx, yy) && isSea(yx + 30, yy)) {
    px.poly([[yx, yy], [yx + 30, yy], [yx + 26, yy + 4], [yx + 3, yy + 4]], '#E4DEF8'); px.rect(yx + 6, yy - 5, 16, 5, '#C9C3EA');
    for (let k = 0; k < 4; k++) px.rect(yx + 8 + k * 4, yy - 3, 2, 1, '#FFC77A', 1);
    px.rect(yx + 14, yy - 16, 1, 11, '#C9C3EA'); px.rect(yx + 14, yy - 17, 1, 1, '#FF5C7A', 1);
    px.push(0.3); px.rect(yx, yy + 5, 30, 1, '#FFC77A', 0.6); px.rect(yx + 4, yy + 8, 22, 1, '#FFC77A', 0.5); px.pop();
    L.add(yx + 14, yy, 40, '#FFC77A', 0.4, 0.5);
  }
  // party yacht cruising the near bay with string lights
  const px0 = 1100 - ((t * 9) % 1500), py0 = 40 + Math.sin(t * 0.6) * 2;
  if (isSea(px0 - 6, py0 + 2) && isSea(px0 + 52, py0 + 2)) {
    px.dither([[px0 + 48, py0 + 5], [px0 + 110, py0 + 3], [px0 + 110, py0 + 6], [px0 + 48, py0 + 8]], '#E8E0FF', 0.25, 0.5);
    px.poly([[px0 - 6, py0 - 2], [px0 + 50, py0 - 2], [px0 + 46, py0 + 6], [px0, py0 + 6]], '#F4EEFF'); px.rect(px0 - 2, py0 + 2, 50, 1, C.cyan, 0.8);
    px.rect(px0 + 6, py0 - 9, 34, 7, '#E4DEF8'); px.rect(px0 + 14, py0 - 14, 18, 5, '#D8D2F4');
    for (let k = 0; k < 7; k++) px.rect(px0 + 8 + k * 4.5, py0 - 7, 3, 2, k % 2 ? '#2A3A5A' : '#FFC77A', k % 2 ? 0.2 : 1);
    for (let k = 0; k < 12; k++) { const x = px0 - 4 + k * 4.5, y = py0 - 16 + Math.abs(k - 6) * 1.2; if ((Math.floor(t * 4) + k) % 3) px.rect(x, y, 1, 1, [C.pink, C.cyan, C.gold][k % 3], 1); }
    px.rect(px0 + 22, py0 - 26, 1, 12, '#C9C3EA');
    L.add(px0 + 22, py0, 70, '#FF6AB8', 0.45, 0.5);
    px.push(0.35); for (let k = 0; k < 5; k++) px.rect(px0 + Math.sin(t * 3 + k) * 2, py0 + 8 + k * 3, 46, 1, k % 2 ? '#FF6AB8' : '#FFC77A', 0.8); px.pop();
  }
  const sx = -400 + ((t * 26) % 1600), sy = HZ + 40 + Math.sin(t * 0.5) * 4;
  if (isSea(sx, sy) && isSea(sx + 24, sy)) {
    px.dither([[sx - 70, sy + 2], [sx, sy + 1], [sx, sy + 4], [sx - 70, sy + 6]], '#E8E0FF', 0.3, 0.6);
    px.poly([[sx, sy], [sx + 22, sy - 1], [sx + 18, sy + 4], [sx + 2, sy + 4]], C.pink); px.rect(sx + 6, sy - 3, 8, 3, '#2A2048');
    px.rect(sx + 21, sy, 2, 1, '#FFFFFF', 1);
    L.add(sx + 26, sy, 34, '#FFFFFF', 0.4, 0.5);
  }
}

/* ================================================================== ground (baked) */
export function ground(px: Pix) {
  const c = gc(px);
  // land: everything right of the seawall
  px.poly(clipY([G(-70, -1400), G(-70, 280), G(2400, 280), G(2400, -1400)], HZ + 1), '#1E1636');
  // seawalls + promenades on both shores
  px.poly(clipY([G(-70, -1400, 0), G(-70, 280, 0), G(-70, 280, -8), G(-70, -1400, -8)], HZ + 1), '#2A2250');
  px.poly(quad(-70, -1400, -64, 280, 0), '#4A4078'); px.poly(quad(-64, -1400, -52, 274), '#3A3062');
  px.poly(quad(-70, 274, 2400, 280, 0), '#4A4078'); px.poly(quad(-52, 262, 2400, 274), '#3A3062');
  for (let v = -1400; v < 274; v += 12) px.line(G(-64, v), G(-52, v), '#463C72');
  for (let u = -52; u < 2400; u += 12) px.line(G(u, 262), G(u, 274), '#463C72');
  for (let v = -1400; v < 280; v += 8) { const a = G(-70, v, 0), b = G(-70, v, 5); if (a[1] > HZ + 6) px.line(a, b, '#8C84B8'); }
  for (let u = -70; u < 2400; u += 8) { const a = G(u, 280, 0), b = G(u, 280, 5); if (a[1] > HZ + 6) px.line(a, b, '#8C84B8'); }
  px.line(G(-70, -1400, 5), G(-70, 280, 5), '#B8B0E0'); px.line(G(-70, 280, 5), G(2400, 280, 5), '#B8B0E0');
  // street grid: roads every 424 (u) and 274 (v), sidewalks 12 wide. Block bases first, then the streets over
  // them (paved sidewalks, asphalt, markings), then what is inside each block.
  const ROADS_U = [-52, 372, 796, 1220], ROADS_V = [-600, -326, -52, 222];
  const blocks: { u0: number; v0: number; kind: string }[] = [];
  for (let i = 0; i <= 3; i++) for (let j = -2; j <= 0; j++) {
    if (i === 0 && j === 0) continue;
    const u0 = i * BU, v0 = j * BV;
    blocks.push({ u0, v0, kind: i === 0 && j === -1 ? 'park' : i === 1 && j === -1 ? 'parking' : i === 0 && j === -2 ? 'court' : 'lot' });
    px.poly(quad(u0 - 12, v0 - 12, u0 + 372, v0 + 222), '#3A3062');
  }
  for (const ru of ROADS_U) sidewalks(px, true, ru, ROADS_V);
  for (const rv of ROADS_V) sidewalks(px, false, rv, ROADS_U);
  for (const ru of ROADS_U) asphalt(px, true, ru);
  for (const rv of ROADS_V) asphalt(px, false, rv);
  for (const ru of ROADS_U) markings(px, true, ru, ROADS_V);
  for (const rv of ROADS_V) markings(px, false, rv, ROADS_U);
  // zebra crossings and stop bars at every intersection
  for (const ru of ROADS_U) for (const rv of ROADS_V) {
    for (let k = 0; k < 7; k++) {
      px.poly(quad(ru + 3 + k * 5.4, rv - 10, ru + 6 + k * 5.4, rv - 2), '#C8C0EC', 0.06); px.poly(quad(ru + 3 + k * 5.4, rv + 42, ru + 6 + k * 5.4, rv + 50), '#C8C0EC', 0.06);
      px.poly(quad(ru - 10, rv + 3 + k * 5.4, ru - 2, rv + 6 + k * 5.4), '#C8C0EC', 0.06); px.poly(quad(ru + 42, rv + 3 + k * 5.4, ru + 50, rv + 6 + k * 5.4), '#C8C0EC', 0.06);
    }
    px.poly(quad(ru + 20, rv - 14, ru + 39, rv - 12.5), '#E8E0FF'); px.poly(quad(ru + 1, rv + 52.5, ru + 20, rv + 54), '#E8E0FF');
    px.poly(quad(ru - 14, rv + 1, ru - 12.5, rv + 20), '#E8E0FF'); px.poly(quad(ru + 52.5, rv + 20, ru + 54, rv + 39), '#E8E0FF');
  }
  for (const b of blocks) {
    const { u0, v0 } = b;
    px.line(G(u0 - 12, v0 - 12), G(u0 + 372, v0 - 12), '#6A62A0'); px.line(G(u0 + 372, v0 - 12), G(u0 + 372, v0 + 222), '#554C8A');
    if (b.kind === 'park') park(c, u0, v0);
    else if (b.kind === 'parking') parking(c, u0, v0);
    else if (b.kind === 'court') court(c, u0, v0);
    else courtyard(px, u0, v0);
  }
  plaza(px);
  marina(c, 'v', 280, [60, 150, 250, 340, 460, 560, 680, 800]);
  marina(c, 'u', -70, [-80, -170, -260, -350, -440]);
}
/** Wooden piers sticking out from the seawall with moored boats. */
function marina(c: IC, side: 'u' | 'v', at: number, spots: number[]) {
  const { px } = c;
  for (const [i, a] of spots.entries()) {
    const len = 46 + hash(i, a) * 20;
    const q: Pt[] = side === 'v' ? clipY([G(a, at, 1), G(a + 6, at, 1), G(a + 6, at + len, 1), G(a, at + len, 1)], HZ + 2) : clipY([G(at, a, 1), G(at, a + 6, 1), G(at - len, a + 6, 1), G(at - len, a, 1)], HZ + 2);
    if (q.length < 3) continue;
    px.poly(q, '#7A5A48');
    for (let k = 0; k < len; k += 5) { const e = side === 'v' ? [G(a, at + k, 1), G(a + 6, at + k, 1)] : [G(at - k, a, 1), G(at - k, a + 6, 1)]; if (e[0][1] > HZ + 2) px.line(e[0], e[1], '#5A3E30'); }
    for (let k = 10; k < len; k += 14) {
      const pp = side === 'v' ? G(a, at + k, 0) : G(at - k, a, 0); if (pp[1] < HZ + 4) continue;
      px.rect(pp[0], pp[1] - 4, 1, 5, '#3A2620');
      // boat on alternating sides
      if (hash(i * 9 + k, 5) > 0.45) {
        const bu = side === 'v' ? a + (k % 28 ? -9 : 15) : at - k, bv = side === 'v' ? at + k : a + (k % 28 ? -9 : 15);
        const col = ['#F4EEFF', '#E4DEF8', '#FFB0D0', '#9FE8FF'][Math.floor(hash(k, i) * 4)];
        const [du, dv] = side === 'v' ? [6, 14] : [14, 6];
        if (G(bu, bv + dv)[1] < HZ + 4) continue;
        px.shadeEllipse(...G(bu + du / 2, bv + dv / 2, 0), 9, 4, 0.35);
        box(c, bu, bv, 0, du, dv, 3, col, { top: '#C9A880' });
        box(c, bu + du * 0.25, bv + dv * 0.3, 3, du * 0.5, dv * 0.4, 2, '#2A3A5A', { top: col });
        if (hash(k, i + 3) > 0.5) { const m = G(bu + du / 2, bv + dv / 2, 5); px.line(m, [m[0], m[1] - 14], '#C9C3EA'); }
        const lp = G(bu + du / 2, bv + dv / 2, 6); px.dot(Math.floor(lp[0]), Math.floor(lp[1]), '#FFC77A', 1);
      }
    }
  }
}
/** The stretches of a road between the roads that cross it (cut out where the crossing's asphalt is, widened by pad). */
function stretches(b0: number, b1: number, cross: readonly number[], pad: number): [number, number][] {
  const out: [number, number][] = []; let a = b0;
  for (const c of [...cross].sort((x, y) => x - y)) { if (c + 40 + pad <= a || c - pad >= b1) continue; if (c - pad > a) out.push([a, c - pad]); a = Math.max(a, c + 40 + pad); }
  if (a < b1) out.push([a, b1]);
  return out;
}
const roadSpan = (alongV: boolean): [number, number] => (alongV ? [-1400, 262] : [-52, 2400]);
const along = (alongV: boolean) => (a: number, b: number): Pt => (alongV ? G(a, b) : G(b, a));
const strip = (alongV: boolean, a0: number, a1: number, b0: number, b1: number) => (alongV ? quad(a0, b0, a1, b1) : quad(b0, a0, b1, a1));
/** Paved sidewalks either side of a road: square slabs, a few darker ones, and a bright curb lip with a gutter. */
function sidewalks(px: Pix, alongV: boolean, at: number, cross: readonly number[]) {
  const [b0, b1] = roadSpan(alongV), L2 = along(alongV);
  for (const [s0, s1] of stretches(b0, b1, cross, 0)) for (const [a0, a1] of [[at - 12, at], [at + 40, at + 52]] as Pt[]) {
    px.poly(strip(alongV, a0, a1, s0, s1), '#3C3266');
    for (let b = Math.ceil(s0 / 6) * 6; b < s1 - 6; b += 6) {
      const k = hash(b, at + a0);
      if (k > 0.86) px.poly(strip(alongV, a0 + 0.5, a1 - 0.5, b + 0.5, b + 5.5), k > 0.95 ? '#463C74' : '#342A5C');
      px.line(L2(a0, b), L2(a1, b), '#30285A');
    }
    px.line(L2((a0 + a1) / 2, s0), L2((a0 + a1) / 2, s1), '#30285A');
    const lip = a0 < at ? at - 1.5 : at + 40;
    px.poly(strip(alongV, lip, lip + 1.5, s0, s1), '#7A72B0');
  }
}
/** The roadway itself: dark asphalt with grit, patched seams, manholes and the city's neon smeared on the wet surface. */
function asphalt(px: Pix, alongV: boolean, at: number) {
  const [b0, b1] = roadSpan(alongV), L2 = along(alongV);
  px.poly(strip(alongV, at, at + 40, b0, b1), '#18122C');
  for (let b = b0; b < b1; b += 4) for (let k = 0; k < 3; k++) {
    const h = hash(b * 3 + k, at);
    if (h < 0.5) continue;
    const p = L2(at + 1 + hash(b, k + at) * 38, b + hash(k, b) * 4);
    px.dot(Math.floor(p[0]), Math.floor(p[1]), h > 0.85 ? '#251D42' : '#100B20');
  }
  for (let b = b0; b < b1; b += 90) { const k = hash(b, at + 3); if (k > 0.55) px.poly(strip(alongV, at + 2 + k * 14, at + 14 + k * 14, b, b + 10 + k * 12), '#1D1634'); }
  px.line(L2(at + 0.5, b0), L2(at + 0.5, b1), '#0E0A1C'); px.line(L2(at + 39.5, b0), L2(at + 39.5, b1), '#0E0A1C');
  for (let b = b0 + 50; b < b1; b += 140) {
    const p = L2(at + (hash(b, at) > 0.5 ? 30 : 10), b);
    px.ellipse(p[0], p[1], 4, 2, '#0C0818'); px.ellipse(p[0], p[1] - 0.5, 3, 1.4, '#2E2650'); px.line([p[0] - 2, p[1] - 0.5], [p[0] + 2, p[1] - 0.5], '#1A1430');
  }
  for (let b = b0; b < b1; b += 6) {
    const h = hash(b, at * 2 + 1);
    if (h < 0.8) continue;
    const a = at + 4 + hash(at, b) * 32, col = h > 0.93 ? '#FF5FB0' : h > 0.87 ? '#4FD8E8' : '#FFC77A';
    px.line(L2(a, b), L2(a + 0.5, b + 3 + h * 8), col, 1, 0.2);
  }
}
/** Lane markings, kept off the intersections: white edge lines, a double yellow centre, arrows before each crossing. */
function markings(px: Pix, alongV: boolean, at: number, cross: readonly number[]) {
  const [b0, b1] = roadSpan(alongV), L2 = along(alongV);
  for (const [s0, s1] of stretches(b0, b1, cross, 16)) {
    px.line(L2(at + 3, s0), L2(at + 3, s1), '#A8A0D4', 1, 0.12); px.line(L2(at + 37, s0), L2(at + 37, s1), '#A8A0D4', 1, 0.12);
    px.line(L2(at + 19.3, s0), L2(at + 19.3, s1), '#E8B850', 1, 0.3); px.line(L2(at + 20.7, s0), L2(at + 20.7, s1), '#E8B850', 1, 0.3);
    for (const [lane, end, dir] of [[at + 11, s1, -1], [at + 29, s0, 1]] as [number, number, number][]) {
      if (end === b0 || end === b1) continue;
      const tip = end + dir * 6, tail = end + dir * 16;
      px.line(L2(lane, tip), L2(lane, tail), '#E8E0FF', 1, 0.1);
      px.line(L2(lane, tip), L2(lane - 2.5, tip + dir * 4), '#E8E0FF', 1, 0.1); px.line(L2(lane, tip), L2(lane + 2.5, tip + dir * 4), '#E8E0FF', 1, 0.1);
    }
  }
}
/** A block's inner courtyard, between the buildings: pavers, a few planted squares. */
function courtyard(px: Pix, u0: number, v0: number) {
  px.poly(quad(u0, v0, u0 + 360, v0 + 210), '#2A2248');
  for (let a = 15; a < 360; a += 15) px.line(G(u0 + a, v0), G(u0 + a, v0 + 210), '#302852');
  for (let b = 15; b < 210; b += 15) px.line(G(u0, v0 + b), G(u0 + 360, v0 + b), '#302852');
  for (let k = 0; k < 10; k++) {
    const a = 20 + Math.floor(hash(k, u0 + v0) * 22) * 15, b = 20 + Math.floor(hash(u0 - v0, k) * 12) * 15;
    px.poly(quad(u0 + a, v0 + b, u0 + a + 13, v0 + b + 13), '#1E4A3E');
    for (let n = 0; n < 4; n++) { const p = G(u0 + a + 2 + hash(k, n) * 9, v0 + b + 2 + hash(n, k) * 9); px.ellipse(p[0], p[1] - 2, 3, 2.4, n % 2 ? '#2E7A4E' : '#1E5A3A'); }
  }
}
/** Neon-lit sports block: two basketball courts and a skate bowl behind a glowing fence. */
function court(c: IC, u0: number, v0: number) {
  const { px } = c;
  px.poly(quad(u0, v0, u0 + 360, v0 + 210), '#24304E');
  for (const [cu, col, key] of [[12, '#2B4C8C', '#C8503A'], [96, '#3A2B7A', '#2EB8A0']] as [number, string, string][]) {
    const a = u0 + cu, b0 = v0 + 14, b1 = v0 + 196;
    px.poly(quad(a, b0, a + 72, b1), col);
    px.poly(quad(a + 22, b0, a + 50, b0 + 34), key); px.poly(quad(a + 22, b1 - 34, a + 50, b1), key);
    for (const [p, q] of [[[a + 3, b0 + 3], [a + 69, b0 + 3]], [[a + 69, b0 + 3], [a + 69, b1 - 3]], [[a + 69, b1 - 3], [a + 3, b1 - 3]], [[a + 3, b1 - 3], [a + 3, b0 + 3]], [[a + 3, (b0 + b1) / 2], [a + 69, (b0 + b1) / 2]]] as [Pt, Pt][]) px.line(G(...p), G(...q), '#F4EEFF', 1, 0.15);
    const mc = G(a + 36, (b0 + b1) / 2); px.ring(mc[0], mc[1], 12, 6, '#F4EEFF', 1, 0.15);
    for (const hv of [b0 + 4, b1 - 4]) {
      box(c, a + 35, hv, 0, 2, 2, 16, '#8C84B8');
      box(c, a + 30, hv + (hv < b0 + 10 ? 1 : -2), 16, 12, 1, 8, '#F4EEFF', { em: 0.2 });
      const r = G(a + 36, hv + (hv < b0 + 10 ? 4 : -4), 15); px.ring(r[0], r[1], 3, 1.5, '#FF7A3A', 1, 1);
    }
  }
  // skate bowl and a quarter pipe
  const bc = G(u0 + 270, v0 + 105);
  px.ellipse(bc[0], bc[1], 62, 31, '#5A6A9A'); px.ellipse(bc[0], bc[1] + 2, 56, 27, '#3A4672'); px.ellipse(bc[0], bc[1] + 5, 44, 20, '#2A3458'); px.ellipse(bc[0], bc[1] + 7, 26, 11, '#222A48');
  px.ring(bc[0], bc[1], 62, 31, '#E8E0FF', 1, 0.3); px.ring(bc[0], bc[1], 61, 30, C.pink, 1, 0.6);
  box(c, u0 + 196, v0 + 160, 0, 40, 28, 4, '#6A7AAA', { top: '#8A9ACA' }); box(c, u0 + 196, v0 + 176, 4, 40, 12, 8, '#5A6A9A', { top: '#7A8ABA' });
  for (const [t, col] of [['SKATE', C.pink], ['HOOPS', C.cyan]] as [string, string][]) {
    const u1 = t === 'SKATE' ? u0 + 236 : u0 + 40;
    box(c, u1, v0 + 1, 0, textWidth(t, 2) + 6, 2, 14, '#0E0820', { edge: false });
    px.text(t, (a, bb) => G(u1 + 3 + a, v0 + 1, 11 - bb), 2, col, 1);
  }
  // chain-link fence with a neon top rail
  const fence = (p: Pt, q: Pt) => {
    const n = Math.max(2, Math.round(Math.hypot(q[0] - p[0], q[1] - p[1]) / 6));
    for (let k = 0; k <= n; k++) { const u = p[0] + ((q[0] - p[0]) * k) / n, v = p[1] + ((q[1] - p[1]) * k) / n; px.line(G(u, v, 0), G(u, v, 10), '#5A5490', 1); }
    px.dither([G(...p, 0), G(...q, 0), G(...q, 10), G(...p, 10)], '#8C84B8', 0.25);
    px.line(G(...p, 10), G(...q, 10), C.cyan, 1, 0.8);
  };
  fence([u0 + 2, v0 + 2], [u0 + 180, v0 + 2]); fence([u0 + 180, v0 + 2], [u0 + 180, v0 + 208]);
}
function park(c: IC, u0: number, v0: number) {
  const { px } = c;
  px.poly(quad(u0, v0, u0 + 360, v0 + 210), '#1E4A3E');
  for (let k = 0; k < 40; k++) { const p = G(u0 + hash(k, 3) * 360, v0 + hash(k, 4) * 210); px.dot(Math.floor(p[0]), Math.floor(p[1]), '#2E6A52'); }
  px.poly(quad(u0 + 170, v0, u0 + 190, v0 + 210), '#8A7AA8'); px.poly(quad(u0, v0 + 95, u0 + 360, v0 + 112), '#8A7AA8');
  // pool + deck + loungers + cabana
  px.poly(quad(u0 + 210, v0 + 128, u0 + 340, v0 + 200), '#E8DCC8');
  px.poly(quad(u0 + 220, v0 + 136, u0 + 330, v0 + 192), '#1FA8C8', 0.55);
  for (let k = 0; k < 6; k++) px.line(G(u0 + 226 + k * 17, v0 + 140), G(u0 + 236 + k * 17, v0 + 140), '#8FF0FF', 1, 0.7);
  for (let k = 0; k < 5; k++) box(c, u0 + 214 + k * 22, v0 + 122, 0, 12, 5, 2, k % 2 ? C.pink : '#F4EEFF', { edge: false });
  box(c, u0 + 40, v0 + 130, 0, 40, 30, 12, '#ECE4F6', { top: '#FF3EA5' });
  // fountain at the crossing of the paths
  const fc = G(u0 + 180, v0 + 103);
  px.ellipse(fc[0], fc[1], 22, 11, '#B8B0E0'); px.ellipse(fc[0], fc[1], 19, 9, '#1FA8C8', 0.5); px.ellipse(fc[0], fc[1] - 1, 8, 4, '#8FF0FF', 0.7);
  px.rect(fc[0] - 1, fc[1] - 12, 3, 12, '#D8D2F4', 0.4);
  // round trees + benches
  for (let k = 0; k < 9; k++) {
    const tu = u0 + 20 + hash(k, 71) * 140, tv = v0 + (k % 2 ? 10 + hash(k, 72) * 70 : 120 + hash(k, 73) * 80);
    if (tu > 150 && tu < 200) continue;
    const g = G(tu, tv); roundTree(px, g[0], g[1], 0.9 + hash(k, 74) * 0.4, k % 3 ? C.cyan : C.pink, k);
  }
  // hedges along the paths
  for (const [a, b, l] of [[0, 88, 160], [200, 88, 160], [0, 116, 160], [200, 116, 160]] as [number, number, number][]) for (let k = 0; k < l; k += 8) { const p = G(u0 + a + k + 4, v0 + b + 2); px.ellipse(p[0], p[1] - 3, 5, 3.5, '#1E5A3A'); px.ellipse(p[0] - 1, p[1] - 4.5, 3, 2, '#2E7A4E'); }
  for (const [bu, bv] of [[150, 60], [200, 150], [120, 120]] as Pt[]) box(c, u0 + bu, v0 + bv, 2, 10, 3, 2, '#8A5A40', { top: '#B07A58', edge: false });
  for (let k = 0; k < 5; k++) px.poly(quad(u0 + 40 + k * 8, v0 + 130, u0 + 44 + k * 8, v0 + 160, 12.2), '#F4EEFF');
}
function parking(c: IC, u0: number, v0: number) {
  const { px } = c;
  px.poly(quad(u0, v0, u0 + 360, v0 + 210), '#1A1430');
  for (let r = 0; r < 2; r++) for (let k = 0; k <= 16; k++) px.line(G(u0 + 10 + k * 21, v0 + 20 + r * 110), G(u0 + 10 + k * 21, v0 + 70 + r * 110), '#6A6298');
  for (let r = 0; r < 2; r++) for (let k = 0; k < 16; k++) if (hash(k, r + 7) > 0.35) carShape(c, u0 + 20 + k * 21, v0 + 45 + r * 110, 'v', PAINT[Math.floor(hash(k, r) * PAINT.length)]);
}
function plaza(px: Pix) {
  px.poly([G(0, 0), G(360, 0), G(360, 210), G(0, 210)], '#2A2048');
  for (let i = 0; i < 12; i++) for (let j = 0; j < 7; j++) if (hash(i, j) > 0.6) px.poly([G(i * 30, j * 30), G(i * 30 + 30, j * 30), G(i * 30 + 30, j * 30 + 30), G(i * 30, j * 30 + 30)], hash(j, i) > 0.5 ? '#2E2350' : '#261C42');
  for (let i = 1; i < 12; i++) px.line(G(i * 30, 0), G(i * 30, 210), '#352A5A');
  for (let i = 1; i < 7; i++) px.line(G(0, i * 30), G(360, i * 30), '#352A5A');
  for (const [u, v, r] of [[40, 20, 14], [320, 40, 18], [330, 190, 12]] as [number, number, number][]) { const p = G(u, v); px.ellipse(p[0], p[1], r, r * 0.4, '#3A2E66', 0.15); px.ellipse(p[0] - 2, p[1] - 1, r * 0.5, r * 0.15, '#5A4E90', 0.25); }
  px.line(G(0, 0), G(360, 0), '#FF3EA5', 2, 1); px.line(G(360, 0), G(360, 210), '#FF3EA5', 2, 1);
  px.line(G(0, 210), G(0, 0), '#FF3EA5', 1, 0.6);
}

/* ================================================================== buildings + props (baked) */
function building(c: IC, b: Bld) {
  const { px } = c, P = G;
  const { u, v, du, dv, h } = b;
  if (P(u, v + dv, 0)[1] < HZ + 2 && P(u + du, v, 0)[1] < HZ + 2) return;
  const wl = b.col, wr = shade(b.col, -0.3), roof = shade(b.col, -0.15);
  const step = b.tall ? 8 : 9;
  if (b.tall && h > 110) {
    // setback tower: base + upper shaft + crown
    const h1 = Math.floor(h * 0.62);
    body(c, u, v, du, dv, 0, h1, wl, wr, roof, b, step);
    body(c, u + du * 0.15, v + dv * 0.15, du * 0.7, dv * 0.7, h1, h - h1, shade(wl, 0.05), shade(wr, 0.05), roof, b, step);
    const cu = u + du * 0.35, cv = v + dv * 0.35;
    box(c, cu, cv, h, du * 0.3, dv * 0.3, 10, shade(wl, 0.1), { right: shade(wr, 0.1) });
    px.line(P(cu + du * 0.15, cv + dv * 0.15, h + 10), P(cu + du * 0.15, cv + dv * 0.15, h + 34), '#8C84B8');
    const tip = P(cu + du * 0.15, cv + dv * 0.15, h + 35); px.rect(tip[0] - 1, tip[1] - 1, 3, 2, '#FF5C7A', 1);
    px.line(P(cu, cv, h + 10), P(cu + du * 0.3, cv, h + 10), b.neon, 1, 1); px.line(P(cu + du * 0.3, cv, h + 10), P(cu + du * 0.3, cv + dv * 0.3, h + 10), b.neon, 1, 1);
  } else body(c, u, v, du, dv, 0, h, wl, wr, roof, b, step);
  // neon roof outline (Ocean Drive)
  const top = b.tall && h > 110 ? null : h;
  if (top !== null) {
    px.line(P(u, v, top), P(u + du, v, top), b.neon, 1, 1); px.line(P(u + du, v, top), P(u + du, v + dv, top), b.neon, 1, 0.9);
    px.line(P(u + du, v, 10), P(u + du, v, top), b.neon, 1, 0.8);
    // roof furniture
    if (b.pool) { px.poly([P(u + 10, v + 10, top), P(u + du - 14, v + 10, top), P(u + du - 14, v + dv - 12, top), P(u + 10, v + dv - 12, top)], '#1FA8C8', 0.5); px.line(P(u + 14, v + 14, top), P(u + 30, v + 14, top), '#8FF0FF', 1, 0.7); }
    else { box(c, u + du * 0.55, v + dv * 0.5, top, 10, 8, 6, '#8C84B8', { top: '#B8B0E0' }); box(c, u + 8, v + dv * 0.6, top, 7, 7, 10, '#6B4A3A', { top: '#8A6048' }); }
  }
  // vertical blade sign on the front corner
  if (b.sign) {
    const word = b.sign, n = word.length, sh = n * 7 + 4, base = Math.min(h - sh - 4, 16), su = u + du + 1, sv = v + 3;
    if (base > 4) {
      box(c, su, sv, base, 3, 6, sh, '#0E0820', { edge: false });
      for (let k = 0; k < n; k++) px.text(word[k], (a, bb) => P(su + 3, sv + 1.5 + a, base + sh - 3 - k * 7 - bb), 1, b.neon, 1);
      px.line(P(su + 3, sv, base), P(su + 3, sv, base + sh), b.neon, 1, 0.7); px.line(P(su + 3, sv + 6, base), P(su + 3, sv + 6, base + sh), b.neon, 1, 0.7);
    }
  }
  // big rooftop word on tall towers
  if (b.roof) {
    const word = b.roof, s = 3, w = textWidth(word, s), hh = h > 110 ? Math.floor(h * 0.62) : h;
    const u1 = u + Math.max(2, (du - w) / 2);
    px.text(word, (a, bb) => P(u1 + a, v + 4, hh + 18 - bb), s, b.neon, 1);
  }
}
function body(c: IC, u: number, v: number, du: number, dv: number, h0: number, h: number, wl: string, wr: string, roof: string, b: Bld, step: number) {
  const { px } = c, P = G;
  px.poly([P(u, v, h0), P(u + du, v, h0), P(u + du, v, h0 + h), P(u, v, h0 + h)], wl);
  px.poly([P(u + du, v, h0), P(u + du, v + dv, h0), P(u + du, v + dv, h0 + h), P(u + du, v, h0 + h)], wr);
  px.poly([P(u, v, h0 + h), P(u + du, v, h0 + h), P(u + du, v + dv, h0 + h), P(u, v + dv, h0 + h)], roof);
  px.line(P(u, v, h0 + h), P(u + du, v, h0 + h), shade(wl, 0.35)); px.line(P(u + du, v, h0 + h), P(u + du, v + dv, h0 + h), shade(roof, 0.25));
  px.line(P(u + du, v, h0), P(u + du, v, h0 + h), shade(wl, 0.15));
  const ground = h0 === 0;
  if (ground && !b.tall) {
    // lit storefronts + striped awnings
    const sc = b.neon;
    px.poly([P(u + 4, v, 2), P(u + du - 4, v, 2), P(u + du - 4, v, 9), P(u + 4, v, 9)], mix('#FFD39A', sc, 0.3), 0.85);
    px.poly([P(u + du, v + 4, 2), P(u + du, v + dv - 4, 2), P(u + du, v + dv - 4, 9), P(u + du, v + 4, 9)], mix('#FFC27A', sc, 0.2), 0.75);
    for (let a = u + 4; a < u + du - 4; a += 6) px.poly([P(a, v, 10), P(Math.min(a + 3, u + du - 4), v, 10), P(Math.min(a + 3, u + du - 4), v - 4, 12), P(a, v - 4, 12)], sc, 0.3);
    for (let a = u + 4; a < u + du - 4; a += 6) px.poly([P(a + 3, v, 10), P(Math.min(a + 6, u + du - 4), v, 10), P(Math.min(a + 6, u + du - 4), v - 4, 12), P(a + 3, v - 4, 12)], '#F4EEFF', 0.2);
  }
  // pilasters (deco) + floor ledges
  if (!b.tall) for (const a of [u + 2, u + du / 2, u + du - 4]) px.poly([P(a, v, 12), P(a + 2, v, 12), P(a + 2, v, h0 + h), P(a, v, h0 + h)], shade(wl, 0.18));
  // windows
  const lit = b.tall ? 0.16 + b.seed * 0.18 : 0.38;
  for (let wh = h0 + (ground ? 15 : 4); wh < h0 + h - 5; wh += step) {
    for (let a = u + 6; a < u + du - 5; a += 7) {
      const hv = hash(a * 3 + b.seed * 100, wh);
      const col = hv < lit * 0.2 ? '#7FE9F5' : hv < lit ? '#FFC77A' : hv < lit + 0.08 ? '#C9A060' : '#1A1430';
      px.poly([P(a, v, wh), P(a + 4, v, wh), P(a + 4, v, wh + 5), P(a, v, wh + 5)], col, hv < lit ? 0.9 : hv < lit + 0.08 ? 0.4 : 0);
    }
    for (let a = v + 5; a < v + dv - 5; a += 7) {
      const hv = hash(a * 5 + b.seed * 77, wh + 1);
      const col = hv < lit * 0.2 ? '#7FE9F5' : hv < lit ? '#E8A860' : '#151026';
      px.poly([P(u + du, a, wh), P(u + du, a + 4, wh), P(u + du, a + 4, wh + 5), P(u + du, a, wh + 5)], col, hv < lit ? 0.8 : 0);
    }
    if (!b.tall) px.line(P(u, v, wh - 2), P(u + du, v, wh - 2), shade(wl, 0.1));
  }
}
const PAINT = ['#FF3EA5', '#2EE6F0', '#F4EEFF', '#FFC75A', '#9B5CFF', '#FF7A6B', '#7CF5B4'];
/** A little retro sports car. dir: axis it drives along. Shared by parked and moving cars. */
function carShape(c: IC, u: number, v: number, axis: 'u' | 'v', col: string) {
  const { px } = c;
  const L = 18, W = 9;
  const [du, dv] = axis === 'u' ? [L, W] : [W, L];
  px.shadeEllipse(...G(u, v, 0), 13, 5, 0.4);
  box(c, u - du / 2, v - dv / 2, 1, du, dv, 4, col, { top: shade(col, 0.2) });
  const [cu, cv] = axis === 'u' ? [8, 7] : [7, 8];
  box(c, u - cu / 2 - (axis === 'u' ? 1 : 0), v - cv / 2 + (axis === 'v' ? 1 : 0), 5, cu, cv, 3, '#2A3A5A', { top: shade(col, -0.1), em: 0.15 });
  for (const [a, bb] of axis === 'u' ? [[-6, -4.5], [6, -4.5]] : [[4.5, -6], [4.5, 6]]) { const p = G(u + a, v + bb, 0); px.rect(p[0] - 1, p[1] - 2, 3, 2, '#0B0716'); }
}
function propDraw(c: IC, p: Prop) {
  const { px } = c, g = G(p.u, p.v, 0), au = p.axis !== 'v';
  switch (p.kind) {
    case 'lamp':
      px.shadeEllipse(g[0] + 2, g[1], 7, 3, 0.4);
      px.rect(g[0] - 2, g[1] - 4, 6, 4, '#1E1A34'); px.rect(g[0] - 1, g[1] - 5, 4, 1, '#3A3466');
      px.rect(g[0], g[1] - 52, 2, 52, '#2A2448'); px.rect(g[0], g[1] - 52, 1, 52, '#4A4478');
      px.rect(g[0] - 8, g[1] - 54, 10, 2, '#2A2448'); px.rect(g[0] - 10, g[1] - 53, 5, 3, '#FFE7B0', 1); px.rect(g[0] - 9, g[1] - 50, 3, 1, '#FFF6DE', 1);
      return;
    case 'palm': palmAt(px, g[0], g[1], p.s, p.rim, 0); return;
    case 'bench': {
      const [du, dv] = au ? [12, 3] : [3, 12];
      px.shadeEllipse(g[0] + 1, g[1], 8, 3, 0.35);
      for (const k of [1, au ? 10 : 1]) for (const m of [1, au ? 1 : 10]) box(c, p.u - du / 2 + (au ? k : 0.5), p.v - dv / 2 + (au ? 0.5 : m), 0, 1, 1, 3, '#2A2448', { edge: false });
      box(c, p.u - du / 2, p.v - dv / 2, 3, du, dv, 1, '#8A5A40', { top: '#B07A58', edge: false });
      box(c, p.u - du / 2 + (au ? 0 : dv - 1), p.v - dv / 2 + (au ? dv - 1 : 0), 4, au ? du : 1, au ? 1 : dv, 4, '#7A4E38', { top: '#A0704E', edge: false });
      return;
    }
    case 'bin': box(c, p.u - 1.5, p.v - 1.5, 0, 3, 3, 5, '#3A4A6A', { top: '#1A2030', edge: false }); px.line(G(p.u - 1.5, p.v - 1.5, 4), G(p.u + 1.5, p.v - 1.5, 4), '#7A8AB0'); return;
    case 'hydrant':
      box(c, p.u - 1, p.v - 1, 0, 2, 2, 4, '#D83A4A', { top: '#FF6A70', edge: false });
      px.rect(g[0] - 2, g[1] - 3, 5, 1, '#B02A3A'); px.rect(g[0], g[1] - 6, 1, 1, '#FF8A90');
      return;
    case 'news': box(c, p.u - 1.5, p.v - 2, 0, 3, 4, 6, '#2A3A7A', { top: '#4A5AA0', edge: false }); px.line(G(p.u - 1.5, p.v - 1, 4), G(p.u - 1.5, p.v + 1, 4), p.rim, 1, 0.8); return;
    case 'planter': {
      box(c, p.u - 3, p.v - 3, 0, 6, 6, 3, '#6A5E8E', { top: '#2A1E1A' });
      for (const [dx, dy, r, col] of [[0, -6, 5, '#1E5A3A'], [-1.5, -7.5, 3.5, '#2E7A4E'], [-2.5, -8.5, 1.5, '#5ABA72']] as [number, number, number, string][]) px.ellipse(g[0] + 3 + dx, g[1] + dy, r, r * 0.8, col);
      px.dot(g[0] + 5, g[1] - 8, '#FF8FC8', 0.6);
      return;
    }
    case 'stop': {
      const [du, dv] = au ? [16, 5] : [5, 16];
      px.shadeEllipse(g[0] + 2, g[1], 12, 4, 0.35);
      box(c, p.u - du / 2, p.v - dv / 2 + (au ? dv - 1 : 0), 0, au ? du : 1, au ? 1 : dv, 14, '#8FD8F0', { em: 0.15 });
      px.dither(au ? [G(p.u - du / 2, p.v + dv / 2, 0), G(p.u + du / 2, p.v + dv / 2, 0), G(p.u + du / 2, p.v + dv / 2, 14), G(p.u - du / 2, p.v + dv / 2, 14)] : [G(p.u + du / 2, p.v - dv / 2, 0), G(p.u + du / 2, p.v + dv / 2, 0), G(p.u + du / 2, p.v + dv / 2, 14), G(p.u + du / 2, p.v - dv / 2, 14)], '#B8F0FF', 0.3, 0.2);
      // the lit ad panel at the end and the roof
      box(c, au ? p.u + du / 2 - 1 : p.u - du / 2, au ? p.v - dv / 2 : p.v + dv / 2 - 1, 1, au ? 1 : du, au ? dv : 1, 12, p.rim, { em: 0.9 });
      box(c, p.u - du / 2 - 1, p.v - dv / 2 - 1, 14, du + 2, dv + 2, 1, '#2A2448', { top: '#4A4478' });
      box(c, p.u - du / 2 + 2, p.v - dv / 2 + 1, 3, au ? du - 6 : 2, au ? 2 : dv - 6, 1, '#5A4E80', { edge: false });
      return;
    }
  }
}
/** A round park tree: trunk, a canopy of overlapping clumps shaded dark below and lit on top, a neon rim. */
export function roundTree(px: Pix, x: number, y: number, s: number, rim: string, seed: number) {
  px.shadeEllipse(x + 8 * s, y, 13 * s, 4.5 * s, 0.4);
  px.rect(x - 1.5 * s, y - 14 * s, 3 * s, 14 * s, '#3A2234'); px.rect(x - 1.5 * s, y - 14 * s, 1, 14 * s, '#5A3A4A');
  px.line([x, y - 10 * s], [x + 4 * s, y - 15 * s], '#3A2234', 1);
  const clumps: [number, number, number][] = [[0, -20, 10], [-6, -16, 7], [6, -16, 7], [-4, -25, 7], [5, -24, 6], [0, -29, 5]];
  for (const [dx, dy, r] of clumps) px.ellipse(x + dx * s, y + dy * s, r * s, r * 0.85 * s, '#16452E');
  for (const [dx, dy, r] of clumps) px.ellipse(x + (dx - 1) * s, y + (dy - 1.5) * s, r * 0.75 * s, r * 0.6 * s, '#22603C');
  for (const [dx, dy, r] of clumps.slice(3)) px.ellipse(x + (dx - 2) * s, y + (dy - 2.5) * s, r * 0.4 * s, r * 0.32 * s, '#3E8A56');
  for (let k = 0; k < 7; k++) { const a = Math.PI * (0.9 + 0.8 * hash(seed, k)); px.dot(Math.floor(x + Math.cos(a) * 10 * s), Math.floor(y - 20 * s + Math.sin(a) * 9 * s), rim, 0.5); }
  for (let k = 0; k < 4; k++) px.dot(Math.floor(x + (hash(k, seed) - 0.5) * 12 * s), Math.floor(y - 18 * s + hash(seed, k + 3) * 6 * s), '#0E2E1E');
}
/** A palm: a curved, ringed trunk and a crown of feathery fronds, each a spine with leaflets drooping off both
    sides. The back fronds are darker; the front ones catch the neon on their upper edge. */
export function palmAt(px: Pix, x: number, y: number, s: number, rim: string, frame: number) {
  const n = 24, Ht = 124 * s, bend = 26 * s;
  px.shadeEllipse(x + 30 * s, y, 28 * s, 7 * s, 0.35);
  let cx = x, cy = y;
  for (let k = 0; k < n; k++) {
    const f = k / n, nx = x + bend * f * f, ny = y - Ht * f, w = Math.max(2, (8 - 3.5 * f) * s), sh = Ht / n + 1;
    px.rect(nx - w / 2, ny - sh, w, sh, '#4A2E3E');
    px.rect(nx + w / 2 - Math.max(1, w * 0.35), ny - sh, Math.max(1, w * 0.35), sh, '#2E1A2A');
    px.rect(nx - w / 2, ny - sh, 1, sh, shade(rim, -0.3), 0.45);
    if (k % 2 === 0) px.rect(nx - w / 2, ny - sh, w, 1, '#2A1824');
    cx = nx; cy = ny;
  }
  // the bulge where the fronds start, and coconuts
  px.ellipse(cx, cy + 1, 5 * s, 4 * s, '#3E2634');
  const sway = Math.sin((frame / 8) * Math.PI * 2) * 3 * s;
  // a frond seen from the side: an arching spine with its leaflets hanging below it as one serrated green band,
  // lighter along the top where the light lands, cut into leaflets by darker strokes
  const frond = (dx: number, dy: number, len: number, dark: boolean) => {
    const [base, top, cut, spine] = dark ? ['#0F2A28', '#163A34', '#081A1A', '#0A1E1E'] : ['#1D5444', '#2F7A5A', '#0E2E26', '#45885C'];
    const sp: Pt[] = [], lo: Pt[] = [], mid: Pt[] = [];
    const N = 12;
    for (let k = 0; k <= N; k++) {
      const f = k / N, x0 = cx + dx * len * f + sway * f, y0 = cy - 3 * s + dy * len * f * 0.6 + 30 * s * f * f;
      const hang = (2 + 11 * Math.sin(Math.PI * Math.min(1, f * 1.1))) * s * (k % 2 ? 0.72 : 1) * (1 - 0.25 * Math.abs(dx));
      sp.push([x0, y0]); lo.push([x0 + dx * 2.5 * s * f, y0 + hang]); mid.push([x0, y0 + hang * 0.42]);
    }
    px.poly([...sp, ...lo.slice().reverse()], base);
    px.poly([...sp, ...mid.slice().reverse()], top);
    for (let k = 1; k < N; k += 1) px.line(sp[k]!, lo[k]!, cut, 1);
    for (let k = 1; k <= N; k++) px.line(sp[k - 1]!, sp[k]!, spine, Math.max(1, 2 * s * (1 - (k / N) * 0.6)));
    if (!dark) for (let k = 1; k <= N; k++) px.line([sp[k - 1]![0], sp[k - 1]![1] - 1], [sp[k]![0], sp[k]![1] - 1], rim, 1, k < N - 2 ? 0.75 : 0.4);
  };
  for (const [dx, dy] of [[-0.55, -1], [0.1, -1.05], [0.65, -0.85], [-0.95, -0.5]] as Pt[]) frond(dx, dy, 52 * s, true);
  for (const [k, dx] of [-0.5, 0.3, 1.0].entries()) px.ellipse(cx + dx * 4 * s, cy + (2 + (k % 2)) * s, 2.2 * s, 2 * s, k % 2 ? '#6A4A2A' : '#4A3220');
  for (const [dx, dy] of [[-1, 0.2], [-0.8, -0.55], [-0.25, -0.95], [0.4, -0.8], [0.95, -0.35], [1, 0.3], [0.3, 0.6], [-0.45, 0.55]] as Pt[]) frond(dx, dy, 60 * s, false);
}

/* ================================================================== traffic */
interface Lane { axis: 'u' | 'v'; at: number; dir: 1 | -1; front: boolean }
const LANES: Lane[] = [
  { axis: 'u', at: -22, dir: 1, front: true }, { axis: 'u', at: -42, dir: -1, front: true },
  { axis: 'v', at: 382, dir: 1, front: true }, { axis: 'v', at: 402, dir: -1, front: true },
  { axis: 'v', at: -22, dir: 1, front: false }, { axis: 'v', at: -42, dir: -1, front: false },
  { axis: 'u', at: 232, dir: 1, front: false }, { axis: 'u', at: 252, dir: -1, front: false },
];
interface Car { u: number; v: number; axis: 'u' | 'v'; dir: 1 | -1; col: string; key: number; a: number }
/** Where each axis' roads run on land: u roads stop at the coast road's far edge, v roads at the promenade. */
const LAND = { u: [-52, 1460], v: [-1240, 262] } as const;
function cars(t: number, front: boolean): Car[] {
  const out: Car[] = [];
  LANES.forEach((ln, li) => {
    if (ln.front !== front) return;
    const [lo, hi] = LAND[ln.axis], range = hi - lo;
    for (let k = 0; k < 3; k++) {
      const sp = 38 + hash(li, k) * 30, off = hash(k, li) * range;
      const s = (t * sp + off) % range, pos = ln.dir > 0 ? lo + s : hi - s;
      const u = ln.axis === 'u' ? pos : ln.at, v = ln.axis === 'v' ? pos : ln.at;
      if (G(u, v)[1] < HZ + 6) continue;
      // a car fades in and out where its road meets the water, so none ever drives onto the bay
      const edge = ln.axis === 'u' ? pos - lo : hi - pos;
      out.push({ u, v, axis: ln.axis, dir: ln.dir, col: PAINT[(li * 3 + k) % PAINT.length], key: li * 10 + k, a: Math.max(0, Math.min(1, (edge - 6) / 24)) });
    }
  });
  return out;
}
function drawCar(px: Pix, L: Lights, car: Car, bk: Bakery) {
  if (car.a <= 0) return;
  px.push(car.a);
  bk.draw(px, bk.get(`car${car.axis}${car.col}`, (q) => carShape(gc(q), 0, 0, car.axis, car.col)), ...(G(car.u, car.v).map((x, i) => x - (i ? 51 : -95)) as Pt));
  // lamps on the visible ends: headlights face -u/-v ... the drawn faces are the +u and -v ends
  const d = car.dir, ax = car.axis;
  const front = (k: number): Pt => (ax === 'u' ? G(car.u + d * k, car.v, 3) : G(car.u, car.v + d * k, 3));
  const visibleFront = ax === 'u' ? d > 0 : d < 0;
  const end = front(9.5);
  if (visibleFront) { px.rect(end[0] - 2, end[1] - 1, 2, 1, '#FFFFFF', 1); px.rect(end[0] + 1, end[1] - 2, 2, 1, '#FFFFFF', 1); }
  else { const b = front(-9.5); px.rect(b[0] - 2, b[1] - 1, 2, 1, '#FF3A5A', 1); px.rect(b[0] + 1, b[1] - 2, 2, 1, '#FF3A5A', 1); }
  const beam = ax === 'u' ? G(car.u + d * 34, car.v, 0) : G(car.u, car.v + d * 34, 0);
  L.add(beam[0], beam[1], 34, '#FFF1D0', 0.5 * car.a, 0.5);
  const tail = front(-10); L.add(tail[0], tail[1], 16, '#FF3A5A', 0.45 * car.a, 0.6);
  px.pop();
}

/* ================================================================== passes */
export function cityBack(px: Pix, L: Lights, t: number, bk: Bakery) {
  const m = model();
  bk.draw(px, bk.get('ground', (q) => ground(q)));
  bk.draw(px, bk.get('blds-back', (q) => { const c = gc(q); for (const b of m.back) building(c, b); for (const p of m.backProps) propDraw(c, p); }));
  const lot = m.lotProps.filter((p) => !(p.u > 300 || p.v < 35));
  const list: { y: number; f: () => void }[] = [];
  for (const car of cars(t, false)) list.push({ y: G(car.u, car.v)[1], f: () => drawCar(px, L, car, bk) });
  for (const p of lot) list.push({ y: G(p.u, p.v)[1], f: () => bk.draw(px, bk.get(`prop${p.kind}${p.s}${p.rim}`, (q) => propDraw(gc(q), { ...p, u: 0, v: 0 })), G(p.u, p.v)[0] - G(0, 0)[0], G(p.u, p.v)[1] - G(0, 0)[1]) });
  list.sort((a, b) => a.y - b.y).forEach((x) => x.f());
  for (const l of m.lights) L.add(l.x, l.y, l.r, l.c, l.i, l.sy);
}
export function cityFront(px: Pix, L: Lights, t: number, bk: Bakery) {
  const m = model();
  const lot = m.lotProps.filter((p) => p.u > 300 || p.v < 35);
  const list: { y: number; f: () => void }[] = [];
  for (const car of cars(t, true)) list.push({ y: G(car.u, car.v)[1], f: () => drawCar(px, L, car, bk) });
  for (const p of lot) list.push({ y: G(p.u, p.v)[1], f: () => bk.draw(px, bk.get(`prop${p.kind}${p.s}${p.rim}`, (q) => propDraw(gc(q), { ...p, u: 0, v: 0 })), G(p.u, p.v)[0] - G(0, 0)[0], G(p.u, p.v)[1] - G(0, 0)[1]) });
  list.sort((a, b) => a.y - b.y).forEach((x) => x.f());
  bk.draw(px, bk.get('blds-front', (q) => {
    const c = gc(q);
    const items: { y: number; f: () => void }[] = [];
    for (const b of m.front) items.push({ y: G(b.u, b.v + b.dv)[1], f: () => building(c, b) });
    for (const p of m.frontProps) items.push({ y: G(p.u, p.v)[1], f: () => propDraw(c, p) });
    items.sort((a, b) => a.y - b.y).forEach((x) => x.f());
  }));
}
export function farSkyline(px: Pix, t: number, bk: Bakery) {
  LAYERS.forEach((L, i) => { bk.draw(px, bk.get('sky' + i, (q) => skylineLayer(q, L))); if (i === 2) bk.draw(px, bk.get('bridge', (q) => bridge(q))); });
  // bridge cable lights chase along the span
  for (let k = 0; k < 24; k++) { const f = k / 24, x = -820 + f * 570, on = (Math.floor(t * 8) + k) % 6 === 0; if (on) px.rect(x, HZ - 12 - 0, 2, 1, '#FFFFFF', 1); }
  // a few windows switching on and off + blinking aircraft lights
  for (let i = 0; i < 18; i++) { const k = Math.floor(t * 0.7 + i * 3.7); const x = -900 + hash(k, i) * 2300, y = HZ - 10 - hash(i, k) * 140; px.rect(x, y, 2, 2, hash(k, 2) > 0.5 ? '#FFC77A' : '#7FE9F5', 1); }
}
