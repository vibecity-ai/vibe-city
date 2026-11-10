/* Vibe City renderer. Reads the store every frame, animates the tower and the open office, and
   plays one-shot Fx. It never decides game state: animation may lag truth, never lead it.
   Rendering is HD-2D: pixel-art buffer + emissive mask + light buffer, composited in Post. */
import { useStore, type Fx, type State } from '../store';
import type { AgentStatus, Dept } from '../data/types';
import { Pix, Lights, Post, Bakery, NULL_LIGHTS, type Pt } from './pix';
import { getSprite, ghostSprite, lookFor, mix, quirkProp, AX, AY, type Look } from './sprites';
import { greetingLine, handoffLines } from '../data/views';
import {
  mkP, shell, wallLive, roomLights, deskStatic, deskLive, screenKindFor, chairItem, plant, coolerItem, LOUNGE_PROPS, loungeLive, chiefDeskStatic, chiefDeskLive, shelfItem, glassWalls, cast,
  DESKS, seatOf, CHIEF_SEAT, ELEVATOR, BOARD_SPOT, COFFEE, LOUNGE, COOLER, OFFICE_DOOR, AISLE, GAPS, C, type IC,
} from './interior';
import { ASSISTANT_SPOT, EXEC_OBJECTS, boxCorners, execFurniture, execProps, kanbanWall, templateKiosk, type ExecObjectId } from './execRoom';
import { columnOf } from '../data/company';
import { execAction, floorAction } from '../execActions';
import { listedFloors, stationFor, stationKeyOf, type FloorObjectId } from '../data/floor';
import { STATION_BOX, archiveStatic, clockLive, floorObjects, keySafe, skillShelf, stationLive, stationStatic, toolsRackLive, toolsRackStatic } from './floorRoom';
import { hull } from './interior';

/** The Executive Office uses the department shell with its own (warmer, darker) floor. */
const EXEC_THEME = { theme: { floor: '#4A2E44', accent: '#FFC75A' }, name: 'Executive office' } as unknown as Dept;
import { cityFront } from './citybg';
import { backdrop, lobby, floorFacade, ghostFloor, penthouse, pip, FH, PH_H, HEX, type FaceAgent } from './tower';

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const damp = (cur: number, target: number, k: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-k * dt));
const easeIO = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const XS = [36, 84, 120, 156, 192];

export interface Anchor { id: string; kind: 'floor' | 'ph' | 'ghost' | 'agent' | 'obj'; x: number; y: number; visible: number; z: number }
interface FloorAnim { target: number; y: number; vy: number; alpha: number; pull: number; open: number; flash: number; flashCol: string; shimmer: number; born: number }
interface Actor {
  id: string; look: Look; u: number; v: number; path: Pt[]; seat: Pt; mode: 'seat' | 'walk' | 'stand';
  dir: 'f' | 'b'; flip: boolean; walkT: number; standUntil: number; next: number; status: AgentStatus; alpha: number; bubble: number;
  /** When the CEO last clicked this agent: it stops, turns to you and hops. */
  greetAt?: number;
  /** A line said out loud, shown in the speech bubble over the head until `until`. */
  line?: { text: string; until: number };
  /** The lead on its way to hand a task to a teammate (stage go), or handing it over (stage talk). */
  errand?: { to: string; title: string | null; spot: Pt; stage: 'go' | 'talk'; at: number; reply: string | null };
}
interface Particle { x: number; y: number; vx: number; vy: number; life: number; max: number; col: string; size: number; grav: number; glow: boolean }
interface Packet { from: Pt; to: Pt; t: number; d: number; dept: string; done?: boolean; big?: boolean }
interface Pop { x: number; y: number; t: number; st: AgentStatus }
interface Ring { x: number; y: number; r: number; max: number; col: string }
interface Shell { key: string; a: HTMLCanvasElement; m: HTMLCanvasElement }

export class City {
  anchors: Anchor[] = [];
  private cv: HTMLCanvasElement; private g: CanvasRenderingContext2D;
  private post = new Post(); private px = new Pix(); private L = new Lights(); private bk = new Bakery();
  private dpr = 1; private W = 800; private H = 600;
  private cam = { x: 190, y: -260, z: 1 };
  private camS = { x: 400, y: 300 };
  private user = { dx: 0, dy: 0, dz: 1, active: false };
  private floors = new Map<string, FloorAnim>();
  private ph = { y: -1300, vy: 0 };
  private ghostA = 1;
  private actors = new Map<string, Map<string, Actor>>();
  /** Tasks the lead still has to walk over and hand out, per floor. */
  private errands = new Map<string, { to: string; title: string | null }[]>();
  private said = 0;
  private elev = new Map<string, number>();
  private shells = new Map<string, Shell>();
  /** 0..1: how far the Executive Office is opened up (feature spec 3.1). */
  private execOpen = 0; hoverObj: ExecObjectId | FloorObjectId | null = null;
  /** A long press in progress on an agent (opens the chat when it completes). */
  private press: { id: number; x: number; y: number; start: number; agent: string; fired: boolean; timer: number } | null = null;
  private particles: Particle[] = []; private packets: Packet[] = []; private pops: Pop[] = []; private rings: Ring[] = [];
  private t = 0; private last = 0; private raf = 0; private intro = 0; private fxSeen = 0;
  private hover: string | null = null;
  hoverAgent: string | null = null;
  private drag: { x: number; y: number; moved: boolean } | null = null;
  onTick: (dtMs: number) => void = () => {};
  reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(canvas: HTMLCanvasElement) {
    this.cv = canvas; this.g = canvas.getContext('2d')!;
    this.bind();
    const s = useStore.getState();
    this.fxSeen = s.fx.length ? s.fx[s.fx.length - 1].seq : 0;
    s.depts.forEach((d, i) => this.floors.set(d.id, this.newFloor(-FH * (s.depts.length - i) - 420 - i * 60, i)));
  }
  private newFloor(y: number, i: number): FloorAnim { return { target: 0, y, vy: 0, alpha: 0, pull: 0, open: 0, flash: 0, flashCol: C.mint, shimmer: 0, born: i * 0.09 }; }
  start() {
    this.last = performance.now();
    const loop = (t: number) => { this.raf = requestAnimationFrame(loop); try { this.frame(t); } catch (e) { console.error('[city] frame failed', e); } };
    this.raf = requestAnimationFrame(loop);
  }
  stop() { cancelAnimationFrame(this.raf); }
  resize() {
    const r = this.cv.parentElement!.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1); this.W = Math.max(1, r.width); this.H = Math.max(1, r.height);
    this.cv.width = Math.round(this.W * this.dpr); this.cv.height = Math.round(this.H * this.dpr);
    this.cv.style.width = this.W + 'px'; this.cv.style.height = this.H + 'px';
  }
  zoomBy(f: number) { this.user.active = true; this.user.dz = clamp(this.user.dz * f, 0.6, 2.6); }
  fit() { this.user = { dx: 0, dy: 0, dz: 1, active: false }; }

  /* ---------- layout ---------- */
  private floorTopTarget(i: number, n: number) { return -FH * (n - i); }
  private camTarget(s: State) {
    const n = s.depts.length, W = this.W, H = this.H;
    const open = s.ui.view === 'floor' && s.ui.floorId ? s.ui.floorId : null;
    if (open) {
      const fa = this.floors.get(open); const T = fa ? fa.target : 0;
      // integer art-pixel scale so the pixel grid stays perfectly even once the camera settles
      // integer art-pixel scale when it fits well; otherwise fill the stage (small screens)
      const zi = Math.min((W * 0.94) / 392, (H * (W < 700 ? 0.7 : 0.78)) / 256);
      const k = zi * this.dpr, kr = Math.round(k), kf = Math.floor(k);
      const z = kr >= 1 && kr <= k * 1.1 ? kr / this.dpr : kf >= 1 && kf >= k * 0.8 ? kf / this.dpr : zi;
      // dialogue window open: close in on the speaker, framed in the open left part of the screen
      const talk = s.ui.talk;
      if (talk && talk.deptId === open) {
        const a = this.actors.get(open)?.get(talk.agentKey);
        if (a) { const p = this.interiorPt(open, a.u, a.v, 20); return { x: p[0], y: p[1], z: z * 2, sx: W * (W < 700 ? 0.27 : 0.34), sy: H * (W < 700 ? 0.2 : 0.47) }; }
      }
      return { x: 192, y: T + 54, z, sx: W / 2, sy: H * (W < 700 ? 0.5 : 0.53) };
    }
    if (s.ui.execRoom) {
      const zi = Math.min((W * 0.94) / 392, (H * (W < 700 ? 0.7 : 0.78)) / 256);
      const k = zi * this.dpr, kr = Math.round(k), kf = Math.floor(k);
      const z = kr >= 1 && kr <= k * 1.1 ? kr / this.dpr : kf >= 1 && kf >= k * 0.8 ? kf / this.dpr : zi;
      return { x: 192, y: this.execT() + 54, z, sx: W / 2, sy: H * (W < 700 ? 0.5 : 0.53) };
    }
    const top = -FH * n - FH - PH_H - 150, bottom = 240;
    const labels = W > 760 ? 250 : 0;
    const z = clamp(Math.min((W - labels - 80) / 500, (H - (W < 900 ? 90 : 60)) / (bottom - top + 40)), 0.22, 1.6) * this.user.dz;
    // keep the penthouse clear of the HQ card (top-left) on narrower stages
    let sx = (W - labels) / 2 + (labels ? 10 : 0);
    if (labels) sx = Math.min(Math.max(sx, 330 + 150 * z), W - labels - 150 * z);
    return { x: 190 + this.user.dx, y: (top + bottom) / 2 + this.user.dy, z, sx, sy: H / 2 + (W < 900 ? 10 : 0) };
  }
  /** Top of the exec room in world space: its floor plane sits on the penthouse's floor. */
  private execT() { return this.ph.y + PH_H - 56; }
  private toScreen(x: number, y: number): Pt { return [(x - this.cam.x) * this.cam.z + this.camS.x, (y - this.cam.y) * this.cam.z + this.camS.y]; }
  private toWorld(sx: number, sy: number): Pt { return [(sx - this.camS.x) / this.cam.z + this.cam.x, (sy - this.camS.y) / this.cam.z + this.cam.y]; }

  private frame(now: number) {
    const dtMs = Math.max(0, Math.min(50, now - this.last)); this.last = now;
    const dt = dtMs / 1000; this.t += dt; this.intro = Math.min(1, this.intro + dt / 2.4);
    this.onTick(dtMs);
    const s = useStore.getState();
    this.consumeFx(s);
    this.layout(s, dt);
    this.syncActors(s, dt);
    this.render(s, dt);
  }

  private layout(s: State, dt: number) {
    const n = s.depts.length, open = s.ui.view === 'floor' ? s.ui.floorId : null;
    const openIdx = open ? s.depts.findIndex((d) => d.id === open) : -1;
    s.depts.forEach((d, i) => {
      let fa = this.floors.get(d.id);
      if (!fa) { fa = this.newFloor(this.floorTopTarget(i, n) - 320, 0); fa.born = this.t; this.floors.set(d.id, fa); }
      const delay = Math.max(0, this.t - (fa.born > 1 ? fa.born : 0.15 + (n - i) * 0.11));
      if (delay <= 0) return;
      let target = this.floorTopTarget(i, n);
      if (openIdx >= 0 && i < openIdx) target -= 250 * (this.floors.get(open!)?.open ?? 0);
      fa.target = target;
      const a = -160 * (fa.y - target) - 18 * fa.vy;
      fa.vy += a * dt; fa.y += fa.vy * dt;
      fa.alpha = Math.min(1, fa.alpha + dt * 2.5);
      fa.pull = damp(fa.pull, this.hover === d.id && !open ? 1 : 0, 14, dt);
      fa.open = damp(fa.open, d.id === open ? 1 : 0, 4.5, dt);
      fa.flash = Math.max(0, fa.flash - dt * 0.8); fa.shimmer = Math.max(0, fa.shimmer - dt * 0.9);
    });
    for (const id of [...this.floors.keys()]) if (!s.depts.some((d) => d.id === id)) this.floors.delete(id);
    const phTarget = -FH * n - FH - PH_H - (openIdx >= 0 ? 250 * (this.floors.get(open!)?.open ?? 0) : 0);
    if (this.t > 0.15 + (n + 1) * 0.11) { const a = -160 * (this.ph.y - phTarget) - 18 * this.ph.vy; this.ph.vy += a * dt; this.ph.y += this.ph.vy * dt; }
    this.execOpen = damp(this.execOpen, s.ui.execRoom ? 1 : 0, 4.5, dt);
    this.ghostA = damp(this.ghostA, open || s.ui.execRoom ? 0 : 1, 6, dt);
    const tg = this.camTarget(s), k = this.drag?.moved ? 30 : 5;
    this.cam.x = damp(this.cam.x, tg.x, k, dt); this.cam.y = damp(this.cam.y, tg.y, k, dt); this.cam.z = damp(this.cam.z, tg.z, k * 0.9, dt);
    if (Math.abs(this.cam.z - tg.z) < 0.004) this.cam.z = tg.z;
    this.camS.x = damp(this.camS.x, tg.sx, k, dt); this.camS.y = damp(this.camS.y, tg.sy, k, dt);
  }

  /* ---------- interior actors ---------- */
  private seatFor(d: Dept, id: string): Pt {
    if (id === 'chief') return CHIEF_SEAT;
    return seatOf(Math.max(0, d.workers.findIndex((w) => w.id === id)));
  }
  private syncActors(s: State, dt: number) {
    for (const d of s.depts) {
      let m = this.actors.get(d.id);
      if (!m) { m = new Map(); this.actors.set(d.id, m); }
      const want: { id: string; status: AgentStatus; shirt: string; chief: boolean }[] = [];
      if (d.chief) want.push({ id: 'chief', status: d.chief.status, shirt: '#FFFFFF', chief: true });
      d.workers.forEach((w) => want.push({ id: w.id, status: w.status, shirt: w.shirt, chief: false }));
      for (const w of want) {
        let a = m.get(w.id);
        const seat = this.seatFor(d, w.id);
        if (!a) {
          a = { id: w.id, look: lookFor(d.id + ':' + w.id, w.shirt, w.chief), u: seat[0], v: seat[1], path: [], seat, mode: 'seat', dir: 'b', flip: false, walkT: 0, standUntil: 0, next: this.t + rnd(2, 6), status: w.status, alpha: 1, bubble: 0 };
          m.set(w.id, a);
        }
        a.seat = seat;
        const prop = quirkProp(s.personas[d.id + ':' + w.id]?.quirk);
        if ((a.look.prop ?? null) !== prop) a.look = { ...a.look, prop };
        if (a.status !== w.status) { a.status = w.status; this.onStatus(a); }
        this.stepActor(a, dt);
        if (w.chief) this.runErrands(d.id, a, m);
      }
      for (const id of [...m.keys()]) if (!want.some((w) => w.id === id)) m.delete(id);
    }
  }
  /** Route through the room: out of the chief's office, between desk rows via gaps, along the aisle. */
  private route(from: Pt, to: Pt): Pt[] {
    const leg = (p: Pt): Pt[] => {
      if (p[0] < 70 && p[1] > 88) return [OFFICE_DOOR, [OFFICE_DOOR[0], AISLE]];
      if (p[0] > 86 && p[0] < 212 && (p[1] < 68 || p[1] > 92)) {
        const g = GAPS.reduce((b, x) => (Math.abs(x - p[0]) < Math.abs(b - p[0]) ? x : b), GAPS[0]);
        return [[g, p[1]], [g, AISLE]];
      }
      return [[p[0], AISLE]];
    };
    const pts = [...leg(from), ...leg(to).reverse(), to];
    const out: Pt[] = []; let cur = from;
    for (const p of pts) { if (Math.hypot(p[0] - cur[0], p[1] - cur[1]) > 0.8) { out.push(p); cur = p; } }
    return out;
  }
  private walkTo(a: Actor, to: Pt) { a.path = this.route([a.u, a.v], to); a.mode = 'walk'; }
  /** Clicked: the agent stops where it is, turns to face you, hops and says hello, and stays put for a while (a
      seated one bobs at its desk). A lead on an errand drops it and hands the task out later. */
  greet(dept: string, id: string) {
    const a = this.actors.get(dept)?.get(id); if (!a) return;
    // the press and the click that ends it are one greeting, not two
    if (a.greetAt === undefined || this.t - a.greetAt > 0.6) { a.greetAt = this.t; this.say(a, greetingLine(this.said++), 2.4); }
    if (a.errand) { (this.errands.get(dept) ?? this.errands.set(dept, []).get(dept)!).unshift({ to: a.errand.to, title: a.errand.title }); a.errand = undefined; }
    if (a.mode !== 'seat') { a.path = []; a.mode = 'stand'; a.walkT = 0; a.dir = 'f'; a.flip = false; }
    a.standUntil = this.t + 9; a.next = Math.max(a.next, this.t + 9);
  }
  /** The line an agent is saying right now, if any (the speech bubble shows it over whatever they are working on). */
  lineOf(dept: string, id: string): string | null {
    const l = this.actors.get(dept)?.get(id)?.line;
    return l && this.t < l.until ? l.text : null;
  }
  private say(a: Actor, text: string, secs: number) { a.line = { text, until: this.t + secs }; }
  /** The lead hands out new tasks in person: walks to the teammate's desk, asks, gets an answer, goes on to the next
      one, then back to its own desk. Skipped when the lead is busy elsewhere; nothing here changes any task. */
  private runErrands(dept: string, a: Actor, m: Map<string, Actor>) {
    const e = a.errand, q = this.errands.get(dept);
    if (!e) {
      if (!q?.length || a.mode === 'walk' || this.t < a.next || this.t < a.standUntil) return;
      const job = q.shift()!, mate = m.get(job.to);
      if (!mate) return;
      const spot: Pt = [mate.seat[0] - 8, mate.seat[1] - 10];
      a.errand = { ...job, spot, stage: 'go', at: this.t, reply: null };
      this.walkTo(a, spot); a.next = this.t + 30;
      return;
    }
    const mate = m.get(e.to);
    if (!mate || this.t - e.at > 16) { a.errand = undefined; a.next = this.t; return; }
    if (e.stage === 'go') {
      if (a.mode === 'walk') return;
      if (Math.hypot(a.u - e.spot[0], a.v - e.spot[1]) > 4) { a.errand = undefined; a.next = this.t; return; }
      const lines = handoffLines(e.title, this.said++);
      a.dir = 'b'; a.flip = false; this.say(a, lines.lead, 2.6);
      e.stage = 'talk'; e.at = this.t; e.reply = lines.mate;
      const from = this.interiorPt(dept, a.u, a.v, 24), to = this.interiorPt(dept, mate.u, mate.v, 22);
      setTimeout(() => this.packets.push({ from, to, t: 0, d: 0.55, dept }), 700);
      return;
    }
    if (e.reply && this.t - e.at > 1.4) { this.say(mate, e.reply, 2.4); e.reply = null; mate.greetAt = this.t; }
    if (this.t - e.at > 3.6) {
      a.errand = undefined;
      if (!q?.length) { this.walkTo(a, CHIEF_SEAT); a.next = this.t + rnd(6, 10); } else a.next = this.t;
    }
  }
  private onStatus(a: Actor) {
    if (a.status === 'running' || a.status === 'failed' || a.status === 'disconnected') { if (Math.hypot(a.u - a.seat[0], a.v - a.seat[1]) > 3) this.walkTo(a, a.seat); }
    if (a.status === 'completed' && a.id !== 'chief') { a.standUntil = this.t + 3; a.next = this.t + rnd(4, 7); }
  }
  private stepActor(a: Actor, dt: number) {
    a.bubble = Math.max(0, a.bubble - dt); a.alpha = Math.min(1, a.alpha + dt * 2.5);
    if (a.mode === 'walk') {
      const p = a.path[0];
      if (!p) {
        const atSeat = Math.hypot(a.u - a.seat[0], a.v - a.seat[1]) < 2;
        a.mode = atSeat ? 'seat' : 'stand'; a.walkT = 0;
        if (atSeat) { a.dir = 'b'; a.flip = false; }
        else { const near = (q: Pt) => Math.hypot(a.u - q[0], a.v - q[1]) < 3; if (near(COFFEE) || near(COOLER) || near(BOARD_SPOT)) { a.dir = 'b'; a.flip = false; } else { a.dir = 'f'; a.flip = Math.random() < 0.5; } }
        return;
      }
      const du = p[0] - a.u, dv = p[1] - a.v, dist = Math.hypot(du, dv), sp = 34 * dt;
      if (dist <= sp) { a.u = p[0]; a.v = p[1]; a.path.shift(); } else { a.u += (du / dist) * sp; a.v += (dv / dist) * sp; }
      if (dist > 0.01) { const sx = du + dv, sy = 0.5 * (du - dv); a.dir = sy >= -0.01 ? 'f' : 'b'; a.flip = sx < 0; }
      a.walkT += dt;
      return;
    }
    if ((a.status === 'idle' || a.status === 'completed') && this.t > a.next && this.t > a.standUntil) {
      const spots: Pt[] = a.id === 'chief' ? [BOARD_SPOT, CHIEF_SEAT, CHIEF_SEAT] : [COFFEE, LOUNGE, COOLER, a.seat, a.seat];
      this.walkTo(a, spots[Math.floor(Math.random() * spots.length)]);
      a.next = this.t + rnd(6, 11);
    }
    if (a.mode === 'stand' && a.status === 'running' && this.t > a.next && this.t > a.standUntil) this.walkTo(a, a.seat);
  }

  /* ---------- fx ---------- */
  private consumeFx(s: State) {
    for (const { seq, fx } of s.fx) { if (seq <= this.fxSeen) continue; this.fxSeen = seq; this.play(s, fx); }
  }
  private interiorPt(dept: string, u: number, v: number, h = 0): Pt {
    const fa = this.floors.get(dept); const T = fa ? fa.y : 0;
    return [u + v, T + 56 + u * 0.5 - v * 0.5 - h];
  }
  private faceSpritePt(s: State, dept: string, id: string): Pt {
    const d = s.depts.find((x) => x.id === dept); const fa = this.floors.get(dept);
    if (!d || !fa) return [0, 0];
    const idx = id === 'chief' ? 0 : 1 + d.workers.findIndex((w) => w.id === id);
    const a = XS[clamp(idx, 0, 4)] + 8;
    return [a, fa.y + 56 + a * 0.5 - 7 - 30];
  }
  private agentPt(s: State, dept: string, id: string, head = true): Pt {
    const fa = this.floors.get(dept);
    if (fa && fa.open > 0.5) { const a = this.actors.get(dept)?.get(id); if (a) return this.interiorPt(dept, a.u, a.v, head ? 30 : 0); }
    return this.faceSpritePt(s, dept, id);
  }
  private play(s: State, fx: Fx) {
    const fa = 'dept' in fx ? this.floors.get(fx.dept) : undefined;
    switch (fx.k) {
      case 'delegate': {
        // In the open office the lead walks over and hands it out; seen from the tower, a packet flies desk to desk.
        if (fa && fa.open > 0.5 && this.actors.get(fx.dept)?.has('chief')) {
          const q = this.errands.get(fx.dept) ?? this.errands.set(fx.dept, []).get(fx.dept)!;
          if (!q.some((j) => j.to === fx.to) && this.actors.get(fx.dept)?.get('chief')?.errand?.to !== fx.to) q.push({ to: fx.to, title: fx.title });
          break;
        }
        const from = this.agentPt(s, fx.dept, 'chief'), to = this.agentPt(s, fx.dept, fx.to);
        this.packets.push({ from, to, t: -Math.random() * 0.4, d: 0.95, dept: fx.dept });
        const a = this.actors.get(fx.dept)?.get('chief'); if (a) a.bubble = 1.2;
        break;
      }
      case 'standup': {
        // A schedule fired: everyone gathers at the Kanban wall for a short stand-up, then goes back to work.
        const m = this.actors.get(fx.dept); if (!m) break;
        const f = this.floors.get(fx.dept); if (f) { f.flash = 1; f.flashCol = C.cyan; }
        let i = 0;
        for (const a of m.values()) {
          const spot: Pt = [BOARD_SPOT[0] - 14 + (i % 4) * 10, BOARD_SPOT[1] - 12 - Math.floor(i / 4) * 10]; i++;
          this.walkTo(a, spot); a.next = this.t + 6; a.bubble = 1.5;
          setTimeout(() => { if (a.mode !== 'seat') this.walkTo(a, a.seat); }, 5500);
        }
        break;
      }
      case 'questRequest': {
        // Work handed from one floor to another: a slower packet up or down the tower, the target chief reacts.
        const from = this.agentPt(s, fx.from, 'chief'), to = this.agentPt(s, fx.dept, 'chief');
        this.packets.push({ from, to, t: 0, d: 1.8, dept: fx.dept, big: true });
        const src = this.actors.get(fx.from)?.get('chief'); if (src) src.bubble = 1.5;
        setTimeout(() => { const a = this.actors.get(fx.dept)?.get('chief'); if (a) a.bubble = 2.5; const f = this.floors.get(fx.dept); if (f) { f.flash = 1; f.flashCol = C.gold; } }, 1800);
        break;
      }
      case 'taskDone': { const p = this.agentPt(s, fx.dept, fx.worker); this.pops.push({ x: p[0], y: p[1], t: 0, st: 'completed' }); this.burst(p[0], p[1], 12, C.mint, 34, 0.9, 40); break; }
      case 'taskFail': {
        const p = this.agentPt(s, fx.dept, fx.worker); this.pops.push({ x: p[0], y: p[1], t: 0, st: 'failed' });
        for (let i = 0; i < 18; i++) this.particles.push({ x: p[0] + rnd(-4, 4), y: p[1] + 6, vx: rnd(-8, 8), vy: rnd(-26, -10), life: 1.6, max: 1.6, col: i % 3 ? '#5A5470' : '#7A7490', size: rnd(2, 4), grav: -6, glow: false });
        if (fa) { fa.flash = 1; fa.flashCol = C.red; }
        break;
      }
      case 'plan': { const a = this.actors.get(fx.dept)?.get('chief'); if (a) { a.bubble = 4; this.walkTo(a, BOARD_SPOT); a.next = this.t + 4.5; setTimeout(() => { if (!a.errand && !this.errands.get(fx.dept)?.length) this.walkTo(a, CHIEF_SEAT); else a.next = this.t; }, 4200); } break; }
      case 'questDone': {
        if (fa) { fa.flash = 1.4; fa.flashCol = C.mint; }
        const p = this.agentPt(s, fx.dept, 'chief');
        const cols = [C.pink, C.cyan, C.gold, C.mint, C.violet];
        for (let i = 0; i < 48; i++) this.particles.push({ x: p[0], y: p[1], vx: rnd(-64, 64), vy: rnd(-96, -30), life: 1.8, max: 1.8, col: cols[i % 5], size: 2, grav: 110, glow: true });
        this.rings.push({ x: p[0], y: p[1] + 30, r: 2, max: 46, col: C.mint });
        break;
      }
      case 'questStarted': {
        // a new job lands: the floor lights up gold, a ticket flies down the tower to the lead, who heads for the board
        if (fa) { fa.flash = 1.2; fa.flashCol = C.gold; }
        const to = this.agentPt(s, fx.dept, 'chief');
        this.packets.push({ from: [to[0] + 90, to[1] - 160], to, t: 0, d: 0.9, dept: fx.dept, big: true });
        setTimeout(() => {
          const p = this.agentPt(s, fx.dept, 'chief');
          this.rings.push({ x: p[0], y: p[1] + 30, r: 2, max: 40, col: C.gold });
          this.burst(p[0], p[1], 16, C.gold, 40, 0.9, 50);
          const a = this.actors.get(fx.dept)?.get('chief'); if (a) a.bubble = 2.5;
        }, 900);
        break;
      }
      case 'needsYou': {
        if (fa) { fa.flash = 1.2; fa.flashCol = C.amber; }
        const p = this.agentPt(s, fx.dept, 'chief'); this.rings.push({ x: p[0], y: p[1] + 30, r: 2, max: 36, col: C.amber });
        break;
      }
      case 'floorAdded': {
        const f = this.floors.get(fx.dept); if (f) { f.born = this.t; f.y -= 260; f.alpha = 0; f.flash = 1.2; f.flashCol = C.cyan; }
        setTimeout(() => {
          const f2 = this.floors.get(fx.dept); if (!f2) return;
          for (let i = 0; i < 36; i++) this.particles.push({ x: rnd(0, 380), y: f2.y + FH + rnd(40, 120), vx: rnd(-40, 40), vy: rnd(-30, -5), life: 1.1, max: 1.1, col: '#8A7FB8', size: 2, grav: 20, glow: false });
          this.rings.push({ x: 190, y: f2.y + 90, r: 10, max: 220, col: C.cyan });
        }, 650);
        break;
      }
      case 'chiefArrived': {
        const a = this.actors.get(fx.dept)?.get('chief');
        if (a) { a.u = ELEVATOR[0]; a.v = ELEVATOR[1]; a.alpha = 0; this.walkTo(a, CHIEF_SEAT); }
        this.elev.set(fx.dept, this.t);
        if (fa) { fa.flash = 1.2; fa.flashCol = C.gold; }
        const p = this.agentPt(s, fx.dept, 'chief'); this.rings.push({ x: p[0], y: p[1] + 30, r: 2, max: 34, col: C.gold });
        break;
      }
      case 'workerJoined': {
        setTimeout(() => { const a = this.actors.get(fx.dept)?.get(fx.worker); if (a) { a.u = ELEVATOR[0]; a.v = ELEVATOR[1]; a.alpha = 0; this.walkTo(a, a.seat); this.elev.set(fx.dept, this.t); } }, 30);
        break;
      }
    }
  }
  private burst(x: number, y: number, n: number, col: string, spd: number, life: number, grav: number) {
    for (let i = 0; i < n; i++) { const a = rnd(0, Math.PI * 2), v = rnd(spd * 0.3, spd); this.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - spd * 0.3, life, max: life, col, size: 2, grav, glow: true }); }
  }

  /* ---------- render ---------- */
  private render(s: State, dt: number) {
    const z = this.cam.z, dpr = this.dpr;
    let k = z * dpr, bs = 1; if (k < 1) { bs = k; k = 1; }
    const Wd = this.cv.width, Hd = this.cv.height;
    const bw = Math.ceil(Wd / k) + 2, bh = Math.ceil(Hd / k) + 2;
    const wx0 = this.cam.x - this.camS.x / z, wy0 = this.cam.y - this.camS.y / z;
    const fx0 = wx0 * bs, fy0 = wy0 * bs, ix = Math.floor(fx0), iy = Math.floor(fy0);
    const open = s.ui.view === 'floor' ? s.ui.floorId : null;
    const openA = Math.max(this.execOpen, open ? this.floors.get(open)?.open ?? 0 : Math.max(0, ...[...this.floors.values()].map((f) => f.open)));
    // build any stale office shells before targeting the frame buffers
    for (const d of s.depts) { const fa = this.floors.get(d.id); if (fa && fa.open > 0.01) this.shellFor(d, s); }

    const { post, px, L } = this;
    post.resize(bw, bh); post.clear('#0B0716');
    px.target(post.a, post.m, bs, ix, iy, bw, bh);
    const amb = mix('#6A64AE', '#5C569E', openA);
    L.begin(post.l, bs, ix, iy, bw, bh, amb);
    // Hermes outage: the city stays lit, our tower loses power (solid, just dark)
    const out = !s.conn.hermes;
    const towerPower = (on: boolean) => { const k = on && out ? 0.06 : 1; px.emScale = k; this.bk.emScale = k; L.scale = on && out ? 0.12 : 1; };

    backdrop(px, L, this.t, openA, this.intro, this.bk);
    towerPower(true);
    lobby(px, L, this.t, (s.company?.name ?? 'VIBE CITY'), 1 - openA * 0.7, this.bk);
    // in an office, the city falls back into a dark, soft background
    if (openA > 0.01) { px.push(0.5 * openA); px.rect(wx0 - 20, wy0 - 20, this.W / z + 40, this.H / z + 40, '#07040F'); px.pop(); }
    const n = s.depts.length;
    const anchors: Anchor[] = [];
    const openFloors: [Dept, FloorAnim, number, number, number][] = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = s.depts[i], fa = this.floors.get(d.id); if (!fa || fa.alpha <= 0) continue;
      const above = open && s.depts.findIndex((x) => x.id === open) > i;
      const dim = open && d.id !== open ? 1 - (above ? 0.88 : 0.72) * openA : this.execOpen > 0 ? 1 - 0.8 * this.execOpen : 1;
      const power = out ? 0 : d.state === 'offline' ? 0.2 : d.state === 'unconfigured' ? 0.25 : 1;
      px.push(fa.alpha * dim);
      if (fa.open < 0.995) {
        const agents: FaceAgent[] = [];
        if (d.chief) agents.push({ id: 'chief', st: d.chief.status, look: lookFor(d.id + ':chief', '#FFFFFF', true) });
        else agents.push({ id: 'chief', st: 'awaiting', look: lookFor('x', '#FFFFFF', true), ghost: true });
        d.workers.forEach((w) => agents.push({ id: w.id, st: w.status, look: lookFor(d.id + ':' + w.id, w.shirt, false) }));
        floorFacade(px, L, this.t, d, fa.y + fa.pull * 3, -fa.pull * 6, n - i, this.bk, {
          faceA: 1 - fa.open, hover: this.hover === d.id && !open, sel: s.ui.floorId === d.id, flash: fa.flash, flashCol: fa.flashCol, shimmer: fa.shimmer, power, agents,
        });
      }
      if (fa.open > 0.01) openFloors.push([d, fa, n - i, power, fa.alpha * dim]);
      px.pop();
      anchors.push({ id: d.id, kind: 'floor', x: 382, y: fa.y + 77 - fa.pull * 3, visible: fa.alpha * (1 - openA) * clamp(1 - Math.abs(fa.vy) / 160, 0, 1) * clamp(1 - (Math.abs(fa.y - fa.target) - 12) / 30, 0, 1), z: 0 });
    }
    const ghostTop = this.ph.y + PH_H;
    if (this.ghostA > 0.02) ghostFloor(px, L, this.t, ghostTop, this.ghostA * this.intro, this.hover === 'ghost', this.bk);
    anchors.push({ id: 'ghost', kind: 'ghost', x: 382, y: ghostTop + 77, visible: this.ghostA * Math.min(1, this.intro * 1.5), z: 0 });
    const phA = (open ? 1 - 0.9 * openA : 1) * (1 - 0.97 * this.execOpen) * Math.min(1, this.intro * 1.6);
    if (phA > 0.01) penthouse(px, L, this.t, this.ph.y, phA, (s.company?.name ?? 'VIBE CITY'), s.ui.panel === 'exec' && s.ui.view === 'tower', this.bk);
    anchors.push({ id: 'ph', kind: 'ph', x: 382, y: this.ph.y + 72, visible: (1 - openA) * clamp(1 - Math.abs(this.ph.vy) / 160, 0, 1), z: 0 });
    towerPower(false);
    if (openA < 0.99) { px.push(1 - openA); cityFront(px, L, this.t, this.bk); px.pop(); }
    towerPower(true);
    for (const [d, fa, no, power, al] of openFloors) { px.push(al); this.drawInterior(s, d, fa, no, power); px.pop(); }
    if (this.execOpen > 0.01) this.drawExec(s, out ? 0 : 1, anchors);
    towerPower(false);
    this.drawFx(dt);
    if (open) {
      const m = this.actors.get(open); const fa = this.floors.get(open);
      if (m && fa) for (const a of m.values()) { const p = this.interiorPt(open, a.u, a.v, 45); anchors.push({ id: a.id, kind: 'agent', x: p[0], y: p[1], visible: fa.open * a.alpha, z: 0 }); }
      // the floor's controls: labels sit above each object's footprint
      const od = s.depts.find((x) => x.id === open);
      if (od && fa) {
        const P = mkP(fa.y), vis = fa.open > 0.95 ? 1 : 0;
        for (const o of floorObjects(stationFor(stationKeyOf(od, listedFloors(s.market)))?.name ?? null)) {
          // the marker hangs at the object's foot, like a nameplate: it never covers the object
          const pts = boxCorners(P, o.b), top = pts.reduce((mm, p) => (p[1] < mm[1] ? p : mm), pts[0]!);
          anchors.push({ id: 'obj:' + o.id, kind: 'obj', x: pts.reduce((sum, p) => sum + p[0], 0) / pts.length, y: top[1] - 4, visible: vis, z: 0 });
        }
      }
    }
    this.anchors = anchors.map((a) => { const [x, y] = this.toScreen(a.x, a.y); return { ...a, x, y, z: this.cam.z }; });

    post.compose(this.g, L, { k, fx: fx0 - ix, fy: fy0 - iy, Wd, Hd, tilt: this.reduced ? 0 : 0.55 + 0.4 * openA, bloom: 1, t: this.t, vignette: 0.5 + 0.15 * openA });
  }

  private shellFor(d: Dept, s: State) {
    const power = d.state === 'offline' || d.state === 'unconfigured' || !s.conn.hermes ? 0 : 1;
    const key = [d.theme.floor, d.theme.accent, d.name, power].join('|');
    let sh = this.shells.get(d.id);
    if (sh && sh.key === key) return sh;
    const a = sh?.a ?? document.createElement('canvas'), m = sh?.m ?? document.createElement('canvas');
    a.width = m.width = 400; a.height = m.height = 270;
    const ca = a.getContext('2d')!, cm = m.getContext('2d')!;
    ca.clearRect(0, 0, 400, 270); cm.clearRect(0, 0, 400, 270);
    const px = new Pix(); px.target(ca, cm, 1, -6, -76, 400, 270);
    shell({ px, L: this.L, t: 0, P: mkP(0), power }, d);
    sh = { key, a, m }; this.shells.set(d.id, sh); return sh;
  }

  /* ---------- the open office ---------- */
  private drawInterior(s: State, d: Dept, fa: FloorAnim, floorNo: number, power: number) {
    const { px, L } = this, t = this.t;
    const a = easeIO(Math.min(1, fa.open * 1.12));
    const T = fa.y, P = mkP(T);
    const lit = power > 0.3;
    const c: IC = { px, L, t, P, power };
    const prevScale = L.scale; L.scale *= a * (lit ? 1 : 0.6);
    px.push(a);
    const sh = this.shells.get(d.id); if (sh) px.layer(sh.a, sh.m, -6, T - 76);
    roomLights(c, lit);
    const e0 = this.elev.get(d.id), et = e0 === undefined ? 9 : t - e0;
    const elevOpen = et < 0.4 ? easeOut(et / 0.4) : et < 1.7 ? 1 : et < 2.1 ? 1 - easeOut((et - 1.7) / 0.4) : 0;
    wallLive(c, d, s.quests.filter((q) => q.deptId === d.id).map((q) => q.summary.status), floorNo, elevOpen, lit);
    clockLive(c, lit, new Date());
    keySafe(c, lit);
    const station = stationKeyOf(d, listedFloors(s.market));

    // cast shadows first, so everything stands in them
    const nD = Math.min(DESKS.length, d.workers.length);
    for (let i = 0; i < nD; i++) { const [u, v] = DESKS[i]; cast(c, u, v, 28, 16, 14, 0.26); }
    cast(c, 183, 126, 39, 14, 30, 0.22); cast(c, 0, 58, 12, 28, 24, 0.22); cast(c, 0, 118, 8, 20, 40, 0.2);

    const items: { y: number; draw: () => void; g?: number }[] = [];
    const bc: IC = { px, L: NULL_LIGHTS, t: 0, P: mkP(0), power };
    const prop = (key: string, fn: (q: IC) => void) => this.bk.draw(px, this.bk.get('room|' + key, (q) => { bc.px = q; fn(bc); }), 0, T);
    for (let i = 0; i < nD; i++) {
      const [u, v] = DESKS[i], w = d.workers[i];
      items.push({ y: P(u, v + 16)[1], draw: () => { prop(`desk${i}|${d.theme.accent}`, (q) => deskStatic(q, i, d.theme.accent)); deskLive(c, i, w?.status, lit, screenKindFor(d.view.templateId)); } });
      const [su, sv] = seatOf(i);
      const chairCol = i % 3 === 0 ? '#2E2752' : i % 3 === 1 ? '#3A2448' : '#24304E';
      items.push({ y: P(su, sv)[1] - 0.6, draw: () => prop(`seat${i}`, (q) => chairItem(q, su, sv, chairCol, 'seat')) });
      items.push({ y: P(su + 5, sv - 6)[1], draw: () => prop(`back${i}`, (q) => chairItem(q, su, sv, chairCol, 'back')) });
    }
    // chief office
    items.push({ g: 0, y: P(0, 138)[1], draw: () => prop('shelf', (q) => shelfItem(q)) });
    items.push({ g: 0, y: P(14, 132)[1], draw: () => { prop('cdesk', (q) => chiefDeskStatic(q)); chiefDeskLive(c, d.chief?.status, lit && !!d.chief); } });
    items.push({ g: 0, y: P(CHIEF_SEAT[0], CHIEF_SEAT[1])[1] - 0.6, draw: () => prop('cseat', (q) => chairItem(q, CHIEF_SEAT[0], CHIEF_SEAT[1], '#5A2A36', 'seat')) });
    items.push({ g: 0, y: P(CHIEF_SEAT[0] + 5, CHIEF_SEAT[1] - 6)[1], draw: () => prop('cback', (q) => chairItem(q, CHIEF_SEAT[0], CHIEF_SEAT[1], '#5A2A36', 'back', true)) });
    items.push({ g: 0, y: P(64, 132)[1], draw: () => prop('cplant', (q) => plant(q, 64, 132, true, 3)) });
    items.push({ g: 1, y: 0, draw: () => prop('glassF', (q) => glassWalls(q, 'front')) });
    items.push({ g: 1, y: 1, draw: () => prop('glassS', (q) => glassWalls(q, 'side')) });
    // room furniture
    items.push({ y: P(197, 140)[1], draw: () => { prop('trackR', (q) => toolsRackStatic(q)); toolsRackLive(c, lit); } });
    items.push({ y: P(COOLER[0] - 2, COOLER[1] + 16)[1], draw: () => prop('cooler', (q) => coolerItem(q)) });
    items.push({ y: P(222, 140)[1], draw: () => prop('skillShelf', (q) => skillShelf(q)) });
    // a template's station replaces the lounge: the tools that kind of team works with, live
    if (station) {
      cast(c, STATION_BOX[0] + 2, STATION_BOX[1] + 2, STATION_BOX[3] - 4, STATION_BOX[4] - 4, 16, 0.24);
      items.push({ y: P(204, 26)[1], draw: () => { prop('station|' + station, (q) => stationStatic(q, station)); stationLive(c, station, lit); } });
    } else {
      for (const lp of LOUNGE_PROPS) items.push({ y: P(lp.y[0], lp.y[1])[1], draw: () => { prop(lp.key, lp.draw); loungeLive(c, lit, lp.key); } });
      cast(c, 204, 12, 14, 16, 6, 0.22); cast(c, 224, 6, 14, 34, 12, 0.25);
    }
    items.push({ y: P(12, 86)[1], draw: () => prop('archiveL', (q) => archiveStatic(q)) });
    // plants stand against walls and in corners, beside something: the board, the lead's office, the cooler, the shelf bay
    for (const [u, v, big, seed] of [[84, 132, true, 7], [6, 100, false, 13], [30, 4, false, 9], [233, 122, false, 5]] as [number, number, boolean, number][]) items.push({ y: P(u + 4, v - 4)[1], draw: () => prop(`plant${u}${v}`, (q) => plant(q, u, v, big, seed)) });
    // people
    const actors = this.actors.get(d.id);
    if (actors) for (const ac of actors.values()) {
      const seated = ac.mode === 'seat';
      const foot = seated ? P(ac.u, ac.v + 1, 6) : P(ac.u, ac.v, 0);
      const ground = P(ac.u, ac.v, 0);
      items.push({ g: ac.u < 70 && ac.v > 88 ? 0 : 2, y: ground[1] + (seated ? -0.3 : 0.1), draw: () => {
        const sel = s.ui.agent === ac.id;
        px.push(ac.alpha);
        px.shadeEllipse(ground[0] + 2, ground[1], 8, 3.5, 0.45);
        if (sel) px.ring(ground[0], ground[1], 11, 5.5, C.cyan, 1, 1);
        const pr = this.press;
        if (pr && !pr.fired && pr.agent === ac.id) {
          const k = Math.min(1, (performance.now() - pr.start) / LONG_PRESS_MS);
          px.ring(ground[0], ground[1], 6 + 10 * k, 3 + 5 * k, C.gold, 1, 1);
          L.add(ground[0], ground[1] - 14, 18 + 26 * k, C.gold, 0.5 * k);
        }
        const frame = ac.mode === 'walk' ? Math.floor(ac.walkT * 8) % 4 : 0;
        const typing = seated && ac.status === 'running' ? Math.floor(t * 8) % 2 : 0;
        const sp = getSprite(ac.look, { dir: seated ? 'b' : ac.dir, frame, seated, type: typing });
        const hop = ac.greetAt !== undefined ? hopOf(t - ac.greetAt, seated) : 0;
        px.push(ac.status === 'disconnected' ? 0.55 : 1);
        px.sprite(sp.img, sp.sil, foot[0] - AX, foot[1] - AY - hop, seated ? false : ac.flip);
        px.pop();
        pip(px, ac.status, ground[0], ground[1] - 39);
        emote(px, ac, t, ground[0] + 6, ground[1] - 66);
        if (ac.bubble > 0) this.thinking(ground[0] + 12, ground[1] - 46, ac.bubble);
        px.pop();
      } });
    }
    if (!d.chief) items.push({ g: 0, y: P(CHIEF_SEAT[0], CHIEF_SEAT[1])[1], draw: () => { const p = P(CHIEF_SEAT[0], CHIEF_SEAT[1] - 6); const g = ghostSprite(); px.sprite(g.img, null, p[0] - AX, p[1] - AY, false, 0.8); pip(px, 'awaiting', p[0], p[1] - 39); } });
    items.sort((p, q) => (p.g ?? 2) - (q.g ?? 2) || p.y - q.y).forEach((it) => it.draw());
    // hover outline on the control under the pointer (or its focused label), only on the floor you are in
    if (s.ui.floorId === d.id && a > 0.9) {
      const hov = floorObjects(station ? stationFor(station)!.name : null).find((o) => o.id === this.hoverObj);
      if (hov) {
        const hl = hull(boxCorners(P, hov.b));
        for (let i = 0; i < hl.length; i++) px.line(hl[i]!, hl[(i + 1) % hl.length]!, C.gold, 1, 1);
        const m = hl.reduce((acc, p) => [acc[0] + p[0] / hl.length, acc[1] + p[1] / hl.length] as Pt, [0, 0] as Pt);
        L.add(m[0], m[1], 40, C.gold, 0.6);
      }
    }
    // neon floor edge on the cut
    px.line(P(0, 0, -1), P(240, 0, -1), C.cyan, 1, lit ? 1 : 0.3); px.line(P(240, 0, -1), P(240, 140, -1), C.cyan, 1, lit ? 0.8 : 0.2);
    if (lit) { L.add(...P(120, -6, 0), 140, C.cyan, 0.12, 0.5); }
    // dust motes drifting in the window light
    for (let i = 0; i < 26; i++) {
      const k = i * 7.3, u = 150 + ((k * 13 + t * 3) % 90), v = 80 + ((k * 29 + t * 2) % 60) - 30, h = 10 + ((k * 17 + t * 4) % 36);
      const p = P(u, v, h), tw = 0.4 + 0.6 * Math.abs(Math.sin(t * 0.7 + i));
      px.push(tw * 0.75); px.dot(Math.floor(p[0]), Math.floor(p[1]), '#E8E0FF', 0.5); px.pop();
    }
    px.pop();
    L.scale = prevScale;
  }
  /* ---------- the Executive Office (feature spec 3.1) ---------- */
  private drawExec(s: State, power: number, anchors: Anchor[]) {
    const { px, L } = this, t = this.t;
    const a = easeIO(Math.min(1, this.execOpen * 1.12));
    const T = this.execT(), P = mkP(T), lit = power > 0.3;
    const c: IC = { px, L, t, P, power };
    const prevScale = L.scale; L.scale *= a * (lit ? 1 : 0.6);
    px.push(a);
    const bc: IC = { px, L: NULL_LIGHTS, t: 0, P: mkP(0), power };
    const bake = (key: string, fn: (q: IC) => void) => this.bk.draw(px, this.bk.get('exec|' + key + '|' + power, (q) => { bc.px = q; fn(bc); }), 0, T);
    bake('shell', (q) => { shell(q, EXEC_THEME); execProps(q); });
    roomLights(c, lit);
    { const n: [number, number, number, number] = [0, 0, 0, 0], at = { queued: 0, active: 1, attention: 2, finished: 3 } as const;
      for (const q of s.quests) n[at[columnOf(q.summary.status)]]++;
      kanbanWall(c, n, t, lit); }
    cast(c, 14, 118, 36, 14, 14, 0.24); cast(c, 0, 70, 16, 18, 20, 0.22);
    bake('furniture', (q) => execFurniture(q));
    chiefDeskLive(c, 'running', lit);
    templateKiosk(c, lit);
    if (lit) { L.add(...P(28, 121, 18), 26, '#FF5C8A', 0.5); L.add(...P(4, 128, 46), 30, C.gold, 0.6); L.add(...P(0, 64, 46), 28, '#7CF5B4', 0.5); }
    // the assistant stands by the desk, waiting for you
    const g = P(ASSISTANT_SPOT[0], ASSISTANT_SPOT[1]);
    px.shadeEllipse(g[0] + 2, g[1], 8, 3.5, 0.45);
    const sp = getSprite(lookFor('exec-assistant', '#9B5CFF', true), { dir: 'f', frame: 0, seated: false, type: 0 });
    px.sprite(sp.img, sp.sil, g[0] - AX, g[1] - AY + (Math.floor(t * 1.5) % 2 ? 0 : -1), false);
    // hover outline on the object under the pointer (or focused label)
    const hov = EXEC_OBJECTS.find((o) => o.id === this.hoverObj);
    if (hov && a > 0.9) {
      const hl = hull(boxCorners(P, hov.b));
      for (let i = 0; i < hl.length; i++) px.line(hl[i]!, hl[(i + 1) % hl.length]!, C.gold, 1, 1);
      const m = hl.reduce((acc, p) => [acc[0] + p[0] / hl.length, acc[1] + p[1] / hl.length] as Pt, [0, 0] as Pt);
      L.add(m[0], m[1], 40, C.gold, 0.6);
    }
    px.pop();
    L.scale = prevScale;
    for (const o of EXEC_OBJECTS) {
      const pts = boxCorners(P, o.b);
      const top = pts.reduce((m, p) => (p[1] < m[1] ? p : m), pts[0]!);
      const cx = pts.reduce((sum, p) => sum + p[0], 0) / pts.length;
      anchors.push({ id: 'obj:' + o.id, kind: 'obj', x: cx, y: top[1] - 4, visible: a > 0.95 ? 1 : 0, z: 0 });
    }
  }
  private thinking(x: number, y: number, k: number) {
    const px = this.px;
    px.push(Math.min(1, k * 2));
    px.rect(x - 2, y - 9, 24, 13, '#F4EEFF'); px.rect(x - 1, y - 8, 22, 11, '#140D26');
    px.rect(x, y + 4, 3, 2, '#F4EEFF'); px.rect(x - 3, y + 6, 2, 2, '#F4EEFF');
    for (let i = 0; i < 3; i++) px.rect(x + 3 + i * 6, y - 4, 3, 3, Math.floor(this.t * 4) % 3 === i ? C.gold : '#6B5530', 1);
    px.pop();
  }

  private drawFx(dt: number) {
    const { px, L } = this;
    for (const p of this.particles) {
      p.life -= dt; p.vy += p.grav * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      px.push(Math.max(0, p.life / p.max)); px.dot(Math.floor(p.x), Math.floor(p.y), p.col, p.glow ? 1 : 0, Math.round(p.size)); px.pop();
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    for (const k of this.packets) {
      k.t += dt; if (k.t < 0) continue;
      const e = easeIO(Math.min(1, k.t / k.d)), arc = k.big ? 70 : 34, x = k.from[0] + (k.to[0] - k.from[0]) * e + (k.big ? Math.sin(e * Math.PI) * 60 : 0), y = k.from[1] + (k.to[1] - k.from[1]) * e - Math.sin(e * Math.PI) * arc;
      const m = k.big ? 2 : 1;
      px.rect(x - 4 * m, y - 3 * m, 8 * m, 6 * m, '#B8862E', 1); px.rect(x - 3 * m, y - 2 * m, 6 * m, 4 * m, C.gold, 1); px.line([x - 3 * m, y - 2 * m], [x, y + m], '#FFF3D0', 1, 1); px.line([x, y + m], [x + 3 * m, y - 2 * m], '#FFF3D0', 1, 1);
      L.add(x, y, 34 * m, C.gold, 0.9, 1);
      const trail = k.big ? 3 : 1;
      for (let i = 0; i < trail; i++) if (Math.random() < 0.7) this.particles.push({ x, y, vx: rnd(-6, 6), vy: rnd(-6, 6), life: k.big ? 0.9 : 0.5, max: k.big ? 0.9 : 0.5, col: C.gold, size: k.big ? 2 : 1, grav: 0, glow: true });
      if (k.t >= k.d && !k.done) { k.done = true; this.rings.push({ x: k.to[0], y: k.to[1], r: 2, max: k.big ? 40 : 18, col: C.gold }); }
    }
    this.packets = this.packets.filter((k) => k.t < k.d + 0.01);
    for (const p of this.pops) {
      p.t += dt; const k = p.t / 1.3, y = p.y - 6 - easeOut(Math.min(1, k)) * 18, sc = p.t < 0.15 ? 1 + (1 - p.t / 0.15) : 1;
      px.push(Math.max(0, 1 - Math.max(0, k - 0.6) / 0.4)); pip(px, p.st, p.x, y, 1.5 * sc); px.pop();
      L.add(p.x, y, 30, p.st === 'failed' ? C.red : C.mint, 0.7 * Math.max(0, 1 - k), 1);
    }
    this.pops = this.pops.filter((p) => p.t < 1.3);
    for (const r of this.rings) { r.r += dt * 90; const al = Math.max(0, 1 - r.r / r.max); px.push(al); px.ring(r.x, r.y, r.r, r.r * 0.5, r.col, 1, 1); px.pop(); }
    this.rings = this.rings.filter((r) => r.r < r.max);
  }

  /* ---------- input ---------- */
  private hit(sx: number, sy: number): { kind: 'floor' | 'ph' | 'ghost' | 'agent' | 'obj'; id: string } | null {
    const s = useStore.getState();
    const [x, y] = this.toWorld(sx, sy);
    if (s.ui.execRoom) {
      const P = mkP(this.execT());
      for (const o of EXEC_OBJECTS) if (pointInPoly([x, y], hull(boxCorners(P, o.b)))) return { kind: 'obj', id: o.id };
      return null;
    }
    const open = s.ui.view === 'floor' ? s.ui.floorId : null;
    if (open) {
      const m = this.actors.get(open);
      if (m) { let best: { id: string; d: number } | null = null; for (const a of m.values()) {
        // the whole body at the current zoom, a little generous: people are a small target when they walk about
        const p = this.interiorPt(open, a.u, a.v, 0), hy = p[1] - this.interiorPt(open, a.u, a.v, 44)[1], hw = Math.max(10, hy * 0.32);
        if (x > p[0] - hw && x < p[0] + hw && y > p[1] - hy && y < p[1] + hy * 0.08) { const dd = -p[1]; if (!best || dd < best.d) best = { id: a.id, d: dd }; } } if (best) return { kind: 'agent', id: best.id }; }
      const od = s.depts.find((x) => x.id === open), fa = this.floors.get(open);
      if (od && fa && fa.open > 0.95) {
        const P = mkP(fa.y);
        for (const o of floorObjects(stationFor(stationKeyOf(od, listedFloors(s.market)))?.name ?? null)) if (pointInPoly([x, y], hull(boxCorners(P, o.b)))) return { kind: 'obj', id: o.id };
      }
    }

    const inHex = (T: number, h: number) => pointInPoly([x, y], [[0, T], [140, T - 70], [380, T + 50], [380, T + 50 + h], [240, T + 120 + h], [0, T + h]]);
    if (!open) { if (inHex(this.ph.y, PH_H)) return { kind: 'ph', id: 'ph' }; if (inHex(this.ph.y + PH_H, FH)) return { kind: 'ghost', id: 'ghost' }; }
    for (const d of s.depts) { const fa = this.floors.get(d.id); if (!fa || fa.alpha < 0.5) continue; if (pointInPoly([x, y], HEX(fa.y))) return { kind: 'floor', id: d.id }; }
    return null;
  }
  private bind() {
    const cv = this.cv;
    cv.addEventListener('pointermove', (e) => {
      const r = cv.getBoundingClientRect();
      if (this.drag && e.buttons & 1) {
        const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
        if (this.drag.moved || Math.hypot(dx, dy) > 5) {
          this.drag.moved = true; this.drag.x = e.clientX; this.drag.y = e.clientY;
          if (useStore.getState().ui.view === 'tower' && !useStore.getState().ui.execRoom) { this.user.active = true; this.user.dx -= dx / this.cam.z; this.user.dy -= dy / this.cam.z; }
        }
        return;
      }
      const h = this.hit(e.clientX - r.left, e.clientY - r.top);
      this.hoverObj = h && h.kind === 'obj' ? (h.id as ExecObjectId | FloorObjectId) : null;
      this.hover = h && h.kind !== 'agent' && h.kind !== 'obj' ? (h.kind === 'floor' ? h.id : h.kind) : null;
      this.hoverAgent = h && h.kind === 'agent' ? h.id : null;
      cv.style.cursor = h ? 'pointer' : useStore.getState().ui.view === 'tower' && !useStore.getState().ui.execRoom ? 'grab' : 'default';
    });
    cv.addEventListener('pointerleave', () => { this.hover = null; this.hoverAgent = null; });
    // Holding an agent opens the chat (mouse, pen or touch alike). A gold ring fills while held; moving more than a few pixels, scrolling or lifting early cancels it.
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const r = cv.getBoundingClientRect(), h = this.hit(e.clientX - r.left, e.clientY - r.top);
      if (h?.kind !== 'agent') { this.press = null; return; }
      // stop them the moment you reach for them, so a hold or a double-click lands on someone standing still
      const fl = useStore.getState().ui.floorId; if (fl) this.greet(fl, h.id);
      const press = { id: e.pointerId, x: e.clientX, y: e.clientY, start: performance.now(), agent: h.id, fired: false, timer: 0 };
      press.timer = window.setTimeout(() => {
        if (this.press !== press) return;
        press.fired = true;
        try { navigator.vibrate?.(15); } catch { /* not supported */ }
        const s = useStore.getState();
        if (s.ui.floorId) s.ui$({ agent: press.agent, talk: { deptId: s.ui.floorId, agentKey: press.agent } });
      }, LONG_PRESS_MS);
      this.press = press;
    });
    // Lifting before the timer cancels it. After it fired, the press is kept until the click that follows, so that
    // click does not also open the profile; a cancelled gesture (scroll) never produces a click, so it is dropped.
    const endPress = (cancel: boolean) => {
      if (!this.press) return;
      window.clearTimeout(this.press.timer);
      if (cancel || !this.press.fired) { this.press = null; return; }
      // touch browsers may not send a click after a long press: never let a finished press swallow a later tap
      const done = this.press; setTimeout(() => { if (this.press === done) this.press = null; }, 400);
    };
    cv.addEventListener('pointermove', (e) => { if (this.press && !this.press.fired && Math.hypot(e.clientX - this.press.x, e.clientY - this.press.y) > 8) { window.clearTimeout(this.press.timer); this.press = null; } });
    cv.addEventListener('pointerup', () => endPress(false));
    cv.addEventListener('pointercancel', () => endPress(true));
    // the browser's own long-press menu (and iOS callout) would cover the chat
    cv.addEventListener('contextmenu', (e) => { if (this.press) e.preventDefault(); });
    // touch scrolls the page (touch-action: pan-y); only a mouse/pen drags the camera
    cv.addEventListener('pointerdown', (e) => { this.drag = e.pointerType === 'touch' ? null : { x: e.clientX, y: e.clientY, moved: false }; });
    window.addEventListener('pointerup', () => setTimeout(() => (this.drag = null), 0));
    cv.addEventListener('wheel', (e) => { if (useStore.getState().ui.view !== 'tower' || useStore.getState().ui.execRoom) return; e.preventDefault(); this.zoomBy(e.deltaY < 0 ? 1.12 : 0.89); }, { passive: false });
    // double-click an agent to talk (a mouse cannot hold still on someone walking about)
    cv.addEventListener('dblclick', (e) => {
      const r = cv.getBoundingClientRect(), h = this.hit(e.clientX - r.left, e.clientY - r.top), s = useStore.getState();
      if (h?.kind === 'agent' && s.ui.floorId) s.ui$({ agent: h.id, talk: { deptId: s.ui.floorId, agentKey: h.id } });
    });
    cv.addEventListener('click', (e) => {
      if (this.press?.fired) { this.press = null; return; } // the long press already opened the chat
      if (this.drag?.moved) return;
      const r = cv.getBoundingClientRect(), h = this.hit(e.clientX - r.left, e.clientY - r.top), s = useStore.getState();
      if (!h && s.ui.execRoom) return;
      if (!h) { if (s.ui.view === 'floor') s.ui$({ agent: null, ...(s.ui.panel === 'agent' && { panel: 'dept' as const }) }); return; }
      if (h.kind === 'floor') { if (s.ui.view === 'floor' && s.ui.floorId === h.id) return; s.openFloor(h.id); this.fit(); }
      else if (h.kind === 'ph') { s.openExec(); this.fit(); }
      else if (h.kind === 'obj') { if (s.ui.execRoom) execAction(h.id as ExecObjectId); else if (s.ui.floorId) floorAction(h.id as FloorObjectId, s.ui.floorId); }
      else if (h.kind === 'ghost') s.ui$({ modal: 'create' });
      else if (h.kind === 'agent') { if (s.ui.floorId) this.greet(s.ui.floorId, h.id); s.openPanel('agent', { agent: h.id }); }
    });
  }
}

/** How long to hold an agent (touch, pen or mouse) to open the chat. */
const LONG_PRESS_MS = 500;

/** A happy little double hop (pixels up) after a greeting; a seated agent only bobs in its chair. */
function hopOf(age: number, seated: boolean): number {
  if (age < 0 || age > 0.7) return 0;
  const k = age < 0.35 ? 1 : 0.55, ph = (age % 0.35) / 0.35;
  return Math.round(Math.sin(ph * Math.PI) * (seated ? 1.5 : 5) * k);
}

/* Emotes over heads (feature spec 2.5), from what the agent is actually doing: ! failed, ? waiting on configuration,
   a heart right after finishing, zzz when idling at the desk. Running agents show nothing (their screen does). */
const EMOTES: Record<string, { rows: string[]; col: string }> = {
  bang: { rows: ['010', '010', '010', '000', '010'], col: '#FF5C7A' },
  ask: { rows: ['111', '001', '010', '000', '010'], col: '#FFB547' },
  heart: { rows: ['01010', '11111', '11111', '01110', '00100'], col: '#FF3EA5' },
  zzz: { rows: ['1111', '0010', '0100', '1111'], col: '#B9AED6' },
};
function emote(px: Pix, a: { status: AgentStatus; mode: string; standUntil: number; id: string }, t: number, x: number, y: number) {
  const k = a.status === 'failed' ? 'bang' : a.status === 'awaiting' || a.status === 'disconnected' ? 'ask'
    : a.status === 'completed' && t < a.standUntil ? 'heart' : a.status === 'idle' && a.mode === 'seat' && a.id !== 'chief' ? 'zzz' : null;
  if (!k) return;
  const e = EMOTES[k]!, w = e.rows[0]!.length, bob = Math.floor(t * 2) % 2;
  const pulse = k === 'zzz' ? (Math.floor(t * 1.2) % 3) : 0;
  const bx = Math.floor(x), by = Math.floor(y) - bob - pulse;
  px.rect(bx - 2, by - 2, w + 4, 9, '#F4EEFF'); px.rect(bx - 1, by - 1, w + 2, 7, '#140D26');
  px.rect(bx - 1, by + 7, 2, 1, '#F4EEFF');
  e.rows.forEach((r, j) => { for (let i = 0; i < r.length; i++) if (r[i] === '1') px.rect(bx + i, by + j, 1, 1, e.col, 1); });
}

function pointInPoly(p: Pt, pts: Pt[]) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
