/* Pixel frames for the HUD. Each frame is a tiny pixel-art 9-slice (SVG, crisp edges) used as a
   border-image: a 2px border with pixel-rounded corners, a 1px bevel (lit top-left, shaded
   bottom-right) and the fill. Generated once at startup as CSS custom properties --fr-<name>. */
type Spec = [border: string, hi: string, lo: string, fill: string];
const FULL: Record<string, Spec> = {
  panel: ['#3A2D66', '#2C2253', '#100A1F', '#1A1130'],
  glass: ['#4A3D86', 'rgba(255,255,255,0.06)', 'rgba(0,0,0,0.35)', 'rgba(18,11,36,0.9)'],
  raised: ['#3A2D66', '#3B306E', '#120C22', '#1E1538'],
  pink: ['#3A0A26', '#FF9AD0', '#C2237C', '#FF3EA5'],
  pinkHi: ['#3A0A26', '#FFC6E6', '#D82C8C', '#FF5CB3'],
  pinkLo: ['#3A0A26', '#B81F72', '#FF7AC0', '#E8318F'],
  cyan: ['#2EE6F0', '#1F5E6E', '#04131A', '#0C2230'],
  cyanHi: ['#8FF6FB', '#2B7A88', '#04131A', '#123444'],
  sel: ['#2EE6F0', '#2B7A88', '#062030', '#0E2D3D'],
  tert: ['#4A3D86', '#3E336F', '#0E0820', '#1E1538'],
  tertHi: ['#7A6CC0', '#4A3E80', '#0E0820', '#251B44'],
  tertLo: ['#4A3D86', '#0E0820', '#3E336F', '#170F2E'],
  gold: ['#C9A45A', '#4A3820', '#120C06', '#22180E'],
  goldSel: ['#FFC75A', '#6B5530', '#120C06', '#2E2210'],
  amber: ['#FFB547', '#5A401C', '#140E06', '#261C10'],
  red: ['#FF5C7A', '#4A1A2A', '#12060C', '#26102A'],
  redBtn: ['#FF5C7A', '#5A2234', '#12060C', '#2A0F1C'],
  mint: ['#7CF5B4', '#1E5A44', '#06140E', '#0F2A20'],
  well: ['#2A1F4D', '#07040F', '#2E2458', '#0D0819'],
  wellFocus: ['#2EE6F0', '#07040F', '#1F5E6E', '#0D0819'],
  eq: ['#FF3EA5', '#5A1A48', '#14061A', '#2A0F2A'],
};
type Thin = [border: string, fill: string];
const THIN: Record<string, Thin> = {
  line: ['#3A2D66', '#1A1130'],
  lineHi: ['#6A5CB0', '#221840'],
  glass: ['#4A3D86', 'rgba(11,7,22,0.86)'],
  cyan: ['#2EE6F0', '#0E2D3D'],
  gold: ['#8A6A30', 'rgba(30,20,10,0.92)'],
  well: ['#2A1F4D', '#0D0819'],
  pink: ['#FF3EA5', '#2A0F2A'],
};

function svg(rows: string[], cols: Record<string, string>) {
  let r = '';
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const c = row[x]; let w = 1;
      while (x + w < row.length && row[x + w] === c) w++;
      if (c !== '.') r += `<rect x='${x}' y='${y}' width='${w}' height='1' fill='${cols[c]}'/>`;
      x += w;
    }
  });
  const s = `<svg xmlns='http://www.w3.org/2000/svg' width='${rows[0].length}' height='${rows.length}' shape-rendering='crispEdges'>${r}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(s)}")`;
}
const FULL_MAP = ['..bbbbbb..', '.bbbbbbbb.', 'bbhhhhhhbb', 'bbhffffsbb', 'bbhffffsbb', 'bbhffffsbb', 'bbhffffsbb', 'bbssssssbb', '.bbbbbbbb.', '..bbbbbb..'];
const THIN_MAP = ['.bbbb.', 'bffffb', 'bffffb', 'bffffb', 'bffffb', '.bbbb.'];

export function installFrames() {
  const root = document.documentElement.style;
  for (const [k, [b, h, s, f]] of Object.entries(FULL)) root.setProperty('--fr-' + k, svg(FULL_MAP, { b, h, s, f }));
  for (const [k, [b, f]] of Object.entries(THIN)) root.setProperty('--tn-' + k, svg(THIN_MAP, { b, f }));
}
