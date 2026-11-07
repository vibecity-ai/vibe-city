/* A small 5-field cron (minute hour day-of-month month day-of-week) evaluated in an IANA time zone.
   Supports *, numbers, lists (1,15), ranges (1-5), steps (*\/15, 9-17/2) and day names (mon-fri) / month names.
   Day-of-month and day-of-week follow Vixie cron: when both are restricted, either may match. */

const NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

export interface Cron { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domStar: boolean; dowStar: boolean }

function field(src: string, lo: number, hi: number, what: string): { set: Set<number>; star: boolean } {
  const set = new Set<number>();
  const num = (s: string) => { const n = NAMES[s.toLowerCase()] ?? Number(s); if (!Number.isInteger(n)) throw new Error(`bad ${what}: "${s}"`); return n; };
  for (const part of src.split(',')) {
    const [range, stepS] = part.split('/');
    const step = stepS === undefined ? 1 : Number(stepS);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in ${what}: "${part}"`);
    let a: number, b: number;
    if (range === '*') { a = lo; b = hi; }
    else if (range!.includes('-')) { const [x, y] = range!.split('-'); a = num(x!); b = num(y!); }
    else { a = num(range!); b = stepS === undefined ? a : hi; }
    if (what === 'day of week' && b === 7) b = 7;
    if (a < lo || b > (what === 'day of week' ? 7 : hi) || a > b) throw new Error(`${what} out of range: "${part}"`);
    for (let v = a; v <= b; v += step) set.add(what === 'day of week' && v === 7 ? 0 : v);
  }
  return { set, star: src === '*' || src.startsWith('*/') };
}

export function parseCron(expr: string): Cron {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error('a schedule needs 5 fields: minute hour day-of-month month day-of-week');
  const m = field(f[0]!, 0, 59, 'minute'), h = field(f[1]!, 0, 23, 'hour'), dom = field(f[2]!, 1, 31, 'day of month');
  const mon = field(f[3]!, 1, 12, 'month'), dow = field(f[4]!, 0, 6, 'day of week');
  return { minute: m.set, hour: h.set, dom: dom.set, month: mon.set, dow: dow.set, domStar: dom.star, dowStar: dow.star };
}

export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

const fmts = new Map<string, Intl.DateTimeFormat>();
/** Wall-clock parts of an instant in a time zone. */
function parts(t: number, tz: string) {
  let f = fmts.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' }); fmts.set(tz, f); }
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(t))) o[p.type] = p.value;
  return { month: Number(o.month), day: Number(o.day), hour: Number(o.hour) % 24, minute: Number(o.minute), dow: NAMES[(o.weekday ?? 'sun').slice(0, 3).toLowerCase()]! };
}

/** The first fire time strictly after `after`, or null if none within ~13 months. */
export function nextRun(c: Cron, tz: string, after: Date): Date | null {
  const MIN = 60_000;
  let t = Math.floor(after.getTime() / MIN) * MIN + MIN;
  const end = t + 400 * 24 * 60 * MIN;
  while (t < end) {
    const p = parts(t, tz);
    if (!c.month.has(p.month)) { t += ((24 - p.hour) * 60 - p.minute) * MIN; continue; }
    const domOk = c.dom.has(p.day), dowOk = c.dow.has(p.dow);
    const dayOk = c.domStar && c.dowStar ? true : c.domStar ? dowOk : c.dowStar ? domOk : domOk || dowOk;
    if (!dayOk) { t += ((24 - p.hour) * 60 - p.minute) * MIN; continue; }
    if (!c.hour.has(p.hour)) { t += (60 - p.minute) * MIN; continue; }
    if (!c.minute.has(p.minute)) { t += MIN; continue; }
    return new Date(t);
  }
  return null;
}
