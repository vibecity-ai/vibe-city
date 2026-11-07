/* Runway (docs/briefs/05-game-loop.md): days of model credits left at the current burn, what the company earned,
   and today's burn per floor. Always an estimate. */
import { useEffect, useState } from 'react';
import type { AiUsageSummary } from '@vibe-city/shared';
import { useStore } from '../store';
import { api } from '../../api';

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function RunwayCard() {
  const game = useStore((s) => s.game);
  const depts = useStore((s) => s.depts);
  const [usage, setUsage] = useState<AiUsageSummary | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => api.aiUsage().then((u) => { if (live) setUsage(u); }).catch(() => undefined);
    void load(); const t = setInterval(load, 30_000);
    return () => { live = false; clearInterval(t); };
  }, []);
  if (!game) return null;
  const r = game.runway;
  const max = Math.max(1, ...(usage?.byDepartment.map((d) => Math.max(d.todayCents, d.budgetCents ?? 0)) ?? [1]));
  return (
    <section className="pane-sec">
      <h3 className="sec-t">Runway <span className="muted small">estimate</span></h3>
      <div className="runway">
        <div className="runway-days"><b>{r.days === null ? '—' : r.days}</b><span>{r.days === null ? (r.creditsRemainingCents === null ? 'enter the credits you loaded' : 'no burn yet') : 'days of credits left'}</span></div>
        <div className="runway-nums">
          <span><i>Earned</i>{usd(r.earnedCents)}</span>
          <span><i>Burned today</i>{usd(usage?.companyTodayCents ?? 0)}</span>
          <span><i>Avg / day</i>{usd(r.dailyBurnCents)}</span>
          {r.creditsRemainingCents !== null && <span><i>Credits left</i>{usd(r.creditsRemainingCents)}</span>}
        </div>
      </div>
      {usage && usage.byDepartment.length > 0 && (
        <ul className="burn">
          {usage.byDepartment.map((d) => (
            <li key={d.departmentId} className={d.overBudget ? 'over' : ''}>
              <span className="burn-n">{depts.find((x) => x.id === d.departmentId)?.name ?? '—'}</span>
              <span className="burn-bar"><i style={{ width: `${Math.round((d.todayCents / max) * 100)}%` }} />{d.budgetCents !== null && <em style={{ left: `${Math.round((d.budgetCents / max) * 100)}%` }} title={`Budget ${usd(d.budgetCents)}`} />}</span>
              <span className="burn-v">{usd(d.todayCents)}{d.budgetCents !== null ? ` / ${usd(d.budgetCents)}` : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
