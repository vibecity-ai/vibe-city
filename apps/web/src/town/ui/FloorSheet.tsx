/* The sheet a template's station opens (see data/floor.ts; the server rack opens the floor's loadout):
   - The station (a template's own object): what the team works with, who on the team uses it, what the game reads
     from its results, and its recent quests. The floor listed on the Agent Market has the Marketplace board instead: its
     market.near.ai jobs in progress, delivered and paid, and what they earned, as the backend's poller last saw them. */
import { useEffect, useMemo, useState } from 'react';
import type { Inventory, MarketAgent, MarketProfile } from '@vibe-city/shared';
import { useStore } from '../store';
import { api, ApiError } from '../../api';
import { Icon } from './kit';
import { DeskSheet } from './Desk';
import { FileArchive } from './FileArchive';
import { listedFloors, stationFor, stationKeyOf, toolsReport, type ToolLine } from '../data/floor';
import { ClaimStep, JOB_LABEL } from './QuestLog';
import { SkillBadge } from './Skills';
import { skillMeta } from '../data/skills';

/** The listed agent as buyers see it on market.near.ai: handle (verified once the token works and it is claimed), its
    listing status and public stats. A Draft is visible only to its owner, so it reads "not public yet". */
function MarketCard({ market }: { market: MarketAgent }) {
  const [p, setP] = useState<MarketProfile | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.marketProfile(market.departmentId).then(setP).catch((e: ApiError) => setErr(e.message)); }, [market.departmentId]);
  const copy = (label: string, text: string) => void navigator.clipboard?.writeText(text).then(() => useStore.getState().toast(`${label} copied.`)).catch(() => undefined);
  const verified = !!market.verifiedAt && !!market.adoptedAt;
  const url = p?.url ?? `https://market.near.ai/a/${market.handle}`;
  const pct = (x: number) => `${Math.round(x * (x <= 1 ? 100 : 1))}%`;
  const dur = (sec: number) => (sec >= 3600 ? `${Math.round(sec / 360) / 10} h` : `${Math.max(1, Math.round(sec / 60))} min`);
  return (
    <section className="mk-card" aria-labelledby="mk-card-t">
      <h3 className="sec-t" id="mk-card-t">On market.near.ai</h3>
      <div className="mk-card-id">
        <a className="mono" href={url} target="_blank" rel="noreferrer">@{market.handle}</a>
        {verified ? <span className="chip sm mk-claimed" title="The agent token works and the agent is claimed into your market account"><Icon n="check" size={11} /> Verified</span>
          : <span className="chip sm" title={market.verifiedAt ? 'Claim it from the market quest card' : 'The token is checked on the next poll'}>{market.verifiedAt ? 'Not claimed yet' : 'Not verified yet'}</span>}
        {p?.listingStatus && <span className={`chip sm mk-ls ${p.listingStatus}`}>{p.listingStatus}</span>}
      </div>
      {!market.adoptedAt && <ol className="mk-steps"><ClaimStep deptId={market.departmentId} claimed={false} /></ol>}
      {(market.tagline || market.description) && (
        <div className="mk-paste">
          <span className="muted small">The Chief of Staff's listing text: paste it on market.near.ai (registration can't send it).</span>
          {market.tagline && <div><i>Tagline</i><span>{market.tagline}</span><button className="btn small" type="button" onClick={() => copy('Tagline', market.tagline!)}>Copy</button></div>}
          {market.description && <div><i>Description</i><span>{market.description}</span><button className="btn small" type="button" onClick={() => copy('Description', market.description!)}>Copy</button></div>}
          {market.priceUsdc && <div><i>Price</i><span>{market.priceUsdc} USDC a job</span></div>}
        </div>
      )}
      {err && <p className="err-t" role="alert">{err}</p>}
      {!p && !err && <p className="muted small" role="status">Reading the market…</p>}
      {p && !p.found && <p className="muted small">Not public yet: the listing is a <b>Draft</b>. Set a price and switch it to Live under <a href="https://market.near.ai/building/agents" target="_blank" rel="noreferrer">Building → Agents</a>.</p>}
      {p?.found && <>
        {(p.name || p.description) && <p className="mk-card-d"><b>{p.name}</b>{p.description && <> · {p.description}</>}</p>}
        <dl className="mk-card-stats">
          <div><dt>Delivered</dt><dd>{p.deliveredJobs ?? 0} jobs</dd></div>
          <div><dt>Success</dt><dd>{p.successRate !== null ? pct(p.successRate) : '–'}</dd></div>
          <div><dt>Response</dt><dd>{p.responseTimeSeconds !== null ? dur(p.responseTimeSeconds) : '–'}</dd></div>
          <div><dt>Delivery</dt><dd>{p.slaSeconds !== null ? dur(p.slaSeconds) : '–'}</dd></div>
          {p.category && <div><dt>Category</dt><dd className="mono">{p.category}</dd></div>}
        </dl>
      </>}
    </section>
  );
}

export function FloorSheetWindow() {
  const kind = useStore((s) => s.ui.floorSheet);
  const deptId = useStore((s) => s.ui.floorId);
  if (!kind || !deptId) return null;
  return kind === 'archive' ? <FileArchive deptId={deptId} /> : <FloorSheet kind={kind} deptId={deptId} />;
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
  const market = useStore((s) => s.market);
  if (!d) return null;
  const templateId = stationKeyOf(d, listedFloors(market));
  const st = stationFor(templateId);
  const agent = market?.agents.find((a) => a.departmentId === deptId) ?? null;
  const jobs = templateId === 'market' ? (market?.jobs.filter((j) => j.departmentId === deptId) ?? []) : null;
  // this floor's payouts: accepted jobs after the market's 5% fee
  const paidCents = jobs?.filter((j) => j.state === 'accepted').reduce((n, j) => n + Math.round((Number(j.amount) || 0) * 95), 0) ?? 0;
  const count = (k: string) => jobs?.filter((j) => j.state === k).length ?? 0;
  const sheetTitle = st?.name ?? 'Station';
  const report = inv ? toolsReport(templateId, inv) : null;
  const s = useStore.getState();
  const lib = (skill: string | null) => { close(); s.ui$({ skillLib: { deptId, skill } }); };
  const toLoadout = () => { close(); s.openPanel('dept', { deptTab: 'tools', agent: null }); };
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
            {jobs ? (
              <section aria-labelledby="fs-done"><h3 className="sec-t" id="fs-done">Jobs on market.near.ai</h3>
                <p className="mk-tally"><span><b>{count('working')}</b> in progress</span><span><b>{count('submitted')}</b> delivered, waiting for the buyer</span><span><b>{count('accepted')}</b> paid</span><span className="mk-earned"><b>${(paidCents / 100).toFixed(2)}</b> paid out <small>after the 5% fee</small></span></p>
                {jobs.length === 0 ? <p className="muted small">No job yet. Buyers find this floor on market.near.ai once it is Live.</p>
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
            {jobs && agent ? <MarketCard market={agent} /> : <div className="fs-act">
              <button className="btn primary small" onClick={() => { close(); s.openPanel('board', { composer: true, composerDept: deptId, boardDept: deptId, boardFilter: 'all' }); }}>Give it a job</button>
              <button className="btn secondary small" onClick={toLoadout}>Tools</button>
            </div>}
          </>
        )}
    </DeskSheet>
  );
}
