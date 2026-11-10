/* The Executive Office interior (feature spec 3.1): the penthouse opened up like a department floor. It is the
   company's control room, and every object is a control (see EXEC_OBJECTS and ui/ExecRoom.tsx for what each opens).
   Built from the same pieces as a department office (shell, desk, shelf, meeting nook) plus a few exec-only props;
   the wall map is drawn live from the real floors. */
import type { Pt } from './pix';
import { box, chiefDeskStatic, shelfItem, plant, chairItem, C, STATUS_COL, type IC } from './interior';

export { EXEC_OBJECTS, LIBRARY_BOX, type ExecObjectId } from './controls';
export const ASSISTANT_SPOT: Pt = [108, 96];

/** Exec-only static props, drawn on top of the shared shell (baked by the caller). */
export function execProps(c: IC) {
  const { P, px } = c;
  const WL = (v: number, h: number) => P(0, v, h), WR = (u: number, h: number) => P(u, 140, h);
  // elevator doors (closed)
  px.poly([WL(18, 0), WL(34.5, 0), WL(34.5, 42), WL(18, 42)], '#3A3460'); px.poly([WL(35.5, 0), WL(52, 0), WL(52, 42), WL(35.5, 42)], '#332D58');
  px.line(WL(35, 0), WL(35, 42), '#15112A'); px.line(WL(20, 40), WL(33, 40), '#5A52A0'); px.line(WL(37, 40), WL(50, 40), '#5A52A0');
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
  // trophies on top of the shelf
  for (const [v, hh] of [[121, 6], [127, 8], [133, 5]] as Pt[]) {
    box(c, 2, v, 40, 4, 3, 1, '#6B5530', { edge: false });
    box(c, 3, v + 0.5, 41, 2, 2, hh, '#B8862E', { top: C.gold, edge: false });
  }
  // exec chair at the desk (tall back)
  chairItem(c, 32, 111, '#5A2A36', 'seat'); chairItem(c, 32, 111, '#5A2A36', 'back', true);
  void STATUS_COL;
}

/** The skill library: a cabinet of glowing skill cartridges against the back wall, one colour per school. */
const CARTS = ['#C9B8FF', '#FFC75A', '#7CF5B4', '#3EE6FF', '#FF8AD8', '#FFA86B', '#FF5C7A', '#B98CFF', '#6BD1FF', '#A9A3C9'];
export function libraryCabinet(c: IC) {
  const { P, px } = c;
  box(c, 192, 127, 0, 34, 13, 38, '#241A44', { top: '#3A2D66' });
  // four shelves of cartridges on the front face (v = 127)
  for (let r = 0; r < 4; r++) {
    const h = 3 + r * 8.5;
    px.poly([P(193, 127, h - 1), P(225, 127, h - 1), P(225, 127, h), P(193, 127, h)], '#120A24');
    for (let i = 0; i < 7; i++) {
      const u = 194.5 + i * 4.4, col = CARTS[(r * 3 + i * 7) % CARTS.length]!;
      px.poly([P(u, 127, h), P(u + 3, 127, h), P(u + 3, 127, h + 5.5), P(u, 127, h + 5.5)], col, 1);
      px.poly([P(u, 127, h + 4.5), P(u + 3, 127, h + 4.5), P(u + 3, 127, h + 5.5), P(u, 127, h + 5.5)], '#FFFFFF', 1);
    }
  }
  // a sign on top
  box(c, 200, 130, 38, 18, 2, 5, '#3A1050', { top: '#5A1A70', edge: false });
  px.poly([P(201, 130, 39), P(217, 130, 39), P(217, 130, 42), P(201, 130, 42)], C.gold, 1);
}

export function execFurniture(c: IC) {
  libraryCabinet(c);
  chiefDeskStatic(c);
  shelfItem(c);
  plant(c, 84, 132, true, 7); plant(c, 12, 8, true, 11); plant(c, 232, 112, false, 5);
}

/** The template kiosk on the lounge rug: a holo projector fanning three floating floor cards (gold, cyan, pink) that
    bob out of step over a beam. Drawn live because it animates. */
export function templateKiosk(c: IC, lit: boolean) {
  const { P, px, L, t } = c;
  // pedestal: dark plinth, glowing lens ring on top
  box(c, 209, 15, 0, 16, 12, 9, '#241A44', { top: '#3A2D66' });
  box(c, 211, 17, 9, 12, 8, 2, '#1A1234', { top: lit ? '#2EE6F0' : '#2A4A5A', em: lit ? 1 : 0, edge: false });
  for (let k = 0; k < 4; k++) { const d = P(210 + k * 4, 15, 4.5); px.dot(Math.floor(d[0]), Math.floor(d[1]), Math.floor(t * 3 + k) % 4 === 0 ? C.gold : '#5A4E90', lit ? 1 : 0); }
  if (!lit) return;
  // the beam
  px.push(0.45); px.dither([P(212, 19, 11), P(222, 19, 11), P(226, 19, 36), P(208, 19, 36)], C.cyan, 0.35, 1); px.pop();
  // three cards, fanned along the front face, each with a title bar and two "seat" lines
  const cards: [number, string][] = [[205, C.gold], [213, C.cyan], [221, C.pink]];
  cards.forEach(([u, col], i) => {
    const h = 16 + i * 3 + Math.sin(t * 1.8 + i * 2.1) * 1.5, v = 19 - i * 2, w = 9, hh = 12;
    const Q = (du: number, dh: number) => P(u + du, v, h + dh);
    px.push(0.85);
    px.poly([Q(0, 0), Q(w, 0), Q(w, hh), Q(0, hh)], '#120A2A', 1);
    px.poly([Q(0, hh - 3), Q(w, hh - 3), Q(w, hh), Q(0, hh)], col, 1);
    px.line(Q(1.5, hh - 5.5), Q(w - 1.5, hh - 5.5), '#E8FDFF', 1, 1);
    px.line(Q(1.5, hh - 8), Q(w - 3, hh - 8), col, 1, 1);
    for (const [a, b] of [[Q(0, 0), Q(w, 0)], [Q(w, 0), Q(w, hh)], [Q(w, hh), Q(0, hh)], [Q(0, hh), Q(0, 0)]] as [Pt, Pt][]) px.line(a, b, col, 1, 1);
    px.pop();
  });
  // a scan line sweeping up the fan
  const sh = 16 + ((t * 10) % 20);
  px.push(0.4); px.line(P(204, 19, sh), P(231, 15, sh), '#E8FDFF', 1, 1); px.pop();
  L.add(...P(217, 18, 22), 60, C.cyan, 0.45, 0.8);
}

/** The kanban board on the back wall: the Ops board's four columns (Order in, On the line, Your call, Served), each
    with a card per job (up to five, then a "+"), coloured like the real board. Jobs waiting on you blink. Drawn live. */
export function kanbanWall(c: IC, counts: [number, number, number, number], t: number, lit: boolean) {
  const { P, px, L } = c;
  const WR = (u: number, h: number) => P(u, 140, h);
  // the board: a dark felt panel in a light frame
  px.poly([WR(93, 9), WR(179, 9), WR(179, 41), WR(93, 41)], '#3A3458');
  px.poly([WR(94, 10), WR(178, 10), WR(178, 40), WR(94, 40)], lit ? '#120C22' : '#0A0618');
  if (!lit) return;
  const cols = [C.lav, C.cyan, C.amber, C.mint];
  cols.forEach((col, i) => {
    const u0 = 96 + i * 20.5, u1 = u0 + 18;
    px.poly([WR(u0, 35), WR(u1, 35), WR(u1, 38), WR(u0, 38)], col, 1);            // the column's header strip
    const n = counts[i]!;
    for (let k = 0; k < Math.min(5, n); k++) {
      const h1 = 33 - k * 4.4, h0 = h1 - 3.4;
      const blink = i === 2 && Math.floor(t * 2) % 2 === 0 ? 0.55 : 1;
      px.push(blink);
      px.poly([WR(u0 + 1, h0), WR(u1 - 1, h0), WR(u1 - 1, h1), WR(u0 + 1, h1)], '#EDE6D2');           // the paper ticket
      px.poly([WR(u0 + 1, h1 - 1), WR(u0 + 3, h1 - 1), WR(u0 + 3, h1), WR(u0 + 1, h1)], col, 1);       // its status clip
      px.line(WR(u0 + 4.5, h1 - 1.6), WR(u1 - 3 - (k % 3) * 2, h1 - 1.6), '#7A7290');                  // a line of text
      px.pop();
    }
    if (n > 5) px.text('+', (a, b) => WR(u1 - 3 + a, 12.5 - b), 1, col, 1);
  });
  L.add(...P(136, 140, 25), 80, C.cyan, 0.32, 0.8);
  if (counts[2] > 0) L.add(...P(147, 140, 22), 40, C.amber, 0.25 + 0.15 * Math.sin(t * 4), 0.7);
}

/** Corners of a footprint box, projected (for hit tests and outlines). */
export function boxCorners(P: (u: number, v: number, h?: number) => Pt, b: [number, number, number, number, number, number]): Pt[] {
  const [u, v, h, du, dv, dh] = b;
  const out: Pt[] = [];
  for (const a of [0, du]) for (const bb of [0, dv]) for (const k of [0, dh]) out.push(P(u + a, v + bb, h + k));
  return out;
}
