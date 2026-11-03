/* Pixel-art people, built procedurally on a 20 x 34 grid (1 art pixel = 1 world unit) and cached.
   Chibi proportions like Octopath sprites: big head, readable face, two-tone shading lit from the
   upper left, and an automatic selective outline (each outline pixel is a dark version of the
   colour it wraps), which is what makes small sprites read as "hand-pixelled". */
export const SW = 20, SH = 34, AX = 10, AY = 33;

const SKIN = ['#F7D7B8', '#EBB58E', '#CC8D62', '#9C6544', '#6F4430'];
const HAIR = ['#2B1D18', '#5B3424', '#E0AE4E', '#17151F', '#8A2E45', '#43306E', '#D6D0E6'];
const PANTS = ['#2D2A52', '#383250', '#22304E', '#3B2A44'];
const EYE = '#1A1226';

export interface Look { key: string; skin: number; hair: number; style: number; acc: number; shirt: string; pants: string; chief: boolean }
export function lookFor(id: string, shirt: string, chief: boolean): Look {
  let h = 2166136261; for (const ch of id) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  const acc = (h >>> 9) % 5;
  return {
    key: id, skin: h % SKIN.length, hair: (h >>> 3) % HAIR.length, style: (h >>> 6) % 6,
    acc: chief ? (acc === 2 ? 2 : 0) : acc, shirt, pants: PANTS[(h >>> 12) % PANTS.length], chief,
  };
}

export interface Pose { dir: 'f' | 'b'; frame: number; seated: boolean; type: number }
export interface Sprite { img: HTMLCanvasElement; sil: HTMLCanvasElement }
const cache = new Map<string, Sprite>();

export function shade(hex: string, f: number) {
  const n = parseInt(hex.slice(1, 7), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.max(0, Math.min(255, Math.round(f >= 0 ? v + (255 - v) * f : v * (1 + f)))));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}
export function mix(a: string, b: string, t: number) {
  const x = parseInt(a.slice(1, 7), 16), y = parseInt(b.slice(1, 7), 16);
  const c = [16, 8, 0].map((s) => Math.round(((x >> s) & 255) * (1 - t) + ((y >> s) & 255) * t));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}

export function getSprite(L: Look, p: Pose): Sprite {
  const k = `${L.key}|${L.shirt}|${p.dir}${p.frame}${p.seated ? 's' : ''}${p.type}`;
  let s = cache.get(k); if (s) return s;
  s = build(L, p); cache.set(k, s); return s;
}

let ghostS: Sprite | null = null;
/** Dashed amber outline of a person: the "awaiting chief" placeholder. */
export function ghostSprite(): Sprite {
  if (ghostS) return ghostS;
  const base = build(lookFor('ghost', '#FFFFFF', true), { dir: 'f', frame: 0, seated: false, type: 0 }, true);
  ghostS = base; return base;
}

function build(L: Look, p: Pose, ghost = false): Sprite {
  const px: (string | null)[] = new Array(SW * SH).fill(null);
  const R = (x: number, y: number, w: number, h: number, c: string) => {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (i >= 0 && i < SW && j >= 0 && j < SH) px[j * SW + i] = c;
  };
  const P = (x: number, y: number, c: string) => R(x, y, 1, 1, c);
  const skin = SKIN[L.skin], skS = shade(skin, -0.13), skD = shade(skin, -0.3);
  const hair = HAIR[L.hair], hH = shade(hair, L.hair === 6 ? 0.3 : 0.22), hD = shade(hair, -0.3);
  const chief = L.chief;
  const c = chief ? '#3A2F6E' : L.shirt, cS = shade(c, -0.24), cL = shade(c, 0.16), cD = shade(c, -0.42);
  const pants = chief ? '#211B3D' : L.pants, pS = shade(pants, -0.3);
  const shoe = chief ? '#140F22' : '#2A2036', shoeH = shade(shoe, 0.3);
  const front = p.dir === 'f', seated = p.seated, fr = p.frame % 4;
  const bob = !seated && (fr === 1 || fr === 3) ? 1 : 0;
  const by = (seated ? 3 : 0) + bob;

  /* ---- legs ---- */
  if (!seated) {
    const lUp = fr === 1 ? 1 : 0, rUp = fr === 3 ? 1 : 0;
    R(6, 24 + by, 8, 1, pS);
    R(6, 25, 4, 6 - lUp, pants); R(10, 25, 4, 6 - rUp, pants);
    R(12, 25, 2, 6 - rUp, pS); R(9, 27, 1, 4 - lUp, pS); P(6, 25, shade(pants, 0.12));
    R(5 - lUp, 31 - lUp, 5, 2, shoe); R(10 + rUp, 31 - rUp, 5, 2, shoe);
    P(6 - lUp, 31 - lUp, shoeH); P(11 + rUp, 31 - rUp, shoeH);
  }

  /* ---- torso + arms ---- */
  const T = 15 + by;
  R(6, T, 8, 1, c); R(5, T + 1, 10, 8, c);
  R(5, T + 1, 1, 7, cL); R(12, T + 1, 3, 8, cS); R(14, T + 2, 1, 6, cD);
  R(5, T + 8, 10, 1, cS);
  if (!seated) R(6, T + 9, 8, 1, pS); // belt line
  if (front) {
    if (chief) {
      // blazer, white shirt V, pink tie, gold pocket square
      R(7, T, 6, 1, '#F1ECFF'); R(8, T + 1, 4, 2, '#F1ECFF'); R(9, T + 3, 2, 2, '#F1ECFF');
      R(9, T + 1, 2, 6, '#FF3EA5'); P(9, T + 1, '#C42A7F'); P(10, T + 6, '#C42A7F');
      P(7, T + 1, cL); P(12, T + 1, cD); P(7, T + 2, cL); P(12, T + 2, cD);
      P(6, T + 4, '#FFC75A'); P(7, T + 4, '#FFC75A');
      R(12, T + 5, 1, 1, cD);
    } else {
      R(8, T, 4, 1, skS); R(9, T + 1, 2, 1, skS);
      // lanyard + badge
      P(8, T + 1, '#1E1834'); P(8, T + 2, '#1E1834'); P(11, T + 1, '#1E1834'); P(11, T + 2, '#1E1834'); P(9, T + 3, '#1E1834'); P(10, T + 3, '#1E1834');
      R(9, T + 4, 2, 2, '#EDE8FF'); P(9, T + 5, shade(c, 0.5));
      P(6, T + 6, cS); P(7, T + 7, cS); // fold
    }
    const sw = !seated ? (fr === 1 ? 1 : fr === 3 ? -1 : 0) : 0;
    R(3, T + 1, 2, 7 + sw, c); P(3, T + 1, cL); R(3, T + 2, 1, 5 + sw, cL);
    R(3, T + 8 + sw, 2, 2, skin); P(4, T + 9 + sw, skS);
    R(15, T + 1, 2, 7 - sw, cS); R(16, T + 2, 1, 5 - sw, cD);
    R(15, T + 8 - sw, 2, 2, skS);
  } else {
    if (chief) { R(7, T, 6, 1, '#F1ECFF'); R(10, T + 3, 1, 6, cS); }
    else { R(7, T, 6, 2, cS); R(8, T, 4, 1, cD); P(7, T + 2, cS); P(12, T + 2, cS); R(6, T + 3, 1, 3, cS); }
    const tp = seated ? p.type : 0;
    // arms reach forward to the desk when seated: elbows tuck in and bob while typing
    if (seated) {
      R(3, T + 1, 2, 5 - tp, c); P(3, T + 1, cL); R(4, T + 6 - tp, 2, 1, c);
      R(15, T + 1, 2, 5 - (1 - tp), cS); R(14, T + 6 - (1 - tp), 2, 1, cS);
    } else {
      const sw = fr === 1 ? 1 : fr === 3 ? -1 : 0;
      R(3, T + 1, 2, 7 - sw, c); P(3, T + 1, cL); R(3, T + 8 - sw, 2, 2, skin);
      R(15, T + 1, 2, 7 + sw, cS); R(15, T + 8 + sw, 2, 2, skS);
    }
  }

  /* ---- head ---- */
  const H = by; // head moves with the body
  R(8, 14 + H, 4, 1, skD); // neck
  R(6, 4 + H, 8, 1, skin); R(5, 5 + H, 10, 8, skin); R(6, 13 + H, 8, 1, skS);
  R(13, 6 + H, 2, 7, skS); P(5, 12 + H, skS);
  if (front) {
    P(4, 9 + H, skin); P(4, 10 + H, skS);
    // eyes (3/4 view to the right) with a catch-light, blush and mouth
    R(8, 9 + H, 1, 2, EYE); R(12, 9 + H, 1, 2, EYE); P(8, 9 + H, '#3D2C5C'); P(12, 9 + H, '#3D2C5C');
    P(7, 11 + H, mix(skin, '#FF6F8E', 0.3)); P(13, 11 + H, mix(skS, '#FF6F8E', 0.3));
    P(11, 12 + H, skD);
    P(10, 10 + H, skS); // nose shadow
  } else {
    P(4, 9 + H, skin); P(4, 10 + H, skS); P(15, 9 + H, skS); P(15, 10 + H, skD);
  }

  /* ---- hair ---- */
  const st = L.style;
  if (front) {
    if (st === 4) { R(3, 2 + H, 14, 5, hair); R(4, 1 + H, 12, 1, hair); R(3, 7 + H, 3, 4, hair); R(14, 7 + H, 3, 3, hair); P(3, 1 + H, hair); P(16, 2 + H, hD); R(6, 7 + H, 4, 1, hair); }
    else {
      R(6, 1 + H, 8, 1, hair); R(5, 2 + H, 10, 1, hair); R(4, 3 + H, 12, 3, hair);
      R(4, 6 + H, 2, 4, hair); R(14, 6 + H, 2, 3, hair);
      R(6, 6 + H, 5, 1, hair); R(6, 7 + H, 2, 1, hair); P(12, 6 + H, hair); P(13, 6 + H, hair); P(13, 7 + H, hD);
    }
    if (st === 1) { R(3, 6 + H, 3, 12, hair); R(14, 6 + H, 3, 11, hD); R(3, 8 + H, 1, 8, hH); P(15, 7 + H, hair); }
    if (st === 2) { R(8, -1 + H < 0 ? 0 : H - 1, 4, 2, hair); R(7, H, 6, 1, hair); P(9, H, hH); }
    if (st === 3) { P(5, 1 + H, hair); P(7, H, hair); P(10, H, hair); P(13, 1 + H, hair); P(15, 2 + H, hair); P(3, 4 + H, hair); }
    if (st === 5) {
      const cap = chief ? '#2A2350' : shade(L.shirt, -0.1);
      R(4, 1 + H, 12, 4, cap); R(5, H, 10, 1, cap); R(5, 1 + H, 3, 1, shade(cap, 0.25)); R(8, 5 + H, 9, 1, shade(cap, -0.35)); P(9, 2 + H, '#F4EEFF');
      R(4, 6 + H, 2, 3, hair);
    }
    // highlight band + shadow side
    if (st !== 5) { R(6, 2 + H, 4, 1, hH); R(5, 3 + H, 2, 1, hH); P(8, 3 + H, hH); R(14, 3 + H, 2, 3, hD); P(15, 6 + H, hD); }
  } else {
    if (st === 4) { R(3, 1 + H, 14, 10, hair); P(3, 1 + H, hair); }
    else { R(6, 1 + H, 8, 1, hair); R(5, 2 + H, 10, 1, hair); R(4, 3 + H, 12, 9, hair); R(5, 12 + H, 10, 1, hair); }
    if (st === 1) { R(4, 12 + H, 12, 6, hair); R(5, 18 + H, 10, 1, hD); }
    if (st === 2) { R(8, Math.max(0, H - 1), 4, 2, hair); R(7, H, 6, 1, hair); P(9, Math.max(0, H - 1), hH); }
    if (st === 3) { P(5, 1 + H, hair); P(7, H, hair); P(10, H, hair); P(13, 1 + H, hair); }
    if (st === 5) { const cap = chief ? '#2A2350' : shade(L.shirt, -0.1); R(4, 1 + H, 12, 4, cap); R(5, H, 10, 1, cap); R(5, 1 + H, 3, 1, shade(cap, 0.25)); R(4, 5 + H, 12, 1, shade(cap, -0.3)); }
    if (st !== 5) { R(6, 2 + H, 4, 1, hH); R(5, 3 + H, 2, 2, hH); R(13, 4 + H, 3, 7, hD); }
    if (st !== 1 && st !== 4) R(7, 12 + H, 6, 1, hD);
    // nape
    if (st !== 1 && st !== 4) R(7, 13 + H, 6, 1, skS);
  }

  /* ---- accessories ---- */
  if (L.acc === 2 && front) {
    const f = '#151022'; R(7, 8 + H, 3, 1, f); R(11, 8 + H, 3, 1, f); P(10, 9 + H, f); P(7, 9 + H, f); P(14, 9 + H, f);
    P(8, 9 + H, '#9FE8FF'); P(12, 9 + H, '#9FE8FF'); P(8, 10 + H, EYE); P(12, 10 + H, EYE);
  }
  if (L.acc === 3) {
    const hp = '#2A2440', led = L.shirt;
    R(5, H, 10, 1, hp); P(4, 1 + H, hp); P(15, 1 + H, hp); P(16, 2 + H, hp);
    R(2, 7 + H, 3, 4, hp); R(15, 7 + H, 3, 4, hp); P(2, 8 + H, shade(hp, 0.3)); P(17, 8 + H, led);
  }

  /* ---- selective outline ---- */
  const out = px.slice();
  for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
    if (px[y * SW + x]) continue;
    let nb: string | null = null;
    for (const [dx, dy] of [[0, 1], [1, 0], [-1, 0], [0, -1]]) { const q = px[(y + dy) * SW + (x + dx)]; if (x + dx >= 0 && x + dx < SW && y + dy >= 0 && y + dy < SH && q) { nb = q; break; } }
    if (nb) out[y * SW + x] = mix(nb, '#0B0716', 0.78);
  }

  const img = document.createElement('canvas'); img.width = SW; img.height = SH;
  const sil = document.createElement('canvas'); sil.width = SW; sil.height = SH;
  const g = img.getContext('2d')!, gs = sil.getContext('2d')!;
  const id = g.createImageData(SW, SH), is = gs.createImageData(SW, SH);
  for (let i = 0; i < out.length; i++) {
    let col = ghost ? (out[i] && !px[i] ? '#FFB547' : null) : out[i];
    if (ghost && col && ((i % SW) + Math.floor(i / SW)) % 2) col = null;
    if (!col) continue;
    const n = parseInt(col.slice(1, 7), 16);
    id.data[i * 4] = n >> 16; id.data[i * 4 + 1] = (n >> 8) & 255; id.data[i * 4 + 2] = n & 255; id.data[i * 4 + 3] = 255;
    is.data[i * 4 + 3] = 255; // black silhouette (rgb 0)
    if (ghost) { is.data[i * 4] = is.data[i * 4 + 1] = is.data[i * 4 + 2] = 255; }
  }
  g.putImageData(id, 0, 0); gs.putImageData(is, 0, 0);
  return { img, sil };
}
