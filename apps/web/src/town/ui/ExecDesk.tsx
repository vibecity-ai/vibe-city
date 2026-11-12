/* The Executive Office below CEO-1: three more things on the CEO's desk, in the device kit's language.
   - InTray: what waits for the CEO (decisions, stuck quests, floors that need attention or set-up) as paper slips in
     a tray, each with a stamp and one key. An empty tray says so.
   - StatusBoard (BOARD-2): an LED board with the company's four counters and today's burn per floor as segment
     meters.
   - Directory: the lobby's felt letter board, one line per floor, with a status light; a line opens the floor. */
import { useStore, floorNum } from '../store';
import { Device, Screen } from './Device';
import { deptStatus, statusColor } from './kit';
import { blockedQuests, trayQuests } from '../data/company';
import { KIND, openDecision } from './DecisionsList';
import { useEffect, useState } from 'react';
import type { AiUsageSummary } from '@vibe-city/shared';
import { api } from '../../api';

/** Today's model spend, refreshed every 30 s; null until the first answer. */
function useUsage(): AiUsageSummary | null {
  const [usage, setUsage] = useState<AiUsageSummary | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => api.aiUsage().then((u) => { if (live) setUsage(u); }).catch(() => undefined);
    void load(); const t = setInterval(load, 30_000);
    return () => { live = false; clearInterval(t); };
  }, []);
  return usage;
}

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const Led = ({ value, tone, label, alert }: { value: number; tone: string; label: string; alert?: boolean }) => (
  <div className={`sb-cell${alert ? ' alert' : ''}`} style={{ ['--t' as string]: tone }}>
    <span className="lcd-seg sb-n" data-ghost={String(value).replace(/[0-9]/g, '8').padStart(2, '8')}>{String(value).padStart(2, ' ')}</span>
    <span className="sb-l"><i aria-hidden="true" />{label}</span>
  </div>
);

export function InTray() {
  const game = useStore((s) => s.game);
  const depts = useStore((s) => s.depts);
  const quests = useStore((s) => s.quests);
  const openPanel = useStore((s) => s.openPanel);
  const openFloor = useStore((s) => s.openFloor);
  const name = (id: string | null | undefined) => depts.find((d) => d.id === id)?.name ?? 'A floor';
  const slips: { key: string; stamp: string; tone: 'bad' | 'warn'; title: string; sub: string; act: string; go: () => void }[] = [];
  for (const d of game?.decisions ?? []) slips.push({ key: d.id, stamp: KIND[d.kind].label, tone: d.kind === 'budget' ? 'bad' : 'warn', title: d.title, sub: name(d.departmentId), act: KIND[d.kind].label, go: () => openDecision(d.href) });
  for (const q of trayQuests(quests, game?.decisions ?? [])) {
    const c = q.summary.counts;
    slips.push({ key: q.summary.id, stamp: c.failed ? 'Stuck' : 'Answer', tone: c.failed ? 'bad' : 'warn', title: q.summary.title,
      sub: `${name(q.deptId)} · ${c.blocked ? `${c.blocked} waiting for you` : ''}${c.blocked && c.failed ? ' · ' : ''}${c.failed ? `${c.failed} stuck after failing` : ''}`,
      act: c.blocked + c.failed === 1 ? 'Answer' : 'Review', go: () => openPanel('quest', { questId: q.summary.id, questFrom: 'board' }) });
  }
  for (const d of depts.filter((x) => x.state === 'attention' || x.state === 'offline' || x.state === 'unconfigured')) {
    slips.push({ key: d.id, stamp: d.state === 'unconfigured' ? 'Set up' : d.state === 'offline' ? 'Offline' : 'Check', tone: d.state === 'unconfigured' ? 'warn' : 'bad',
      title: d.name, sub: d.attention ?? deptStatus(d.state).label, act: d.state === 'unconfigured' ? 'Set up' : 'Open', go: () => openFloor(d.id) });
  }
  return (
    <section className="pane-sec tray-sec" aria-labelledby="tray-h">
      <h3 className="sec-t" id="tray-h">In tray {slips.length > 0 && <span className="count bad">{slips.length}</span>}</h3>
      <div className={`tray${slips.length ? '' : ' empty'}`}>
        {slips.length === 0
          ? <p className="tray-clear"><b>Your desk is clear.</b><span>Decisions, stuck jobs and floors that need you land here.</span></p>
          : slips.map((x, i) => (
            <button key={x.key} className={`slip ${x.tone}`} style={{ ['--tilt' as string]: `${(i % 2 ? 0.5 : -0.4)}deg` }} onClick={x.go}>
              <span className="slip-t"><b>{x.title}</b><small>{x.sub}</small></span>
              <span className="slip-act">{x.act}</span>
              <span className="slip-stamp" aria-hidden="true">{x.stamp}</span>
            </button>
          ))}
      </div>
    </section>
  );
}

export function StatusBoard() {
  const depts = useStore((s) => s.depts);
  const quests = useStore((s) => s.quests);
  const usage = useUsage();
  const running = depts.reduce((n, d) => n + d.workers.filter((w) => w.status === 'running').length + (d.chief?.status === 'running' ? 1 : 0), 0);
  const attention = depts.filter((d) => d.state === 'attention' || d.state === 'offline').length + blockedQuests(quests).length;
  const unsynced = depts.filter((d) => d.state === 'unconfigured').length;
  const burn = usage?.byDepartment ?? [];
  const max = Math.max(1, ...burn.map((d) => Math.max(d.todayCents, d.budgetCents ?? 0)));
  return (
    <section className="pane-sec">
      <Device model="BOARD-2" name="company status" led={attention ? 'amber' : 'green'} className="sb">
        <Screen kind="led" label="Company status">
          <div className="sb-grid">
            <Led value={depts.length} tone="#FFC46B" label="Floors" />
            <Led value={running} tone="#7FF3FF" label="At work" />
            <Led value={attention} tone="#FF6B7F" label="Need you" alert={attention > 0} />
            <Led value={unsynced} tone="#FFC46B" label="Not synced" />
          </div>
          <div className="scr-rule" />
          <div className="scr-row sb-h"><span>Burn today</span><span>{usd(usage?.companyTodayCents ?? 0)}</span></div>
          {burn.length === 0 && <p className="scr-mono sb-quiet">No floor has spent anything today.</p>}
          <ul className="sb-meters">
            {burn.map((b) => {
              const lit = Math.round((b.todayCents / max) * 12);
              const cap = b.budgetCents !== null ? Math.round((b.budgetCents / max) * 12) : null;
              return (
                <li key={b.departmentId} className={b.overBudget ? 'over' : ''}>
                  <span className="sb-fl">F{floorNum(depts, b.departmentId)}</span>
                  <span className="sb-seg" aria-hidden="true">{Array.from({ length: 12 }, (_, i) => <i key={i} className={`${i < lit ? 'on' : ''}${i >= 9 ? ' hi' : ''}${cap === i ? ' cap' : ''}`} />)}</span>
                  <span className="sb-v">{usd(b.todayCents)}{b.budgetCents !== null ? ` / ${usd(b.budgetCents)}` : ''}</span>
                </li>
              );
            })}
          </ul>
        </Screen>
      </Device>
    </section>
  );
}

export function Directory() {
  const depts = useStore((s) => s.depts);
  const loaded = useStore((s) => s.loaded);
  const company = useStore((s) => s.company);
  const openFloor = useStore((s) => s.openFloor);
  const openExec = useStore((s) => s.openExec);
  return (
    <section className="pane-sec" aria-labelledby="dir-h">
      <h3 className="sec-t" id="dir-h">Directory</h3>
      <div className="dir">
        <p className="dir-head" aria-hidden="true">{company?.name ?? 'Vibe City'}</p>
        <ul>
          <li><button className="dir-row" onClick={openExec}><span className="dir-f">PH</span><span className="dir-n">Executive office</span><span className="dir-dots" aria-hidden="true" /><i style={{ background: 'var(--gold)' }} aria-hidden="true" /></button></li>
          {depts.map((d) => {
            const st = deptStatus(d.state);
            return (
              <li key={d.id}>
                <button className="dir-row" onClick={() => openFloor(d.id)} aria-label={`F${floorNum(depts, d.id)} ${d.name}: ${st.label}`}>
                  <span className="dir-f">{floorNum(depts, d.id)}</span><span className="dir-n">{d.name}</span><span className="dir-dots" aria-hidden="true" />
                  <span className="dir-st">{st.label}</span><i style={{ background: statusColor(st.k), boxShadow: `0 0 6px ${statusColor(st.k)}` }} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
        {loaded && depts.length === 0 && <p className="dir-empty">No floors yet. The next one goes up when you add one.</p>}
      </div>
    </section>
  );
}
