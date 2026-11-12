/* The executive console, the top of the Executive Office panel: the company on an amber screen, three keys (Ops
   board, a new job, the Chief of Staff), the next CEO quest (docs/briefs/05-game-loop.md) with its action, and money
   and runway as four readouts. One flat screen, no device shell, so it reads the same in the side panel and on a phone. */
import { useEffect, useRef, useState } from 'react';
import type { AiUsageSummary } from '@vibe-city/shared';
import { useStore } from '../store';
import { api } from '../../api';
import { Icon } from './kit';
import { Pips, QuestAction } from './QuestLog';
import { nextQuest, progressLabel, sideQuests } from '../data/game';
import { play } from '../sfx';

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** Money rolls to its new value like an odometer (0.9 s, easing out) instead of jumping; `coin` rings when it rises
    after the first value, and the readout flashes. Reduced motion jumps straight there. */
function Rolling({ cents, className = '', coin = false }: { cents: number; className?: string; coin?: boolean }) {
  const [shown, setShown] = useState(cents);
  const [up, setUp] = useState(false);
  const from = useRef(cents);
  useEffect(() => {
    const start = from.current;
    if (start === cents) return;
    from.current = cents;
    if (cents > start) { setUp(true); if (coin) play('coin'); }
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setShown(cents); return; }
    const t0 = performance.now(); let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 900), e = 1 - (1 - k) ** 3;
      setShown(Math.round(start + (cents - start) * e));
      if (k < 1) raf = requestAnimationFrame(step); else window.setTimeout(() => setUp(false), 600);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [cents, coin]);
  return <dd className={`${className}${up ? ' rise' : ''}`}>{usd(shown)}</dd>;
}

export function CeoConsole() {
  const company = useStore((s) => s.company);
  const loaded = useStore((s) => s.loaded);
  const live = useStore((s) => s.conn.backend);
  const game = useStore((s) => s.game);
  const [usage, setUsage] = useState<AiUsageSummary | null>(null);
  useEffect(() => {
    let on = true;
    const load = () => api.aiUsage().then((u) => { if (on) setUsage(u); }).catch(() => undefined);
    void load(); const t = setInterval(load, 30_000);
    return () => { on = false; clearInterval(t); };
  }, []);
  const s = useStore.getState();
  const next = game ? nextQuest(game) : null;
  const r = game?.runway;
  const pct = r?.days == null ? 0 : Math.max(0, Math.min(1, r.days / 30));
  return (
    <section className="ceo" aria-label="Executive console">
      <header className="ceo-head">
        <div className="ceo-eye"><i className={`ceo-led${live ? ' on' : ''}`} aria-hidden="true" />PH · Executive office{loaded ? '' : ' · connecting'}</div>
        <h1 className="ceo-name" tabIndex={-1}>{company?.name ?? 'Your company'}</h1>
      </header>
      <nav className="ceo-keys" aria-label="Executive keys">
        <button className="ceo-key" onClick={() => s.openPanel('board', { composer: true, composerDept: null, boardDept: null })}><Icon n="plus" size={14} />New job</button>
        <button className="ceo-key" onClick={() => s.ui$({ newDept: true })}><Icon n="users" size={14} />Staff</button>
      </nav>
      {game && (
        <section className="ceo-quest" aria-label="Your quest">
          <div className="ceo-qhead">
            <Pips g={game} />
            <button className="ceo-log" onClick={() => s.ui$({ questLog: true })}>Log · {progressLabel(game)}</button>
          </div>
          {next ? <>
            <h2 className="ceo-q">{next.title}</h2>
            <p className="ceo-hint">{next.hint}</p>
            <div className="ceo-act"><QuestAction q={next} compact />{next.unlocks && <span className="ceo-unl"><Icon n="lock" size={11} />Unlocks {next.unlocks}</span>}</div>
          </> : <>
            <h2 className="ceo-q">The company is public.</h2>
            {/* the main line is over: point at what is left instead of ending on a dead screen */}
            {sideQuests(game).some((q) => !q.done) && <>
              <p className="ceo-hint">Side quests are still open: each one opens another floor.</p>
              <div className="ceo-act"><button className="btn primary small" onClick={() => s.ui$({ questLog: true })}>See side quests</button></div>
            </>}
          </>}
        </section>
      )}
      {r && (
        <dl className="ceo-stats" aria-label="Money and runway, an estimate">
          <div className="ceo-run">
            <dt>Runway</dt>
            <dd>{r.days === null ? '—' : r.days > 999 ? '999+ d' : `${r.days} d`}</dd>
            <span className="ceo-bar" aria-hidden="true"><i style={{ width: `${pct * 100}%` }} /></span>
          </div>
          <div><dt>Earned</dt><Rolling cents={r.earnedCents} className="up" coin /></div>
          <div><dt>Burned today</dt><Rolling cents={usage?.companyTodayCents ?? 0} className="down" /></div>
          <div><dt>Avg / day</dt><Rolling cents={r.dailyBurnCents} /></div>
        </dl>
      )}
    </section>
  );
}
