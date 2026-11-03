/* Dialogue portraits: a 48 x 48 art-pixel bust per agent, in a bold-outline style for the dialogue window.
   Built from the same Look as the office sprite (skin, hair, style, accessory, shirt), so the portrait and the
   person at the desk are recognisably the same agent. Cached per look + expression + frame. */
import type { Mood } from '@vibe-city/shared';
import { HAIR, SKIN, shade, mix, type Look } from './sprites';

export const PW = 48, PH = 48;
export type Expr = Mood;
const INK = '#120A1E';
const cache = new Map<string, HTMLCanvasElement>();

/** Extra parts: exaggerated looks for AR's joke candidates, and AR's own clipboard. */
export type Gag = 'shades' | 'frazzled' | 'intern' | 'guru' | 'clipboard';

export function portrait(L: Look, expr: Expr, talk: boolean, blink: boolean, gag: Gag | null = null): HTMLCanvasElement {
  if (!gag && L.prop === 'shades') gag = 'shades';
  const key = `${L.key}|${L.shirt}|${L.prop ?? ''}|${expr}|${talk ? 1 : 0}${blink ? 1 : 0}|${gag ?? ''}`;
  let c = cache.get(key);
  if (!c) { c = build(L, expr, talk, blink, gag); cache.set(key, c); if (cache.size > 400) cache.delete(cache.keys().next().value!); }
  return c;
}

function build(L: Look, expr: Expr, talk: boolean, blink: boolean, gag: Gag | null): HTMLCanvasElement {
  const px: (string | null)[] = new Array(PW * PH).fill(null);
  const P = (x: number, y: number, c: string) => { if (x >= 0 && x < PW && y >= 0 && y < PH) px[y * PW + x] = c; };
  const R = (x: number, y: number, w: number, h: number, c: string) => { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) P(i, j, c); };
  const E = (cx: number, cy: number, rx: number, ry: number, c: string) => {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry; if (dx * dx + dy * dy <= 1) P(x, y, c);
    }
  };
  const skin = SKIN[L.skin]!, skS = shade(skin, -0.16), skD = shade(skin, -0.34), skH = shade(skin, 0.18);
  const hair = HAIR[L.hair]!, hH = shade(hair, L.hair === 6 ? 0.25 : 0.28), hD = shade(hair, -0.35);
  const shirt = L.chief ? '#3A2F6E' : L.shirt, sS = shade(shirt, -0.25), sH = shade(shirt, 0.18);
  const st = L.style;

  // long hair falls behind the shoulders
  if (st === 1) { R(10, 16, 28, 26, hair); R(10, 30, 4, 12, hD); R(34, 30, 4, 12, hD); }
  if (st === 4) E(24, 18, 17, 15, hair);

  // shoulders and torso
  R(4, 41, 40, 7, shirt); R(6, 39, 36, 2, shirt); R(9, 38, 30, 1, shirt);
  R(4, 41, 3, 7, sH); R(36, 41, 8, 7, sS); R(9, 38, 4, 3, sH);
  if (L.chief) {
    R(19, 38, 10, 10, '#F1ECFF'); R(22, 39, 4, 9, '#FF3EA5'); R(23, 39, 2, 1, '#C42A7F');
    R(17, 38, 2, 10, shade(shirt, 0.3)); R(29, 38, 2, 10, sS); R(8, 43, 3, 2, '#FFC75A');
  } else {
    R(20, 38, 8, 3, skS); R(21, 41, 6, 1, skD);
    R(18, 42, 1, 6, '#1E1834'); R(29, 42, 1, 6, '#1E1834'); R(21, 44, 6, 4, '#EDE8FF'); R(22, 45, 4, 1, sH);
  }
  // neck
  R(20, 33, 8, 6, skS); R(20, 33, 8, 2, skD);

  // head
  E(24, 21, 11, 13, skin);
  R(14, 20, 3, 8, skin); R(31, 20, 3, 8, skin);
  for (let y = 12; y < 34; y++) for (let x = 27; x < 36; x++) if (px[y * PW + x] === skin && (x - 27) + (y - 12) * 0.25 > 5) P(x, y, skS);
  R(16, 15, 3, 3, skH);
  // ears
  R(12, 21, 2, 5, skin); R(12, 22, 1, 3, skS); R(35, 21, 2, 5, skS); R(36, 22, 1, 3, skD);

  // hair on top
  const cap = st === 5;
  if (!cap) {
    E(24, 12, 12, 7, hair); R(13, 12, 3, 9, hair); R(32, 12, 3, 8, hair);
    if (st === 0) { R(15, 15, 8, 2, hair); R(27, 15, 5, 2, hair); }
    if (st === 2) { E(24, 5, 5, 4, hair); E(23, 4, 2, 1.5, hH); }
    if (st === 3) { for (const [x, y] of [[14, 7], [18, 4], [23, 3], [28, 4], [32, 6]]) R(x!, y!, 3, 4, hair); R(15, 15, 18, 2, hair); }
    if (st === 4) { E(24, 10, 15, 9, hair); }
    if (st === 1) { R(14, 15, 20, 2, hair); }
    R(17, 7, 7, 2, hH); R(15, 9, 3, 3, hH); R(30, 9, 4, 8, hD);
  } else {
    const cc = L.chief ? '#2A2350' : shade(L.shirt, -0.05);
    E(24, 11, 12, 7, cc); R(12, 13, 24, 3, cc); R(22, 14, 16, 2, shade(cc, -0.35)); R(16, 7, 6, 2, shade(cc, 0.25)); R(23, 8, 2, 2, '#F4EEFF');
    R(13, 16, 3, 5, hair); R(32, 16, 3, 4, hair);
  }

  // brows by mood
  const browL: [number, number][] = [], browR: [number, number][] = [];
  const by = 18;
  switch (expr) {
    case 'annoyed': browL.push([16, by - 1], [17, by - 1], [18, by], [19, by], [20, by + 1]); browR.push([27, by + 1], [28, by], [29, by], [30, by - 1], [31, by - 1]); break;
    case 'worried': browL.push([16, by + 1], [17, by], [18, by], [19, by - 1], [20, by - 1]); browR.push([27, by - 1], [28, by - 1], [29, by], [30, by], [31, by + 1]); break;
    case 'focused': browL.push([16, by + 1], [17, by + 1], [18, by + 1], [19, by + 1], [20, by + 1]); browR.push([27, by + 1], [28, by + 1], [29, by + 1], [30, by + 1], [31, by + 1]); break;
    case 'smug': browL.push([16, by], [17, by], [18, by], [19, by], [20, by]); browR.push([27, by - 2], [28, by - 2], [29, by - 1], [30, by - 1], [31, by]); break;
    default: browL.push([16, by], [17, by - 1], [18, by - 1], [19, by - 1], [20, by]); browR.push([27, by], [28, by - 1], [29, by - 1], [30, by - 1], [31, by]);
  }
  for (const [x, y] of [...browL, ...browR]) { P(x, y, hD); P(x, y + 1, hD); }

  // eyes
  const eyeY = 21;
  const eye = (x: number, right: boolean) => {
    if (blink || expr === 'happy') {
      if (expr === 'happy' && !blink) { P(x, eyeY + 1, INK); P(x + 1, eyeY, INK); P(x + 2, eyeY, INK); P(x + 3, eyeY + 1, INK); }
      else R(x, eyeY + 1, 4, 1, INK);
      return;
    }
    const h = expr === 'focused' ? 2 : expr === 'worried' ? 4 : 3;
    const y0 = expr === 'focused' ? eyeY + 1 : expr === 'worried' ? eyeY - 1 : eyeY;
    R(x, y0, 4, h, '#F4F0FF'); R(x + (right ? 1 : 2), y0, 2, h, '#2A1840'); P(x + (right ? 1 : 2), y0, '#FFFFFF');
    if (expr === 'smug' && right) R(x, y0, 4, 1, skS);
    R(x, y0 - 1, 4, 1, INK);
  };
  eye(16, false); eye(28, true);
  if (L.acc === 2) {
    const f = '#151022';
    R(14, 20, 9, 1, f); R(14, 25, 9, 1, f); R(14, 20, 1, 6, f); R(22, 20, 1, 6, f);
    R(26, 20, 9, 1, f); R(26, 25, 9, 1, f); R(26, 20, 1, 6, f); R(34, 20, 1, 6, f); R(23, 21, 3, 1, f);
    P(16, 21, '#BFF2FF'); P(28, 21, '#BFF2FF');
  }
  // nose
  R(24, 24, 2, 4, skS); P(23, 27, skD); P(25, 28, skD);
  // cheeks
  if (expr === 'happy' || expr === 'smug') { R(15, 27, 3, 1, mix(skin, '#FF5C8A', 0.35)); R(31, 27, 3, 1, mix(skS, '#FF5C8A', 0.35)); }
  if (expr === 'worried') { R(34, 16, 1, 3, '#9FE8FF'); P(34, 19, '#DFF8FF'); }

  // mouth
  const my = 30;
  if (talk) {
    R(21, my - 1, 7, 3, '#3A0E1E'); R(22, my - 1, 5, 1, '#F4F0FF'); R(22, my + 1, 5, 1, '#C84868');
  } else switch (expr) {
    case 'happy': R(20, my, 9, 1, INK); P(19, my - 1, INK); P(29, my - 1, INK); R(21, my + 1, 7, 1, '#7A2034'); break;
    case 'smug': R(22, my, 6, 1, INK); P(28, my - 1, INK); P(29, my - 1, INK); break;
    case 'worried': P(21, my, INK); R(22, my - 1, 2, 1, INK); R(24, my, 2, 1, INK); R(26, my - 1, 2, 1, INK); break;
    case 'annoyed': R(21, my, 7, 1, INK); P(20, my + 1, INK); P(28, my + 1, INK); break;
    case 'focused': R(22, my, 5, 1, INK); break;
    default: R(21, my, 7, 1, INK); P(28, my - 1, INK);
  }
  R(21, my + 2, 6, 1, skS);

  // headphones
  if (L.acc === 3) {
    const hp = '#2A2440';
    R(13, 6, 22, 2, hp); R(11, 8, 2, 4, hp); R(35, 8, 2, 4, hp);
    R(9, 18, 5, 9, hp); R(34, 18, 5, 9, hp); R(10, 19, 2, 7, shade(hp, 0.35)); R(36, 21, 2, 3, L.shirt);
  }

  // gag parts, drawn over everything else
  if (gag === 'shades') {
    const f = '#0B0714';
    R(13, 19, 22, 2, f); R(14, 21, 9, 4, f); R(26, 21, 9, 4, f); R(15, 25, 7, 1, f); R(27, 25, 7, 1, f);
    R(15, 21, 3, 1, '#7A5CFF'); R(27, 21, 3, 1, '#FF3EA5'); P(16, 22, '#C9B8FF'); P(28, 22, '#FFB0D8');
    R(12, 20, 2, 1, f); R(35, 20, 2, 1, f);
  }
  if (gag === 'frazzled') {
    for (const [x, y, h] of [[12, 4, 6], [16, 1, 7], [21, 0, 6], [27, 2, 6], [32, 3, 7], [36, 8, 5], [9, 9, 5]]) R(x!, y!, 2, h!, hair);
    R(16, 24, 4, 1, skD); R(28, 24, 4, 1, skD); R(17, 25, 3, 1, mix(skD, '#6A5AA8', 0.4)); R(29, 25, 3, 1, mix(skD, '#6A5AA8', 0.4));
    R(38, 36, 7, 9, '#F1ECFF'); R(39, 37, 5, 2, '#5A3420'); R(45, 38, 2, 4, '#F1ECFF'); R(38, 44, 7, 1, '#BFB6DA'); P(41, 33, '#DCD6EE'); P(42, 31, '#DCD6EE');
  }
  if (gag === 'intern') {
    R(20, 29, 9, 3, '#3A0E1E'); R(21, 29, 7, 1, '#FFFFFF'); P(19, 28, INK); P(29, 28, INK);
    R(17, 38, 1, 10, '#FF3EA5'); R(30, 38, 1, 10, '#FF3EA5'); R(21, 44, 6, 4, '#2EE6F0'); R(22, 45, 4, 1, '#0B0714');
    R(39, 34, 6, 10, '#151022'); R(40, 35, 4, 7, '#7CF5B4'); E(42, 30, 4, 4, '#FFF6C8'); E(42, 30, 2.4, 2.4, '#151022');
  }
  if (gag === 'guru') {
    R(12, 14, 24, 3, '#FF3EA5'); R(12, 15, 24, 1, '#FF7CC4'); R(35, 15, 3, 2, '#FF3EA5'); R(37, 17, 2, 5, '#FF3EA5');
    R(33, 26, 6, 1, '#2A2440'); R(33, 26, 1, 3, '#2A2440'); R(30, 28, 4, 2, '#2A2440');
    for (let i = 0; i < 6; i++) P(18 + i * 2, 38 + (i % 2), ['#FFC75A', '#7CF5B4', '#9B5CFF'][i % 3]!);
  }
  if (L.prop === 'coffee' && gag !== 'frazzled') {
    R(38, 37, 7, 9, '#F1ECFF'); R(39, 38, 5, 2, '#5A3420'); R(45, 39, 2, 4, '#F1ECFF'); R(38, 45, 7, 1, '#BFB6DA'); P(40, 34, '#DCD6EE'); P(42, 32, '#DCD6EE');
  }
  if (gag === 'clipboard') {
    R(34, 33, 13, 15, '#7A4A22'); R(35, 35, 11, 13, '#F4F0FF'); R(38, 32, 5, 3, '#9AA0B8'); R(39, 31, 3, 1, '#9AA0B8');
    for (let y = 37; y < 47; y += 2) R(37, y, 7, 1, '#9A94B8');
    R(37, 37, 2, 1, '#7CF5B4'); R(37, 41, 2, 1, '#FF5C7A'); R(33, 44, 4, 2, skin); R(33, 43, 3, 1, skS);
  }

  // selective outline: each empty pixel touching the figure becomes a dark version of its neighbour, then a hard ink rim
  const out = px.slice();
  for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
    if (px[y * PW + x]) continue;
    for (const [dx, dy] of [[0, 1], [1, 0], [-1, 0], [0, -1]] as const) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= PW || ny >= PH) continue;
      const q = px[ny * PW + nx];
      if (q) { out[y * PW + x] = mix(q, INK, 0.85); break; }
    }
  }
  const cv = document.createElement('canvas'); cv.width = PW; cv.height = PH;
  const g = cv.getContext('2d')!; const id = g.createImageData(PW, PH);
  out.forEach((col, i) => {
    if (!col) return;
    const n = parseInt(col.slice(1, 7), 16);
    id.data[i * 4] = n >> 16; id.data[i * 4 + 1] = (n >> 8) & 255; id.data[i * 4 + 2] = n & 255; id.data[i * 4 + 3] = 255;
  });
  g.putImageData(id, 0, 0);
  return cv;
}
