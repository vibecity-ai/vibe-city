/* The sheet a template's station opens (see data/floor.ts; the server rack opens the floor's loadout):
   - The station (a template's own object): what the team works with, who on the team uses it, what the game reads
     from its results, and its recent quests. The Marketplace Agency's Job board lists its market.near.ai jobs instead:
     the ones delivered (submitted) or completed (accepted), as the backend's poller last saw them. */
import { useEffect, useMemo, useState } from 'react';
import type { Inventory, MarketJob } from '@vibe-city/shared';
import { useStore } from '../store';
import { api, ApiError } from '../../api';
import { Icon } from './kit';
import { DeskSheet } from './Desk';
import { stationFor, toolsReport, type ToolLine } from '../data/floor';
import { SkillBadge } from './Skills';
import { JOB_LABEL } from './QuestLog';
import { skillMeta } from '../data/skills';

export function FloorSheetWindow() {
  const kind = useStore((s) => s.ui.floorSheet);
  const deptId = useStore((s) => s.ui.floorId);
  return kind && deptId ? <FloorSheet kind={kind} deptId={deptId} /> : null;
}

function ToolRow({ t, need }: { t: ToolLine; need: boolean }) {
  const state = need ? (t.on ? 'ok' : 'missing') : t.risky ? 'risky' : 'extra';
  const tag = { ok: 'On', missing: 'Off: work will stall', risky: 'Not needed · risky', extra: 'Not needed' }[state];
  return (
    <li className={`fs-tool ${state}`}>
      <span className="fs-dot" aria-hidden="true" />
      <span className="fs-tool-t"><b>{t.label}</b><small>{t.does}</small></span>
      <span className="fs-tag">{tag}</span>
    </li>
  );
}

function FloorSheet({ kind, deptId }: { kind: 'station'; deptId: string }) {
  const d = useStore((s) => s.depts.find((x) => x.id === deptId));
  const allQuests = useStore((s) => s.quests);
  const quests = useMemo(() => allQuests.filter((q) => q.deptId === deptId), [allQuests, deptId]);
  const [inv, setInv] = useState<Inventory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const close = () => useStore.getState().ui$({ floorSheet: null });
  useEffect(() => { api.inventory(deptId).then(setInv).catch((e: ApiError) => setError(e.message)); }, [deptId]);
  const market = kind === 'station' && d?.view.templateId === 'marketplace-agency';
  const [jobs, setJobs] = useState<MarketJob[] | null>(null);
  useEffect(() => {
    if (market) api.market().then((m) => setJobs(m.jobs.filter((j) => j.state === 'submitted' || j.state === 'accepted'))).catch((e: ApiError) => setError(e.message));
  }, [market]);
  if (!d) return null;
  const templateId = d.view.templateId;
  const st = stationFor(templateId);
  const sheetTitle = st?.name ?? 'Station';
  const report = inv ? toolsReport(templateId, inv) : null;
  const s = useStore.getState();
  const lib = (skill: string | null) => { close(); s.ui$({ skillLib: { deptId, skill } }); };
  const toLoadout = () => { close(); s.openPanel('dept', { deptTab: 'loadout', agent: null }); };
  const missing = report?.needed.filter((t) => !t.on).length ?? 0;
  const users = (ids: string[]) => d.view.agents.filter((a) => a.skills.some((k) => ids.includes(k))).map((a) => a.title ?? (a.lead ? 'Lead' : a.key));
  const done = quests.filter((q) => q.summary.status === 'completed').slice(0, 4);

  return (
    <DeskSheet title={sheetTitle} onClose={close} className="exec-modal fs">
        <header className="hire-head">
          <div><span className="dlg-tag">{d.name}</span><h2>{sheetTitle}</h2></div>
        </header>
        {error && <p className="err-t" role="alert">{error}</p>}
        {!report && !error && <p className="muted small" role="status">Reading the loadout…</p>}

        {kind === 'station' && st && report && (
          <>
            <p className="fs-lead">{st.blurb}</p>
            <div className="fs-badges">
              {st.wallet && <span className="fs-badge gold"><Icon n="lock" size={11} />Shared company wallet</span>}
              {st.marker && <span className="fs-badge"><Icon n="sparkle" size={11} />Results carry <code>{st.marker}</code></span>}
              {missing > 0 && <span className="fs-badge bad">{missing} needed tool{missing === 1 ? '' : 's'} off</span>}
            </div>
            <section aria-labelledby="fs-uses"><h3 className="sec-t" id="fs-uses">Works with</h3>
              <ul className="fs-tools">{report.needed.map((t) => <ToolRow key={t.id} t={t} need />)}</ul>
              {report.skills.length > 0 && <ul className="fs-skills">{report.skills.map((k) => <li key={k.id} className={k.on ? 'ok' : 'missing'}><button className="fs-sk" onClick={() => lib(k.id)}><SkillBadge name={k.id} size={12} /><b>{skillMeta(k.id).label}</b></button><span>{users([k.id]).join(', ') || (k.on ? 'Equipped' : 'Not equipped')}</span></li>)}</ul>}
            </section>
            {market ? (
              <section aria-labelledby="fs-done"><h3 className="sec-t" id="fs-done">Delivered on market.near.ai</h3>
                {!jobs ? <p className="muted small" role="status">Reading the market…</p>
                  : jobs.length === 0 ? <p className="muted small">No job delivered yet. Buyers hire the company on market.near.ai.</p>
                  : <ul className="mk-jobs">{jobs.map((j) => (
                    <li key={j.assignmentId}>
                      <button className="link mk-job-t" onClick={() => { close(); s.openPanel('quest', { questId: j.questId, questFrom: 'board' }); }}>{j.title}</button>
                      <span className="mk-amt">{Number(j.amount)} {j.token}</span>
                      <span className={`chip sm mk-st ${j.state}`}>{JOB_LABEL[j.state]}{j.rounds > 1 ? ` · rev ${j.rounds - 1}` : ''}</span>
                    </li>))}</ul>}
              </section>
            ) : <section aria-labelledby="fs-done"><h3 className="sec-t" id="fs-done">Recently finished</h3>
              {done.length === 0 ? <p className="muted small">Nothing finished yet. Give the floor a job.</p>
                : <ul className="fs-done">{done.map((q) => <li key={q.summary.id}><button className="link" onClick={() => { close(); s.openPanel('quest', { questId: q.summary.id, questFrom: 'board' }); }}>{q.summary.title}</button></li>)}</ul>}
            </section>}
            <div className="fs-act">
              <button className="btn primary small" onClick={() => { close(); s.openPanel('board', { composer: true, composerDept: deptId, boardDept: deptId, boardFilter: 'all' }); }}>Give it a job</button>
              <button className="btn secondary small" onClick={toLoadout}>Loadout</button>
            </div>
          </>
        )}
    </DeskSheet>
  );
}
