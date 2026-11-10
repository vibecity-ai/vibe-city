/* The big moments of the company, celebrated: a neon banner drops in at the top of the screen with a sound when a floor
   is built, a job starts or finishes, the Chief of Staff starts scouting or has a shortlist, someone is hired, or a job
   needs the CEO. Small things (a task done or failed) only get a sound. Banners queue, one at a time; the city draws
   its own effect for each (world/City.ts play). */
import { useEffect, useRef, useState } from 'react';
import { useStore, type Fx } from '../store';
import { agentLabel } from '../data/views';
import { play, type Sfx } from '../sfx';
import { Icon } from './kit';

interface Moment { key: number; kicker: string; title: string; sub: string | null; col: string; icon: string; big: boolean }

const SHOW_MS = 3600;

/** What a city event looks and sounds like, or null when it is too small for a banner. */
function momentOf(fx: Fx, key: number): { m: Moment | null; sfx: Sfx | null } {
  const s = useStore.getState();
  const floor = (id: string) => s.depts.find((d) => d.id === id)?.name ?? 'a floor';
  const m = (kicker: string, title: string, sub: string | null, col: string, icon: string, big = false): Moment => ({ key, kicker, title, sub, col, icon, big });
  switch (fx.k) {
    case 'floorAdded': return { m: m('New floor', floor(fx.dept), 'Built and opening now', 'var(--cyan)', 'building', true), sfx: 'floor' };
    case 'questStarted': return { m: m('New job', fx.title, `for ${floor(fx.dept)}`, 'var(--gold)', 'file'), sfx: 'job' };
    case 'questDone': return { m: m('Job done', fx.title, floor(fx.dept), 'var(--mint, #7CF5B4)', 'check', true), sfx: 'done' };
    case 'needsYou': return { m: m('Needs you', fx.title, `${floor(fx.dept)} is waiting on your answer`, 'var(--amber, #FFB547)', 'bell'), sfx: 'input' };
    case 'workerJoined': {
      const name = agentLabel(fx.worker, s.personas[`${fx.dept}:${fx.worker}`]);
      return { m: m('New hire', name, `joined ${floor(fx.dept)}`, 'var(--pink, #FF3EA5)', 'plus', true), sfx: 'hire' };
    }
    case 'hiring':
      if (fx.phase === 'scouting') return { m: m('Scouting', 'The Chief of Staff is looking for a hire', fx.floor ? `for ${fx.floor}` : null, '#9B5CFF', 'search'), sfx: 'scout' };
      if (fx.phase === 'shortlist') return { m: m('Shortlist ready', 'Candidates are waiting to meet you', 'Pick up the Chief of Staff’s call', '#9B5CFF', 'phone'), sfx: 'shortlist' };
      return { m: null, sfx: null };
    case 'taskDone': return { m: null, sfx: 'tick' };
    case 'taskFail': return { m: null, sfx: 'fail' };
    case 'chiefArrived': return { m: null, sfx: 'hire' };
    default: return { m: null, sfx: null };
  }
}

export function Moments() {
  const fx = useStore((s) => s.fx);
  // only what happens from now on: never replay the backlog on mount
  const seen = useRef(useStore.getState().fx.at(-1)?.seq ?? 0);
  const [queue, setQueue] = useState<Moment[]>([]);
  const [cur, setCur] = useState<Moment | null>(null);

  useEffect(() => {
    const fresh: Moment[] = [];
    for (const { seq, fx: f } of fx) {
      if (seq <= seen.current) continue;
      seen.current = seq;
      const { m, sfx } = momentOf(f, seq);
      if (sfx) play(sfx);
      if (m) fresh.push(m);
    }
    if (fresh.length) setQueue((q) => [...q, ...fresh].slice(-4));
  }, [fx]);

  // the Chief of Staff's hiring request moving on (polled): scouting started, shortlist in
  useEffect(() => useStore.subscribe((s, p) => {
    const h = s.hiring, was = p.hiring;
    if (!h || !was || h.id !== was.id || h.state === was.state) return;
    if (h.state === 'scouting' || h.state === 'shortlist') s.emit({ k: 'hiring', phase: h.state, floor: h.brief?.departmentName ?? null });
  }), []);

  useEffect(() => {
    if (cur || !queue.length) return;
    setCur(queue[0]!); setQueue((q) => q.slice(1));
  }, [cur, queue]);
  useEffect(() => {
    if (!cur) return;
    const id = window.setTimeout(() => setCur(null), SHOW_MS);
    return () => window.clearTimeout(id);
  }, [cur]);

  if (!cur) return null;
  return (
    <div className="moment-wrap" role="status" aria-live="polite">
      <div key={cur.key} className={`moment${cur.big ? ' big' : ''}`} style={{ '--mc': cur.col } as React.CSSProperties} onClick={() => setCur(null)}>
        <span className="moment-ic"><Icon n={cur.icon} size={22} sw={2.4} /></span>
        <span className="moment-tx">
          <small>{cur.kicker}</small>
          <b>{cur.title}</b>
          {cur.sub && <span>{cur.sub}</span>}
        </span>
        {cur.big && <span className="moment-sparks" aria-hidden="true">{Array.from({ length: 14 }, (_, i) => <i key={i} style={{ '--a': `${(i / 14) * 360}deg`, '--d': `${60 + (i % 3) * 26}px` } as React.CSSProperties} />)}</span>}
      </div>
    </div>
  );
}
