/* The sheets a department floor's controls open (see data/floor.ts):
   - Tools & access (the server rack): which tools this floor's work really needs and whether they are on, the
     extras it does not need (risky ones first), and the skills the work uses.
   - The station (a template's own object): what the team works with, who on the team uses it, what the game reads
     from its results, and its recent quests. The Marketplace Agency's Job board lists its market.near.ai jobs instead:
     the ones delivered (submitted) or completed (accepted), as the backend's poller last saw them. */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Inventory, MarketJob } from '@vibe-city/shared';
import { useStore } from '../store';
import { api, ApiError } from '../../api';
import { Icon, useDialog } from './kit';
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

function FloorSheet({ kind, deptId }: { kind: 'tools' | 'station'; deptId: string }) {
  const d = useStore((s) => s.depts.find((x) => x.id === deptId));
  const allQuests = useStore((s) => s.quests);
  const quests = useMemo(() => allQuests.filter((q) => q.deptId === deptId), [allQuests, deptId]);
  const ref = useRef<HTMLDivElement>(null);
  const [inv, setInv] = useState<Inventory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const close = () => useStore.getState().ui$({ floorSheet: null });
  useDialog(ref, true, close);
  useEffect(() => { api.inventory(deptId).then(setInv).catch((e: ApiError) => setError(e.message)); }, [deptId]);
  const market = kind === 'station' && d?.view.templateId === 'marketplace-agency';
  const [jobs, setJobs] = useState<MarketJob[] | null>(null);
  useEffect(() => {
    if (market) api.market().then((m) => setJobs(m.jobs.filter((j) => j.state === 'submitted' || j.state === 'accepted'))).catch((e: ApiError) => setError(e.message));
  }, [market]);
  if (!d) return null;
  const templateId = d.view.templateId;
  const st = stationFor(templateId);
  const report = inv ? toolsReport(templateId, inv) : null;
  const s = useStore.getState();
  const lib = (skill: string | null) => { close(); s.ui$({ skillLib: { deptId, skill } }); };
  const toLoadout = () => { close(); s.openPanel('dept', { deptTab: 'loadout', agent: null }); };
  const missing = report?.needed.filter((t) => !t.on).length ?? 0;
  const risky = report?.extra.filter((t) => t.risky).length ?? 0;
  const users = (ids: string[]) => d.view.agents.filter((a) => a.skills.some((k) => ids.includes(k))).map((a) => a.title ?? (a.lead ? 'Lead' : a.key));
  const done = quests.filter((q) => q.summary.status === 'completed').slice(0, 4);

  return (
    <div className="hire-scrim" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="hire exec-modal fs" ref={ref} role="dialog" aria-modal="true" aria-labelledby="fs-t">
        <header className="hire-head">
          <div><span className="dlg-tag">{d.name}</span><h2 id="fs-t">{kind === 'tools' ? 'Tools & access' : st?.name ?? 'Station'}</h2></div>
          <button className="dlg-icon" onClick={close} aria-label="Close"><Icon n="x" size={14} /></button>
        </header>
        {error && <p className="err-t" role="alert">{error}</p>}
        {!report && !error && <p className="muted small" role="status">Reading the loadout…</p>}

        {kind === 'tools' && report && (
          <>
            <p className="fs-lead">{report.plain
              ? 'This floor was not hired from a template, so there is no list of what it needs. These are the tools its agents can use.'
              : missing ? `${missing} tool${missing === 1 ? '' : 's'} this floor needs ${missing === 1 ? 'is' : 'are'} switched off: its quests will stall.`
              : risky ? `Everything this floor needs is on. ${risky} risky tool${risky === 1 ? ' it does not need is' : 's it does not need are'} on too: switch ${risky === 1 ? 'it' : 'them'} off unless you mean it.`
              : 'Everything this floor needs is on, and nothing more.'}</p>
            {!report.plain && <section aria-labelledby="fs-need"><h3 className="sec-t" id="fs-need">What the work needs</h3><ul className="fs-tools">{report.needed.map((t) => <ToolRow key={t.id} t={t} need />)}</ul></section>}
            {report.extra.length > 0 && <section aria-labelledby="fs-extra"><h3 className="sec-t" id="fs-extra">{report.plain ? 'Tools on' : 'Also on'}</h3><ul className="fs-tools">{report.extra.map((t) => <ToolRow key={t.id} t={t} need={report.plain} />)}</ul></section>}
            {report.skills.length > 0 && (
              <section aria-labelledby="fs-sk"><h3 className="sec-t" id="fs-sk">Skills the work uses</h3>
                <ul className="fs-skills">{report.skills.map((k) => <li key={k.id} className={k.on ? 'ok' : 'missing'}><button className="fs-sk" onClick={() => lib(k.id)}><SkillBadge name={k.id} size={12} /><b>{skillMeta(k.id).label}</b></button><span>{k.on ? (users([k.id]).join(', ') || 'Equipped') : 'Not equipped'}</span></li>)}</ul>
              </section>
            )}
            <p className="fine">Memory, to-do, Kanban, skills and past-chat search are always on: every floor needs them. Changes take effect after a Sync.</p>
            <div className="fs-act"><button className="btn primary small" onClick={toLoadout}>Change the loadout</button><button className="btn secondary small" onClick={() => lib(null)}>Skill library</button></div>
          </>
        )}

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
              {done.length === 0 ? <p className="muted small">Nothing finished yet. Give the floor a quest.</p>
                : <ul className="fs-done">{done.map((q) => <li key={q.summary.id}><button className="link" onClick={() => { close(); s.openPanel('quest', { questId: q.summary.id, questFrom: 'board' }); }}>{q.summary.title}</button></li>)}</ul>}
            </section>}
            <div className="fs-act">
              <button className="btn primary small" onClick={() => { close(); s.openPanel('board', { composer: true, composerDept: deptId, boardDept: deptId, boardFilter: 'all' }); }}>Give it a quest</button>
              <button className="btn secondary small" onClick={() => s.ui$({ floorSheet: 'tools' })}>Tools & access</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
