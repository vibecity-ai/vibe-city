/* CEO-1, the executive console: the top of the Executive Office panel as a device. An amber CRT shows the company,
   the next CEO quest (docs/briefs/05-game-loop.md) as a ticket with its action, and the runway as a needle meter;
   three keys open the Ops board, a new job and the Chief of Staff. */
import { useEffect, useState } from 'react';
import type { AiUsageSummary } from '@vibe-city/shared';
import { useStore } from '../store';
import { api } from '../../api';
import { Device, Gauge, Key, Screen } from './Device';
import { Pips, QuestAction } from './QuestLog';
import { nextQuest, progressLabel } from '../data/game';

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

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
  const idx = game && next ? game.quests.indexOf(next) + 1 : 0;
  const r = game?.runway;
  return (
    <Device model="CEO-1" name="executive console" shell="beige" led={live ? 'green' : 'off'} className="ceo-dev">
      <Screen kind="amber" className="ceo-scr">
        <div className="scr-eyebrow">PH · Executive office{loaded ? '' : ' · connecting'}</div>
        <h1 className="scr-big" tabIndex={-1}>{company?.name ?? 'Your company'}</h1>
        <div className="scr-rule" />
        {game && (
          <section className="ceo-ticket" aria-label="Your quest">
            <div className="scr-row"><span>{next ? `Quest ${String(idx).padStart(2, '0')}/${game.quests.length}` : 'All quests done'}</span><Pips g={game} /></div>
            {next ? <>
              <h2 className="ceo-q">{next.title}</h2>
              <p className="scr-mono">{next.hint}</p>
              <div className="ceo-act"><QuestAction q={next} />{next.unlocks && <span className="scr-mono ceo-unl">Unlocks: {next.unlocks}</span>}</div>
            </> : <h2 className="ceo-q">The company is public.</h2>}
            <button className="ceo-log scr-mono" onClick={() => s.ui$({ questLog: true })}>Quest log · {progressLabel(game)} ▸</button>
          </section>
        )}
        {r && (
          <section className="ceo-runway" aria-label="Runway, an estimate">
            <Gauge value={r.days} max={30} ticks={[0, 7, 14, 21, 30]} label="RUNWAY · DAYS" />
            <dl className="ceo-read">
              <div><dt>Earned</dt><dd className="up">{usd(r.earnedCents)}</dd></div>
              <div><dt>Burned today</dt><dd className="down">{usd(usage?.companyTodayCents ?? 0)}</dd></div>
              <div><dt>Avg / day</dt><dd>{usd(r.dailyBurnCents)}</dd></div>
              <div><dt>Days left</dt><dd>{r.days === null ? '—' : r.days}</dd></div>
            </dl>
          </section>
        )}
      </Screen>
      <div className="ceo-keys" role="group" aria-label="Executive keys">
        <Key onClick={() => s.openPanel('board', { composer: false, boardDept: null })}>Ops board</Key>
        <Key onClick={() => s.openPanel('board', { composer: true, composerDept: null, boardDept: null })}>New job</Key>
        <Key onClick={() => s.ui$({ newDept: true })}>Staff</Key>
      </div>
    </Device>
  );
}
