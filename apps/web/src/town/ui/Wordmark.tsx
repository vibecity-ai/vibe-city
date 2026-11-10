/* The Vibe City wordmark ("Lit Window", see the design teardown): geometric pixel capitals on the same grid as the
   city, with softened outside corners, and a lit window in the counter of the B, the window that glows in every
   office. Drawn from the bitmaps below as one masked shape, so no font is involved and joins have no seams. The
   window lights up when the sign appears, then glows. */
import { useId } from 'react';

const G: Record<string, string[]> = {
  V: ['1100011', '1100011', '1100011', '1100011', '0110110', '0110110', '0011100', '0011100'],
  I: ['11', '11', '11', '11', '11', '11', '11', '11'],
  B: ['1111100', '1100110', '1100110', '1111111', '1100011', '1100011', '1100011', '1111111'],
  E: ['1111111', '1100000', '1100000', '1111100', '1100000', '1100000', '1100000', '1111111'],
  C: ['1111111', '1100000', '1100000', '1100000', '1100000', '1100000', '1100000', '1111111'],
  T: ['1111111', '0011100', '0011100', '0011100', '0011100', '0011100', '0011100', '0011100'],
  Y: ['1100011', '1100011', '1100011', '1111111', '0011100', '0011100', '0011100', '0011100'],
  ' ': ['00', '00', '00', '00', '00', '00', '00', '00'],
};

/** Lay the text out on one grid; also returns where the B's upper counter is (for the window). */
function lay(text: string) {
  const cells: [number, number][] = []; let x = 0, win: [number, number] = [0, 0];
  for (const ch of text) {
    const g = G[ch]!;
    if (ch === 'B') win = [x + 3, 2];
    g.forEach((row, y) => [...row].forEach((c, i) => { if (c === '1') cells.push([x + i, y]); }));
    x += g[0]!.length + 1;
  }
  return { cells, w: x - 1, h: 8, win };
}
const WORD = lay('VIBE CITY');

/** The outside corners of the shape, cut back to quarter circles (inside corners stay sharp, like a cut sign). */
function notches(cells: [number, number][], r = 0.42) {
  const on = new Set(cells.map(([x, y]) => `${x},${y}`)), has = (x: number, y: number) => on.has(`${x},${y}`);
  const d: string[] = [];
  const cut = (cx: number, cy: number, sx: number, sy: number) => d.push(`M${cx} ${cy}h${sx * r}Q${cx} ${cy} ${cx} ${cy + sy * r}Z`);
  for (const [x, y] of cells) {
    if (!has(x - 1, y) && !has(x, y - 1)) cut(x, y, 1, 1);
    if (!has(x + 1, y) && !has(x, y - 1)) cut(x + 1, y, -1, 1);
    if (!has(x + 1, y) && !has(x, y + 1)) cut(x + 1, y + 1, -1, -1);
    if (!has(x - 1, y) && !has(x, y + 1)) cut(x, y + 1, 1, -1);
  }
  return d.join('');
}
const CELLS = WORD.cells.map(([x, y]) => `M${x - 0.01} ${y - 0.01}h1.02v1.02h-1.02Z`).join('');
const CUTS = notches(WORD.cells);

export function Wordmark({ height = 36, className = '' }: { height?: number; className?: string }) {
  const id = useId().replace(/:/g, '');
  const pad = 1, W = WORD.w + pad * 2, H = WORD.h + pad * 2;
  const [wx, wy] = WORD.win;
  return (
    <svg className={`wordmark ${className}`} viewBox={`${-pad} ${-pad} ${W} ${H}`} height={height} width={(height * W) / H} role="img" aria-label="Vibe City">
      <defs>
        <linearGradient id={`${id}f`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#FF6CBC" /><stop offset=".55" stopColor="#FF3EA5" /><stop offset="1" stopColor="#E0187A" /></linearGradient>
        <mask id={`${id}m`} maskUnits="userSpaceOnUse" x={-pad} y={-pad} width={W} height={H}>
          <path d={CELLS} fill="#fff" /><path d={CUTS} fill="#000" />
        </mask>
        <filter id={`${id}g`} x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation=".6" /></filter>
      </defs>
      <rect x={-pad} y={-pad} width={W} height={H} fill={`url(#${id}f)`} mask={`url(#${id}m)`} />
      <g className="wm-win">
        <rect x={wx - 0.75} y={wy - 0.75} width="1.5" height="1.5" fill="#FFD166" transform={`rotate(45 ${wx} ${wy})`} filter={`url(#${id}g)`} opacity=".8" />
        <rect x={wx - 0.6} y={wy - 0.6} width="1.2" height="1.2" fill="#FFE7A6" transform={`rotate(45 ${wx} ${wy})`} />
      </g>
    </svg>
  );
}

