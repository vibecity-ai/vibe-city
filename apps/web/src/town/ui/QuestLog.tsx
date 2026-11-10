/* The CEO quest log (docs/briefs/05-game-loop.md).
   - CurrentQuestCard: the one quest to do next, in the Executive Office panel, with its button.
   - QuestLogWindow: the whole journey in three acts and the floors each quest unlocks. Opened from the top bar, the
     current-quest card and the Executive Office's trophy shelf. */
import { useEffect, useState } from 'react';
import { isInternalOnly, type CeoQuest, type GameState, type MarketView, type TemplateList } from '@vibe-city/shared';
import { useStore } from '../store';
import { api, ApiError } from '../../api';
import { Icon } from './kit';
import { DeskSheet } from './Desk';
import { acts, nextQuest, progressLabel, questTarget, sideQuests } from '../data/game';
import { ChiefOfStaffSetup } from './ChiefOfStaff';

/** The caps OutLayer's connector needs before it opens orders (a stored policy is fail-closed without them). */
const CONNECTOR_CAPS = { hyperliquid: 'max order, max daily volume and max leverage', polymarket: 'max order and max daily volume' } as const;

/** Store the connector policy on OutLayer for the company wallet, then check: one status call, from the wallet's trial. */
function ConnectorQuest({ name }: { name: 'hyperliquid' | 'polymarket' }) {
  const [account, setAccount] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const s = useStore.getState();
  useEffect(() => { api.wallet().then((w) => setAccount(w.accountId)).catch(() => undefined); }, []);
  const check = () => {
    setBusy(true); setNote(null);
    api.checkConnector(name)
      .then((r) => { setNote(r.message); return r.connected ? api.game().then((game) => { useStore.setState({ game }); s.toast(r.message); }) : undefined; })
      .catch((e) => setNote(e instanceof ApiError ? e.message : 'That did not work.')).finally(() => setBusy(false));
  };
  if (!account) return <span className="ql-note">Connect the company wallet in the safe first.</span>;
  return (
    <div className="ql-gh">
      <p className="ql-note">
        On <a href={`https://app.outlayer.ai/connect/${name}`} target="_blank" rel="noreferrer">OutLayer's {name} page</a>, set
        the {CONNECTOR_CAPS[name]}, and enter the company wallet's account:
      </p>
      <code className="ql-acct">{account}</code>
      <div className="ql-gh-row">
        <button className="btn secondary small" type="button" onClick={() => void navigator.clipboard?.writeText(account)}>Copy account</button>
        <button className="btn primary small" type="button" disabled={busy} onClick={check}>{busy ? 'Checking…' : 'Check'}</button>
      </div>
      {note && <p className="ql-note" role="status">{note}</p>}
    </div>
  );
}

const MARKET = 'https://market.near.ai';
/** The boss's own agents on the market, where a claimed listing shows as Draft until they set a price and go Live. */
const MARKET_AGENTS = 'https://market.near.ai/building/agents';

/** Self-registration puts the agent under a fresh market account, so the boss sees nothing on market.near.ai until
    they claim it: a one-time link (opened in a tab made on the click, so no popup blocker) moves it into their account. */
export function ClaimStep({ deptId, claimed }: { deptId: string; claimed: boolean }) {
  const [st, setSt] = useState<{ k: 'idle' | 'busy' | 'done' } | { k: 'code'; code: string; url: string | null } | { k: 'err'; msg: string }>(claimed ? { k: 'done' } : { k: 'idle' });
  useEffect(() => { if (claimed) setSt({ k: 'done' }); }, [claimed]);
  const claim = async () => {
    const tab = window.open('', '_blank');
    setSt({ k: 'busy' });
    try {
      const a = await api.marketAdoption(deptId);
      if (a.adopted) { tab?.close(); setSt({ k: 'done' }); void api.market().then((market) => useStore.setState({ market })).catch(() => undefined); return; }
      if (a.url && tab) tab.location.href = a.url; else tab?.close();
      setSt({ k: 'code', code: a.code ?? '', url: a.url });
    } catch (e) { tab?.close(); setSt({ k: 'err', msg: e instanceof ApiError ? e.message : 'Could not reach the market.' }); }
  };
  return (
    <li className={st.k === 'done' ? 'done' : ''}>
      <span className="mk-n">{st.k === 'done' ? <Icon n="sparkle" size={11} /> : 1}</span>
      <span className="mk-t">
        {st.k === 'done' ? 'The agent is in your market.near.ai account.'
          : <>Claim the agent into <b>your</b> market.near.ai account (log in there first): it was registered on its own, so you can't see it yet.</>}
        {st.k === 'code' && <><br />Claim code <b className="mono">{st.code}</b>{st.url && <> · <a href={st.url} target="_blank" rel="noreferrer">open the claim page</a></>}. Claimed? Press the button to check.</>}
        {st.k === 'err' && <><br /><span className="err-t" role="alert">{st.msg}</span></>}
      </span>
      {st.k === 'done' ? <span className="chip sm mk-claimed"><Icon n="check" size={11} /> Claimed</span> : <button className="btn secondary small" type="button" disabled={st.k === 'busy'} onClick={() => void claim()}>{st.k === 'busy' ? 'Checking…' : st.k === 'code' ? 'I claimed it' : 'Claim it'}</button>}
    </li>
  );
}

/** The company's floors on the NEAR AI Agent Market, each its own agent. The Chief of Staff lists one at a time from
    the dialogue window; the quest is done once a listed floor's agents hold its token. The backend then polls the agent's jobs and hands each one to the floor. */
function MarketQuest() {
  const [m, setM] = useState<MarketView | null>(null);
  const s = useStore.getState();
  const depts = useStore((st) => st.depts);
  // the backend polls the market every 45 s; the card follows it (and the quest log, once a job is paid)
  useEffect(() => {
    const load = () => api.market().then((v) => { setM(v); useStore.setState({ market: v }); void api.game().then((game) => useStore.setState({ game })).catch(() => undefined); }).catch(() => undefined);
    void load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);
  if (!m) return <span className="ql-note">Loading…</span>;
  const talk = () => s.ui$({ questLog: false, marketDraft: true });

  if (!m.connected) {
    return (
      <div className="ql-gh">
        <p className="ql-note">A floor becomes an agent on the <a href={MARKET} target="_blank" rel="noreferrer">Agent Market</a>. Buyers hire it; each job lands on that floor's board. Your Chief of Staff picks the floor with you, writes the listing and registers it.</p>
        <div className="ql-gh-row">
          <button className="btn primary small" type="button" onClick={talk}>Draft with the Chief of Staff</button>
        </div>
      </div>
    );
  }

  const checked = m.lastPollAt ? new Date(m.lastPollAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
  const name = (id: string) => depts.find((d) => d.id === id)?.view.name ?? 'the listed floor';
  const unlisted = depts.some((d) => !isInternalOnly(d.view.templateId) && !m.agents.some((a) => a.departmentId === d.id));
  return (
    <div className="mk">
      {m.agents.map((a) => (
        <div key={a.departmentId} className="mk-agent">
          <div className="mk-id">
            <span className="chip sm mk-handle">@{a.handle}</span>
            <span className="ql-note">{a.verifiedAt ? 'Token verified' : 'Token not verified yet'} · jobs go to {name(a.departmentId)}</span>
          </div>
          <ol className="mk-steps">
            <ClaimStep deptId={a.departmentId} claimed={!!a.adoptedAt} />
            <li>
              <span className="mk-n">2</span>
              <span className="mk-t">Under <b>Building → Agents</b> it is a <b>Draft</b>: set a USDC price and switch it to <b>Live</b> so buyers can find it.</span>
              <a className="btn secondary small" href={MARKET_AGENTS} target="_blank" rel="noreferrer">Open market</a>
            </li>
            <li className={a.ready ? 'done' : ''}>
              <span className="mk-n">{a.ready ? <Icon n="sparkle" size={11} /> : 3}</span>
              <span className="mk-t">{a.ready ? `${name(a.departmentId)} is open for work.` : `${name(a.departmentId)} is not synced with Hermes yet.`}</span>
            </li>
          </ol>
        </div>
      ))}
      {unlisted && <button className="btn secondary small" type="button" onClick={talk}>List another floor with the Chief of Staff</button>}
      {m.jobs.length > 0 && (
        <ul className="mk-jobs" aria-label="Market jobs">
          {m.jobs.slice(0, 5).map((j) => (
            <li key={j.assignmentId} title={j.note ?? undefined}>
              <span className="mk-job-t">{j.title}</span>
              <span className="mk-amt">{Number(j.amount)} {j.token}</span>
              <span className={`chip sm mk-st ${j.state}`}>{JOB_LABEL[j.state]}{j.rounds > 1 ? ` · rev ${j.rounds - 1}` : ''}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mk-foot">
        <span className="ql-note" role="status">{m.lastError ?? (checked ? `Checked the market at ${checked}; it is checked every 45 s.` : 'The market is checked every 45 s.')}</span>
      </div>
    </div>
  );
}

export const JOB_LABEL: Record<MarketView['jobs'][number]['state'], string> = { working: 'In progress', submitted: 'Delivered', accepted: 'Paid', failed: 'Failed', closed: 'Closed' };

/** The button (or note) that takes the CEO where the quest is done; the mapping lives in data/game.ts. */
/** compact: on a small screen (the CEO console) a form quest is a button to the Quest log, where its form is. */
export function QuestAction({ q, onGo, compact }: { q: CeoQuest; onGo?: () => void; compact?: boolean }) {
  const s = useStore.getState();
  const go = (fn: () => void) => () => { onGo?.(); fn(); };
  const t = questTarget(q.id);
  switch (t?.kind) {
    case 'safe': return <button className="btn primary small" onClick={go(() => { s.openExec(); s.ui$({ execModal: 'safe' }); })}>Open the safe</button>;
    case 'hire': return <button className="btn primary small" onClick={go(() => s.ui$({ modal: 'create' }))}>Hire a floor</button>;
    case 'connector': return <ConnectorQuest name={t.name} />;
    case 'quest-board': return <button className="btn primary small" onClick={go(() => s.openPanel('board', { composer: true, boardDept: null }))}>Give Treasury Ops the launch</button>;
    case 'cos': return compact
      ? <button className="btn primary small" onClick={go(() => s.ui$({ questLog: true }))}>Set it up</button>
      : <ChiefOfStaffSetup />;
    case 'market': return <MarketQuest />;
    case 'note': return <span className="ql-note">{t.text}</span>;
    default: return null;
  }
}

export function Pips({ g }: { g: GameState }) {
  const next = nextQuest(g);
  return (
    <span className="ql-pips" aria-hidden="true">
      {g.quests.filter((q) => !q.side).map((q) => <i key={q.id} className={q.done ? 'done' : q === next ? 'now' : ''} />)}
    </span>
  );
}

/* ---------------- the Executive Office panel ---------------- */

export function CurrentQuestCard() {
  const game = useStore((s) => s.game);
  if (!game) return null;
  const next = nextQuest(game);
  const open = () => useStore.getState().ui$({ questLog: true });
  return (
    <section className="pane-sec">
      <h3 className="sec-t">Your quest <button className="link sec-link" onClick={open}>Quest log</button></h3>
      <div className="ql-card">
        <div className="ql-card-top"><span className="ql-step">{next ? 'Next quest' : 'Quests'} · {progressLabel(game)}</span><Pips g={game} /></div>
        {next ? (
          <>
            <b className="ql-card-t">{next.title}</b>
            <p className="ql-card-h">{next.hint}</p>
            <div className="ql-card-act">
              <QuestAction q={next} />
              {next.unlocks && <span className="ql-unl"><Icon n="lock" size={11} />Unlocks {next.unlocks}</span>}
            </div>
          </>
        ) : <b className="ql-card-t">Every quest is done. The company is public.</b>}
      </div>
    </section>
  );
}

/* ---------------- the window ---------------- */

export function QuestLogWindow() {
  const open = useStore((s) => s.ui.questLog);
  return open ? <QuestLog /> : null;
}

function QuestLog() {
  const game = useStore((s) => s.game);
  const [floors, setFloors] = useState<TemplateList | null>(null);
  const close = () => useStore.getState().ui$({ questLog: false });
  useEffect(() => {
    api.templates().then(setFloors).catch(() => undefined);
    api.game().then((g) => useStore.setState({ game: g })).catch(() => undefined);
  }, []);
  if (!game) return null;
  const next = nextQuest(game);
  const nextAct = acts(game).findIndex((a) => a.quests.some((q) => q === next));
  /** What a quest unlocks, with the floor's crew size when it is a floor. */
  const unlock = (label: string, on: boolean) => label.split(', ').map((part) => {
    const f = floors?.find((t) => t.name.toLowerCase() === part.toLowerCase() || t.name.toLowerCase() === `${part.toLowerCase()} department`);
    return (
      <span key={part} className={`ql-chip${on ? ' on' : ''}${f ? ' floor' : ''}`}>
        <Icon n={f ? 'building' : on ? 'sparkle' : 'lock'} size={11} />{part}{f && <small>{f.seats.length} agents</small>}
      </span>
    );
  });
  return (
    <DeskSheet title="Quest log" onClose={close} className="exec-modal ql">
        <header className="ql-head">
          <div><span className="dlg-tag">Your quests</span><h2>Build the company</h2></div>
          <div className="ql-progress"><Pips g={game} /><span>{progressLabel(game)}</span></div>
        </header>
        <p className="ql-intro">Quests are yours: each one you finish opens new floors. Your agents' work is on the Ops board, as jobs.</p>
        {acts(game).map((a, ai) => {
          const done = a.quests.filter((q) => q.done).length;
          const state = done === a.quests.length ? 'past' : nextAct === -1 || ai <= nextAct ? 'current' : 'future';
          return (
            <section key={a.title} className={`ql-act ${state}`} aria-label={a.title}>
              <h3 className="ql-act-t"><span className="ql-act-n">Act {ai + 1}</span>{a.title}<span className="ql-act-c">{done}/{a.quests.length}</span></h3>
              {state !== 'past' && <p className="ql-act-b">{a.blurb}</p>}
              <ol className="ql-list">
                {a.quests.map((q) => q === next ? (
                  <li key={q.id} className="ql-row now">
                    <div className="ql-now-top"><span className="ql-mark" aria-hidden="true"><i /></span><span className="ql-row-t">{q.title}<span className="sr">, next</span></span><span className="ql-tag">Now</span></div>
                    <p className="ql-now-h">{q.hint}</p>
                    <div className="ql-now-act"><QuestAction q={q} onGo={close} />{q.unlocks && <span className="ql-unlocks">Unlocks {unlock(q.unlocks, false)}</span>}</div>
                  </li>
                ) : (
                  <li key={q.id} className={`ql-row ${q.done ? 'done' : 'later'}`}>
                    <span className="ql-mark" aria-hidden="true">{q.done && <Icon n="check" size={11} sw={3} />}</span>
                    <span className="ql-row-t">{q.title}<span className="sr">{q.done ? ', done' : ''}</span></span>
                    {q.unlocks && <span className="ql-unlocks">{unlock(q.unlocks, q.done)}</span>}
                  </li>
                ))}
              </ol>
            </section>
          );
        })}
        {sideQuests(game).length > 0 && (
          <section className="ql-act current" aria-label="Side quests">
            <h3 className="ql-act-t"><span className="ql-act-n">Side</span>Side quests<span className="ql-act-c">{sideQuests(game).filter((q) => q.done).length}/{sideQuests(game).length}</span></h3>
            <p className="ql-act-b">Optional. Each opens another floor; the main line never waits on them.</p>
            <ol className="ql-list">
              {sideQuests(game).map((q) => q.done ? (
                <li key={q.id} className="ql-row done">
                  <span className="ql-mark" aria-hidden="true"><Icon n="check" size={11} sw={3} /></span>
                  <span className="ql-row-t">{q.title}<span className="sr">, done</span></span>
                  {q.unlocks && <span className="ql-unlocks">{unlock(q.unlocks, true)}</span>}
                </li>
              ) : (
                <li key={q.id} className="ql-row now">
                  <div className="ql-now-top"><span className="ql-mark" aria-hidden="true"><i /></span><span className="ql-row-t">{q.title}</span></div>
                  <p className="ql-now-h">{q.hint}</p>
                  <div className="ql-now-act"><QuestAction q={q} onGo={close} />{q.unlocks && <span className="ql-unlocks">Unlocks {unlock(q.unlocks, false)}</span>}</div>
                </li>
              ))}
            </ol>
          </section>
        )}
        {!next && <p className="ql-intro">Every main quest is done. The company is public.</p>}
    </DeskSheet>
  );
}
