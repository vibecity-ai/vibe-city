/* Pixel raster + HD-2D lighting pipeline.

   The world is drawn into a low-res "art pixel" buffer (A = albedo) with our own scanline fills, so
   every edge lands on the pixel grid like hand-made pixel art (no canvas anti-aliasing). Alongside it
   we draw an emissive mask (M): white where a surface glows (screens, neon, windows, sky), black where
   a matte surface covers it. Lights are soft gradients in a light buffer (L). The frame is then
   A x max(L, M), bloomed from the bright emissive pixels, and finished with tilt-shift depth of field,
   colour grade, vignette and grain — the Octopath "HD-2D" recipe on a 2D canvas. */
export type Ctx = CanvasRenderingContext2D;
export type Pt = [number, number];

const MASK = Array.from({ length: 21 }, (_, i) => { const v = Math.round((i / 20) * 255); return `rgb(${v},${v},${v})`; });
const xs = new Float64Array(64);
const tx = new Float64Array(64), ty = new Float64Array(64);
const UNLIT = new Map<string, string>();
function unlit(hex: string, k: number) {
  const key = hex + k.toFixed(2); let v = UNLIT.get(key); if (v) return v;
  const n = parseInt(hex.slice(1), 16), t = 0.72 * k, d = [0x16, 0x10, 0x2C];
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((x, i) => Math.round(x * (1 - t) + d[i] * t));
  v = '#' + c.map((x) => x.toString(16).padStart(2, '0')).join(''); UNLIT.set(key, v); return v;
}
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

export class Pix {
  a!: Ctx; m!: Ctx; bs = 1; ox = 0; oy = 0; w = 0; h = 0;
  alpha = 1; private stack: number[] = [];
  /** Multiplies every emissive value: 1 = powered, ~0 = lights out (glow becomes plain lit paint). */
  emScale = 1;
  /** When set, draw calls only grow this world-space bbox [minX, minY, maxX, maxY] (used to size baked props). */
  meas: number[] | null = null;
  private grow(x: number, y: number, r = 0) { const b = this.meas!; if (x - r < b[0]) b[0] = x - r; if (y - r < b[1]) b[1] = y - r; if (x + r > b[2]) b[2] = x + r; if (y + r > b[3]) b[3] = y + r; }
  private pats = new Map<string, CanvasPattern>();

  target(a: Ctx, m: Ctx, bs: number, ox: number, oy: number, w: number, h: number) {
    this.a = a; this.m = m; this.bs = bs; this.ox = ox; this.oy = oy; this.w = w; this.h = h;
    for (const c of [a, m]) { c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 1; c.globalCompositeOperation = 'source-over'; c.imageSmoothingEnabled = false; }
    this.alpha = 1; this.stack.length = 0;
  }
  push(k: number) { this.stack.push(this.alpha); this.alpha *= k; this.a.globalAlpha = this.m.globalAlpha = this.alpha; }
  pop() { this.alpha = this.stack.pop() ?? 1; this.a.globalAlpha = this.m.globalAlpha = this.alpha; }
  X(x: number) { return x * this.bs - this.ox; }
  Y(y: number) { return y * this.bs - this.oy; }

  /** em: 0 matte, (0,1] glows that much, -1 leaves the mask alone (shadows, tints). */
  private style(col: string, em: number) {
    // lights out: glowing paint (neon, lit glass, screens) falls to an unlit, dark version of itself
    this.a.fillStyle = this.emScale < 1 && em > 0.05 && em <= 1 && col[0] === '#' && col.length === 7 ? unlit(col, Math.min(1, em) * (1 - this.emScale)) : col;
    if (em >= 0) this.m.fillStyle = MASK[Math.max(0, Math.min(20, Math.round(Math.min(1, em * this.emScale) * 20)))];
  }
  private span(x: number, y: number, w: number, em: number) {
    this.a.fillRect(x, y, w, 1); if (em >= 0) this.m.fillRect(x, y, w, 1);
  }

  /** Scanline polygon fill (even-odd), edges snapped to the art-pixel grid. */
  poly(pts: Pt[], col: string, em = 0) {
    const n = pts.length; if (n < 3) return;
    if (this.meas) { for (const p of pts) this.grow(p[0], p[1]); return; }
    const bs = this.bs, ox = this.ox, oy = this.oy;
    let minY = 1e9, maxY = -1e9, minX = 1e9, maxX = -1e9;
    for (let i = 0; i < n; i++) {
      const x = pts[i][0] * bs - ox, y = pts[i][1] * bs - oy; tx[i] = x; ty[i] = y;
      if (y < minY) minY = y; if (y > maxY) maxY = y; if (x < minX) minX = x; if (x > maxX) maxX = x;
    }
    if (maxX < 0 || minX > this.w || maxY < 0 || minY > this.h) return;
    this.style(col, em);
    const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(this.h - 1, Math.ceil(maxY));
    for (let y = y0; y <= y1; y++) {
      const yc = y + 0.5; let c = 0;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const yi = ty[i], yj = ty[j];
        if ((yi <= yc) !== (yj <= yc)) xs[c++] = tx[i] + ((yc - yi) * (tx[j] - tx[i])) / (yj - yi);
      }
      if (c < 2) continue;
      for (let i = 1; i < c; i++) { const v = xs[i]; let j = i - 1; while (j >= 0 && xs[j] > v) { xs[j + 1] = xs[j]; j--; } xs[j + 1] = v; }
      for (let k = 0; k + 1 < c; k += 2) {
        let xa = Math.round(xs[k]), xb = Math.round(xs[k + 1]);
        if (xa < 0) xa = 0; if (xb > this.w) xb = this.w;
        if (xb > xa) this.span(xa, y, xb - xa, em);
      }
    }
  }
  /** Darken what is already there (soft shadows, ambient occlusion). Albedo only. */
  shade(pts: Pt[], alpha: number, col = '#0B0716') {
    const ga = this.a.globalAlpha; this.a.globalAlpha = ga * alpha; this.poly(pts, col, -1); this.a.globalAlpha = ga;
  }
  /** Ordered-dither fill: level 0..1 of pixels coloured (Bayer 4x4), anchored to the world grid. */
  dither(pts: Pt[], col: string, level: number, em = 0) {
    if (this.meas) { for (const p of pts) this.grow(p[0], p[1]); return; }
    const lv = Math.max(0, Math.min(16, Math.round(level * 16))); if (lv === 0) return; if (lv === 16) return this.poly(pts, col, em);
    if (this.emScale < 1 && em > 0.05 && em <= 1 && col[0] === '#' && col.length === 7) col = unlit(col, Math.min(1, em) * (1 - this.emScale));
    em = em >= 0 ? Math.min(1, em * this.emScale) : em;
    const key = col + lv + ':' + em;
    let pa = this.pats.get(key), pm = this.pats.get('m' + lv + ':' + em);
    if (!pa) {
      const mk = (c: string) => { const cv = document.createElement('canvas'); cv.width = cv.height = 4; const g = cv.getContext('2d')!; g.fillStyle = c; for (let i = 0; i < 16; i++) if (BAYER[i] < lv) g.fillRect(i % 4, i >> 2, 1, 1); return g.createPattern(cv, 'repeat')!; };
      pa = mk(col); this.pats.set(key, pa);
      if (em >= 0) { pm = mk(MASK[Math.round(em * 20)]); this.pats.set('m' + lv + ':' + em, pm); }
    }
    const m = new DOMMatrix([1, 0, 0, 1, (((-Math.round(this.ox)) % 4) + 4) % 4, (((-Math.round(this.oy)) % 4) + 4) % 4]);
    pa.setTransform(m); if (pm) pm.setTransform(m);
    const fa = this.a.fillStyle, fm = this.m.fillStyle;
    // poly() sets fillStyle from a colour string; patch it by drawing with the pattern directly
    const save = this.style; this.style = (_c: string, e: number) => { this.a.fillStyle = pa!; if (e >= 0 && pm) this.m.fillStyle = pm; };
    this.poly(pts, col, em >= 0 ? em : -1);
    this.style = save; this.a.fillStyle = fa; this.m.fillStyle = fm;
  }
  /** Pixel line with run merging (2:1 iso lines come out as clean 2-pixel stairs). */
  line(p: Pt, q: Pt, col: string, lw = 1, em = 0, dash?: [number, number], dashOff = 0) {
    if (this.meas) { this.grow(p[0], p[1], lw + 1); this.grow(q[0], q[1], lw + 1); return; }
    let x0 = this.X(p[0]), y0 = this.Y(p[1]), x1 = this.X(q[0]), y1 = this.Y(q[1]);
    if (Math.max(x0, x1) < -2 || Math.min(x0, x1) > this.w + 2 || Math.max(y0, y1) < -2 || Math.min(y0, y1) > this.h + 2) return;
    if (!dash) {
      const dx = x1 - x0, dy = y1 - y0; let t0 = 0, t1 = 1;
      const clip = (pp: number, qq: number) => { if (pp === 0) return qq >= 0; const r = qq / pp; if (pp < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; } return true; };
      if (!(clip(-dx, x0 + 4) && clip(dx, this.w + 4 - x0) && clip(-dy, y0 + 4) && clip(dy, this.h + 4 - y0))) return;
      if (t1 < 1) { x1 = x0 + dx * t1; y1 = y0 + dy * t1; }
      if (t0 > 0) { x0 = x0 + dx * t0; y0 = y0 + dy * t0; }
    }
    const t = Math.max(1, Math.round(lw * this.bs)), o = t >> 1;
    this.style(col, em);
    const per = dash ? dash[0] + dash[1] : 0;
    const on = (i: number) => !dash || ((((i + dashOff) % per) + per) % per) < dash[0];
    if (Math.abs(x1 - x0) >= Math.abs(y1 - y0)) {
      if (x1 < x0) { [x0, x1] = [x1, x0]; [y0, y1] = [y1, y0]; }
      const xa = Math.floor(x0), xb = Math.max(xa, Math.floor(x1 - 1e-6)), sl = x1 === x0 ? 0 : (y1 - y0) / (x1 - x0);
      let rs = -1, ry = 0;
      for (let x = xa; x <= xb + 1; x++) {
        const live = x <= xb && on(x - xa);
        const py = Math.floor(y0 + (x + 0.5 - x0) * sl);
        if (rs >= 0 && (!live || py !== ry)) { this.rect0(rs, ry - o, x - rs, t, em); rs = -1; }
        if (live && rs < 0) { rs = x; ry = py; }
      }
    } else {
      if (y1 < y0) { [x0, x1] = [x1, x0]; [y0, y1] = [y1, y0]; }
      const ya = Math.floor(y0), yb = Math.max(ya, Math.floor(y1 - 1e-6)), sl = (x1 - x0) / (y1 - y0);
      let rs = -1, rx = 0;
      for (let y = ya; y <= yb + 1; y++) {
        const live = y <= yb && on(y - ya);
        const px = Math.floor(x0 + (y + 0.5 - y0) * sl);
        if (rs >= 0 && (!live || px !== rx)) { this.rect0(rx - o, rs, t, y - rs, em); rs = -1; }
        if (live && rs < 0) { rs = y; rx = px; }
      }
    }
  }
  private rect0(x: number, y: number, w: number, h: number, em: number) {
    this.a.fillRect(x, y, w, h); if (em >= 0) this.m.fillRect(x, y, w, h);
  }
  /** World-aligned rectangle (min one art pixel). */
  rect(x: number, y: number, w: number, h: number, col: string, em = 0) {
    if (this.meas) { this.grow(x, y); this.grow(x + w + 1, y + h + 1); return; }
    const X0 = Math.round(this.X(x)), Y0 = Math.round(this.Y(y));
    const X1 = Math.max(X0 + 1, Math.round(this.X(x + w))), Y1 = Math.max(Y0 + 1, Math.round(this.Y(y + h)));
    if (X1 < 0 || X0 > this.w || Y1 < 0 || Y0 > this.h) return;
    this.style(col, em); this.rect0(X0, Y0, X1 - X0, Y1 - Y0, em);
  }
  dot(x: number, y: number, col: string, em = 0, s = 1) { this.rect(x, y, s, s, col, em); }
  ellipse(cx: number, cy: number, rx: number, ry: number, col: string, em = 0) {
    if (this.meas) { this.grow(cx - rx - 1, cy - ry - 1); this.grow(cx + rx + 1, cy + ry + 1); return; }
    const CX = this.X(cx), CY = this.Y(cy), RX = rx * this.bs, RY = Math.max(0.5, ry * this.bs);
    if (CX + RX < 0 || CX - RX > this.w || CY + RY < 0 || CY - RY > this.h) return;
    this.style(col, em);
    const y0 = Math.max(0, Math.floor(CY - RY)), y1 = Math.min(this.h - 1, Math.ceil(CY + RY));
    for (let y = y0; y <= y1; y++) {
      const d = (y + 0.5 - CY) / RY; if (Math.abs(d) > 1) continue;
      const hw = RX * Math.sqrt(1 - d * d), xa = Math.max(0, Math.round(CX - hw)), xb = Math.min(this.w, Math.round(CX + hw));
      if (xb > xa) this.span(xa, y, xb - xa, em);
    }
  }
  shadeEllipse(cx: number, cy: number, rx: number, ry: number, alpha: number) {
    const ga = this.a.globalAlpha; this.a.globalAlpha = ga * alpha; this.ellipse(cx, cy, rx, ry, '#0B0716', -1); this.a.globalAlpha = ga;
  }
  ring(cx: number, cy: number, rx: number, ry: number, col: string, lw = 1, em = 0, dash?: [number, number], off = 0) {
    if (this.meas) { this.grow(cx - rx - lw, cy - ry - lw); this.grow(cx + rx + lw, cy + ry + lw); return; }
    const CX = this.X(cx), CY = this.Y(cy), RX = rx * this.bs, RY = ry * this.bs, t = Math.max(1, Math.round(lw * this.bs));
    const n = Math.max(12, Math.ceil(Math.PI * 2 * Math.max(RX, RY)));
    this.style(col, em);
    let lx = 1e9, ly = 1e9;
    for (let i = 0; i < n; i++) {
      if (dash && ((((i + off) % (dash[0] + dash[1])) + dash[0] + dash[1]) % (dash[0] + dash[1])) >= dash[0]) continue;
      const a = (i / n) * Math.PI * 2, x = Math.floor(CX + Math.cos(a) * RX), y = Math.floor(CY + Math.sin(a) * RY);
      if (x === lx && y === ly) continue; lx = x; ly = y;
      this.rect0(x, y, t, t, em);
    }
  }
  /** Blit a prebuilt sprite; its silhouette clears the emissive mask behind it. */
  sprite(img: HTMLCanvasElement, sil: HTMLCanvasElement | null, x: number, y: number, flip = false, em = 0) {
    if (this.meas) { this.grow(x, y); this.grow(x + img.width, y + img.height); return; }
    const X = Math.round(this.X(x)), Y = Math.round(this.Y(y)), w = Math.max(1, Math.round(img.width * this.bs)), h = Math.max(1, Math.round(img.height * this.bs));
    if (X + w < 0 || X > this.w || Y + h < 0 || Y > this.h) return;
    const one = (c: Ctx, im: HTMLCanvasElement) => {
      if (flip) { c.save(); c.translate(X + w, Y); c.scale(-1, 1); c.drawImage(im, 0, 0, w, h); c.restore(); }
      else c.drawImage(im, X, Y, w, h);
    };
    one(this.a, img);
    em = Math.min(1, em * this.emScale);
    if (em > 0.01) { const ga = this.m.globalAlpha; this.m.globalAlpha = ga * em; this.m.globalCompositeOperation = 'lighter'; one(this.m, sil ?? img); this.m.globalCompositeOperation = 'source-over'; this.m.globalAlpha = ga; }
    else if (sil) one(this.m, sil);
  }
  /** Draw a cached layer (world-space rect) into both buffers. */
  layer(ca: HTMLCanvasElement, cm: HTMLCanvasElement, x: number, y: number) {
    const X = Math.round(this.X(x)), Y = Math.round(this.Y(y));
    if (this.bs === 1) { this.a.drawImage(ca, X, Y); this.m.drawImage(cm, X, Y); }
    else { const w = Math.round(ca.width * this.bs), h = Math.round(ca.height * this.bs); this.a.drawImage(ca, X, Y, w, h); this.m.drawImage(cm, X, Y, w, h); }
  }
  /** Native anti-aliased stroke: cheap for long, faint lines (ground grid). */
  aline(p: Pt, q: Pt, col: string, em = 0) {
    if (this.meas) { this.grow(p[0], p[1]); this.grow(q[0], q[1]); return; }
    for (const c of em >= 0 ? [this.a, this.m] : [this.a]) {
      c.beginPath(); c.moveTo(this.X(p[0]), this.Y(p[1])); c.lineTo(this.X(q[0]), this.Y(q[1]));
      c.strokeStyle = c === this.a ? col : MASK[Math.round(Math.max(0, Math.min(1, em)) * 20)]; c.lineWidth = 1; c.stroke();
    }
  }
  /** Soft native gradient polygon (light beams, haze): colour fades from a0 at p to a1 at q. */
  glow(pts: Pt[], col: string, a0: number, a1: number, p: Pt, q: Pt, em = 1) {
    if (this.meas) { for (const pt of pts) this.grow(pt[0], pt[1]); return; }
    const [R, G, B] = rgb(col);
    for (const c of [this.a, this.m]) {
      const isM = c === this.m, cc = isM ? '255,255,255' : `${R},${G},${B}`, k = isM ? em : 1;
      if (k <= 0) continue;
      const g = c.createLinearGradient(this.X(p[0]), this.Y(p[1]), this.X(q[0]), this.Y(q[1]));
      g.addColorStop(0, `rgba(${cc},${a0 * k})`); g.addColorStop(1, `rgba(${cc},${a1 * k})`);
      c.fillStyle = g; c.beginPath();
      pts.forEach((pt, i) => (i ? c.lineTo(this.X(pt[0]), this.Y(pt[1])) : c.moveTo(this.X(pt[0]), this.Y(pt[1]))));
      c.closePath(); c.fill();
    }
  }
  /** Mirror a baked layer below a water line in rippling 3-unit slices. */
  reflect(b: Baked, axis: number, depth: number, alpha: number, t: number) {
    if (this.meas) return;
    const step = 3, ga = this.alpha;
    for (let k = 0; k < depth; k += step) {
      const sy = axis - k - step - b.y0; if (sy < 0 || sy + step > b.a.height) continue;
      const Y = Math.round(this.Y(axis + k)), h = Math.max(1, Math.round(step * this.bs));
      if (Y > this.h || Y + h < 0) continue;
      const off = Math.sin(k * 0.35 + t * 2.2) * (1 + k * 0.035);
      const X = Math.round(this.X(b.x0 + off)), w = Math.round(b.a.width * this.bs);
      const f = alpha * (1 - k / depth);
      this.a.globalAlpha = ga * f; this.a.drawImage(b.a, 0, sy, b.a.width, step, X, Y, w, h);
      this.m.globalAlpha = ga * f * 0.8; this.m.drawImage(b.m, 0, sy, b.m.width, step, X, Y, w, h);
    }
    this.a.globalAlpha = this.m.globalAlpha = ga;
  }
  /** 3x5 pixel font on any plane: map(a, b) -> world point, a = along the text, b = down. */
  text(str: string, map: (a: number, b: number) => Pt, s: number, col: string, em = 0, track = 1) {
    let a = 0;
    for (const ch of str.toUpperCase()) {
      const g = FONT[ch] ?? FONT[' '];
      for (let j = 0; j < 5; j++) for (let i = 0; i < 3; i++) if (g[j * 3 + i] === '1') {
        const x0 = a + i * s, y0 = j * s;
        this.poly([map(x0, y0), map(x0 + s, y0), map(x0 + s, y0 + s), map(x0, y0 + s)], col, em);
      }
      a += (3 + track) * s;
    }
    return a;
  }
}
export const textWidth = (str: string, s: number, track = 1) => str.length * (3 + track) * s - track * s;

/** Static props rendered once into their own A/M canvases at 1 art pixel per unit, then blitted. */
export interface Baked { a: HTMLCanvasElement; m: HTMLCanvasElement; x0: number; y0: number }
export class Bakery {
  private map = new Map<string, Baked>();
  private px = new Pix();
  /** Applied to everything baked while set (lights-out variants are cached separately). */
  emScale = 1;
  get(key: string, fn: (px: Pix) => void): Baked {
    if (this.emScale !== 1) key += '|e' + this.emScale;
    let b = this.map.get(key); if (b) return b;
    const px = this.px; px.emScale = this.emScale; px.meas = [1e9, 1e9, -1e9, -1e9]; fn(px); const m = px.meas; px.meas = null;
    const x0 = Math.floor(m[0]) - 2, y0 = Math.floor(m[1]) - 2, w = Math.max(1, Math.ceil(m[2]) - x0 + 3), h = Math.max(1, Math.ceil(m[3]) - y0 + 3);
    const a = document.createElement('canvas'), mm = document.createElement('canvas'); a.width = mm.width = w; a.height = mm.height = h;
    px.target(a.getContext('2d')!, mm.getContext('2d')!, 1, x0, y0, w, h); fn(px);
    b = { a, m: mm, x0, y0 }; this.map.set(key, b);
    if (this.map.size > 600) { const k = this.map.keys().next().value; if (k) this.map.delete(k); }
    return b;
  }
  /** Draw a baked prop with its local origin moved by (dx, dy). */
  draw(px: Pix, b: Baked, dx = 0, dy = 0) { px.layer(b.a, b.m, b.x0 + dx, b.y0 + dy); }
  drop(prefix: string) { for (const k of [...this.map.keys()]) if (k.startsWith(prefix)) this.map.delete(k); }
}

const FONT: Record<string, string> = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111', F: '111100110100100',
  G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010', K: '101101110101101', L: '100100100100111',
  M: '101111111101101', N: '110101101101101', O: '010101101101010', P: '110101110100100', Q: '010101101110011', R: '110101110101101',
  S: '011100010001110', T: '111010010010010', U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101',
  Y: '101101010010010', Z: '111001010100111', '0': '111101101101111', '1': '010110010010111', '2': '110001010100111', '3': '110001010001110',
  '4': '101101111001001', '5': '111100110001110', '6': '011100110101010', '7': '111001010010010', '8': '010101010101010', '9': '010101011001110',
  ' ': '000000000000000', '-': '000000111000000', '&': '010101010101011', '.': '000000000000010', ':': '000010000010000', '·': '000000010000000',
};

/* ---------------- lights ---------------- */
const RGB = new Map<string, [number, number, number]>();
export function rgb(hex: string): [number, number, number] {
  let v = RGB.get(hex); if (v) return v;
  const n = parseInt(hex.slice(1, 7), 16); v = [n >> 16, (n >> 8) & 255, n & 255]; RGB.set(hex, v); return v;
}
interface Light { x: number; y: number; r: number; c: string; i: number; sy: number }
export class Lights {
  L!: Ctx; bs = 1; ox = 0; oy = 0; w = 0; h = 0; list: Light[] = []; scale = 1;
  begin(L: Ctx, bs: number, ox: number, oy: number, w: number, h: number, ambient: string) {
    this.L = L; this.bs = bs; this.ox = ox; this.oy = oy; this.w = w; this.h = h; this.list.length = 0; this.scale = 1;
    L.setTransform(1, 0, 0, 1, 0, 0); L.globalAlpha = 1; L.globalCompositeOperation = 'source-over';
    L.fillStyle = ambient; L.fillRect(0, 0, w, h);
    L.setTransform(bs, 0, 0, bs, -ox, -oy); L.globalCompositeOperation = 'lighter';
  }
  /** Soft radial light; sy squashes it onto the floor plane (0.5 = iso ground). */
  add(x: number, y: number, r: number, c: string, i: number, sy = 0.5) {
    if (i <= 0.003 || r <= 0) return;
    const X = x * this.bs - this.ox, Y = y * this.bs - this.oy, R = r * this.bs;
    if (X + R < 0 || X - R > this.w || Y + R < 0 || Y - R > this.h) return;
    const l = { x, y, r, c, i: i * this.scale, sy }; this.list.push(l); this.paint(this.L, l, 1);
  }
  paint(ctx: Ctx, l: Light, k: number) {
    const [R, G, B] = rgb(l.c);
    ctx.save(); ctx.translate(l.x, l.y); ctx.scale(1, l.sy);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, l.r);
    g.addColorStop(0, `rgba(${R},${G},${B},${Math.min(1, l.i * k)})`);
    g.addColorStop(0.3, `rgba(${R},${G},${B},${Math.min(1, l.i * k * 0.55)})`);
    g.addColorStop(0.65, `rgba(${R},${G},${B},${Math.min(1, l.i * k * 0.16)})`);
    g.addColorStop(1, `rgba(${R},${G},${B},0)`);
    ctx.fillStyle = g; ctx.fillRect(-l.r, -l.r, l.r * 2, l.r * 2); ctx.restore();
  }
  /** Flat additive polygon with a linear falloff from p to q (light shafts, window spill). */
  shaft(pts: Pt[], c: string, i0: number, i1: number, p: Pt, q: Pt) {
    const [R, G, B] = rgb(c), L = this.L;
    const g = L.createLinearGradient(p[0], p[1], q[0], q[1]);
    g.addColorStop(0, `rgba(${R},${G},${B},${i0 * this.scale})`); g.addColorStop(1, `rgba(${R},${G},${B},${i1 * this.scale})`);
    L.fillStyle = g; L.beginPath(); L.moveTo(pts[0][0], pts[0][1]); for (let k = 1; k < pts.length; k++) L.lineTo(pts[k][0], pts[k][1]); L.closePath(); L.fill();
  }
}

/** Swallows lights while baking static props. */
export class NullLights extends Lights {
  add() {}
  shaft() {}
}
export const NULL_LIGHTS = new NullLights();

/* ---------------- post ---------------- */
const mk = () => { const c = document.createElement('canvas'); c.width = c.height = 1; return c; };
const size = (c: HTMLCanvasElement, w: number, h: number) => { w = Math.max(1, Math.ceil(w)); h = Math.max(1, Math.ceil(h)); if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } return c; };
export class Post {
  A = mk(); M = mk(); L = mk(); G = mk(); G2 = mk(); G4 = mk(); G8 = mk(); T1 = mk(); T2 = mk();
  a = this.A.getContext('2d')!; m = this.M.getContext('2d')!; l = this.L.getContext('2d')!;
  private noise: CanvasPattern | null = null;
  resize(bw: number, bh: number) { for (const c of [this.A, this.M, this.L]) size(c, bw, bh); }
  clear(bg: string) {
    for (const c of [this.a, this.m]) { c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 1; c.globalCompositeOperation = 'source-over'; }
    this.a.fillStyle = bg; this.a.fillRect(0, 0, this.A.width, this.A.height);
    this.m.fillStyle = '#000'; this.m.fillRect(0, 0, this.M.width, this.M.height);
  }
  compose(main: Ctx, lights: Lights, o: { k: number; fx: number; fy: number; Wd: number; Hd: number; tilt: number; bloom: number; t: number; vignette: number }) {
    const { a, m, l } = this, bw = this.A.width, bh = this.A.height;
    // 1. light = max(lights, emissive mask); albedo *= light
    l.setTransform(1, 0, 0, 1, 0, 0); l.globalAlpha = 1; l.globalCompositeOperation = 'lighten'; l.drawImage(this.M, 0, 0); l.globalCompositeOperation = 'source-over';
    a.setTransform(1, 0, 0, 1, 0, 0); a.globalAlpha = 1; a.globalCompositeOperation = 'multiply'; a.drawImage(this.L, 0, 0);
    // 2. hot spots: lights brighten a little past the albedo (screen)
    a.globalCompositeOperation = 'screen'; a.setTransform(lights.bs, 0, 0, lights.bs, -lights.ox, -lights.oy);
    for (const lt of lights.list) lights.paint(a, lt, 0.32);
    a.setTransform(1, 0, 0, 1, 0, 0); a.globalCompositeOperation = 'source-over';
    // 3. bloom source: lit emissive pixels, squared so only bright ones survive
    const g = size(this.G, bw, bh).getContext('2d')!;
    g.globalCompositeOperation = 'copy'; g.drawImage(this.A, 0, 0);
    g.globalCompositeOperation = 'multiply'; g.drawImage(this.M, 0, 0); g.drawImage(this.G, 0, 0);
    g.globalCompositeOperation = 'source-over';
    const down = (src: HTMLCanvasElement, dst: HTMLCanvasElement) => { const c = size(dst, src.width / 2, src.height / 2).getContext('2d')!; c.imageSmoothingEnabled = true; c.globalCompositeOperation = 'copy'; c.drawImage(src, 0, 0, dst.width, dst.height); c.globalCompositeOperation = 'source-over'; };
    down(this.G, this.G2); down(this.G2, this.G4); down(this.G4, this.G8);
    // 4. upscale to the screen: crisp art pixels, soft bloom on top
    const X = -o.fx * o.k, Y = -o.fy * o.k, W = bw * o.k, H = bh * o.k;
    main.setTransform(1, 0, 0, 1, 0, 0); main.globalAlpha = 1; main.globalCompositeOperation = 'source-over';
    main.imageSmoothingEnabled = false; main.drawImage(this.A, X, Y, W, H);
    main.imageSmoothingEnabled = true; main.globalCompositeOperation = 'lighter';
    main.globalAlpha = 0.55 * o.bloom; main.drawImage(this.G2, X, Y, W, H);
    main.globalAlpha = 0.7 * o.bloom; main.drawImage(this.G4, X, Y, W, H);
    main.globalAlpha = 0.85 * o.bloom; main.drawImage(this.G8, X, Y, W, H);
    main.globalAlpha = 1; main.globalCompositeOperation = 'source-over';
    // 5. tilt-shift depth of field: blurred copy faded in at the top and bottom
    if (o.tilt > 0.01) {
      const t1 = size(this.T1, o.Wd / 4, o.Hd / 4).getContext('2d')!, t2 = size(this.T2, o.Wd / 10, o.Hd / 10).getContext('2d')!;
      t1.imageSmoothingEnabled = t2.imageSmoothingEnabled = true;
      t1.globalCompositeOperation = 'copy'; t1.drawImage(main.canvas, 0, 0, this.T1.width, this.T1.height);
      t2.globalCompositeOperation = 'copy'; t2.drawImage(this.T1, 0, 0, this.T2.width, this.T2.height);
      t1.drawImage(this.T2, 0, 0, this.T1.width, this.T1.height);
      t1.globalCompositeOperation = 'destination-in';
      const gr = t1.createLinearGradient(0, 0, 0, this.T1.height);
      gr.addColorStop(0, `rgba(0,0,0,${o.tilt})`); gr.addColorStop(0.24, 'rgba(0,0,0,0)'); gr.addColorStop(0.74, 'rgba(0,0,0,0)'); gr.addColorStop(1, `rgba(0,0,0,${o.tilt})`);
      t1.fillStyle = gr; t1.fillRect(0, 0, this.T1.width, this.T1.height); t1.globalCompositeOperation = 'source-over';
      main.drawImage(this.T1, 0, 0, o.Wd, o.Hd);
    }
    // 6. grade: warm magenta from the top, teal from the bottom
    main.globalCompositeOperation = 'soft-light';
    const gd = main.createLinearGradient(0, 0, 0, o.Hd);
    gd.addColorStop(0, 'rgba(255,90,170,0.32)'); gd.addColorStop(0.5, 'rgba(128,128,128,0)'); gd.addColorStop(1, 'rgba(40,200,230,0.26)');
    main.fillStyle = gd; main.fillRect(0, 0, o.Wd, o.Hd);
    // 7. vignette
    main.globalCompositeOperation = 'source-over';
    const r = Math.hypot(o.Wd, o.Hd) / 2, vg = main.createRadialGradient(o.Wd / 2, o.Hd * 0.48, r * 0.45, o.Wd / 2, o.Hd * 0.48, r);
    vg.addColorStop(0, 'rgba(6,3,16,0)'); vg.addColorStop(1, `rgba(6,3,16,${o.vignette})`);
    main.fillStyle = vg; main.fillRect(0, 0, o.Wd, o.Hd);
    // 8. film grain
    if (!this.noise) {
      const c = document.createElement('canvas'); c.width = c.height = 96; const x = c.getContext('2d')!; const id = x.createImageData(96, 96);
      for (let i = 0; i < id.data.length; i += 4) { const v = 100 + Math.random() * 56; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255; }
      x.putImageData(id, 0, 0); this.noise = main.createPattern(c, 'repeat');
    }
    if (this.noise) {
      main.globalCompositeOperation = 'overlay'; main.globalAlpha = 0.07;
      this.noise.setTransform(new DOMMatrix([1, 0, 0, 1, Math.floor(Math.random() * 96), Math.floor(Math.random() * 96)]));
      main.fillStyle = this.noise; main.fillRect(0, 0, o.Wd, o.Hd);
      main.globalAlpha = 1; main.globalCompositeOperation = 'source-over';
    }
  }
}
