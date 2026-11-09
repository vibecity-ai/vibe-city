/* The CEO quest log (docs/briefs/05-game-loop.md).
   - CurrentQuestCard: the one quest to do next, in the Executive Office panel, with its button.
   - QuestLogWindow: the whole journey in three acts and the floors each quest unlocks. Opened from the top bar, the
     current-quest card and the Executive Office's trophy shelf. */
import { useEffect, useState } from 'react';
import { MARKET_CATEGORIES, type CeoQuest, type GameState, type ListingDraft, type MarketRegister, type MarketView, type TemplateList } from '@vibe-city/shared';
import { useStore } from '../store';
import { api, ApiError } from '../../api';
import { Icon, PixelSelect } from './kit';
import { DeskSheet } from './Desk';
import { acts, nextQuest, progressLabel, questTarget } from '../data/game';
import { ChiefOfStaffSetup } from './ChiefOfStaff';

const NEW_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';

/** Paste a fine-grained token for the Software Department. Write-only: the backend stores it and never sends it back. */
function GithubTokenForm() {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const s = useStore.getState();
  const save = () => {
    setBusy(true);
    api.setCompanySettings({ githubToken: token.trim() })
      .then(() => api.game()).then((game) => { useStore.setState({ game }); setToken(''); s.toast('GitHub connected. The Software Department can be hired.'); })
      .catch((e) => s.toast(e instanceof ApiError ? e.message : 'That did not work.', 'bad')).finally(() => setBusy(false));
  };
  return (
    <form className="ql-gh" onSubmit={(e) => { e.preventDefault(); if (token.trim()) save(); }}>
      <p className="ql-note">
        <a href={NEW_TOKEN_URL} target="_blank" rel="noreferrer">Create a fine-grained token on GitHub</a>, limited to the
        repositories the agents may touch, with an expiry.
      </p>
      <details className="ql-note">
        <summary>Permissions to grant</summary>
        <ul>
          <li>Repository access: <b>Only select repositories</b></li>
          <li>Contents, Pull requests, Issues: <b>Read and write</b></li>
          <li>Workflows: <b>Read and write</b> (DevOps edits CI)</li>
          <li>Actions, Commit statuses: <b>Read-only</b> (CI logs and checks)</li>
          <li>Metadata: <b>Read-only</b> (GitHub adds it)</li>
        </ul>
        Agents use it as <code>GH_TOKEN</code> for <code>git</code> and <code>gh</code>. Stored on the Vibe City server,
        never shown again; paste a new one to replace it.
      </details>
      <div className="ql-gh-row">
        <input className="input mono" type="password" autoComplete="off" spellCheck={false} placeholder="github_pat_…"
          aria-label="GitHub fine-grained token" value={token} onChange={(e) => setToken(e.target.value)} />
        <button className="btn primary small" type="submit" disabled={busy || !token.trim()}>Connect</button>
      </div>
    </form>
  );
}

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
const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work.');

/** List the company on the NEAR AI Agent Market: register (or paste a token), claim it, set a price and go live there.
    The backend then polls the agent's jobs and hands each one to a department. */
function MarketQuest() {
  const [m, setM] = useState<MarketView | null>(null);
  const [draft, setDraft] = useState<ListingDraft | null>(null);
  const [form, setForm] = useState<MarketRegister>({ handle: '', name: '', category: 'other' });
  const [paste, setPaste] = useState({ handle: '', token: '' });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const s = useStore.getState();
  // the backend polls the market every 45 s; the card follows it (and the quest log, once a job is paid)
  useEffect(() => {
    const load = () => api.market().then((v) => { setM(v); void api.game().then((game) => useStore.setState({ game })).catch(() => undefined); }).catch(() => undefined);
    void load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);
  const run = <T,>(p: Promise<T>, ok: (v: T) => void) => {
    setBusy(true); setNote(null);
    p.then(ok).catch((e) => setNote(errMsg(e))).finally(() => setBusy(false));
  };
  const done = (v: MarketView) => { setM(v); void api.game().then((game) => useStore.setState({ game })).catch(() => undefined); };
  if (!m) return <span className="ql-note">Loading…</span>;

  const copy = draft && (
    <details className="ql-note" open>
      <summary>The Chief of Staff's listing copy</summary>
      <ul>
        <li>Tagline: <b>{draft.tagline}</b></li>
        <li>Description: <b>{draft.description}</b></li>
        <li>Price: <b>{draft.priceUsdc} USDC</b> per job · delivery in <b>{draft.slaHours} h</b></li>
        {draft.deliverables.length > 0 && <li>Delivers: {draft.deliverables.join('; ')}</li>}
      </ul>
    </details>
  );

  if (!m.connected) {
    return (
      <div className="ql-gh">
        <p className="ql-note">The company becomes one agent on the <a href={MARKET} target="_blank" rel="noreferrer">Agent Market</a>. Buyers hire it; each job goes to the floor that fits.</p>
        <div className="ql-gh-row">
          <button className="btn secondary small" type="button" disabled={busy} onClick={() => run(api.marketDraft(), (d) => { setDraft(d); setForm({ handle: d.handle, name: d.name, category: d.category, slaHours: d.slaHours }); })}>
            Draft with the Chief of Staff
          </button>
        </div>
        {copy}
        <form className="ql-gh" onSubmit={(e) => { e.preventDefault(); run(api.marketRegister(form), (v) => { done(v); s.toast(`Registered as @${v.handle}.`); }); }}>
          <div className="ql-gh-row">
            <input className="input" placeholder="Name" aria-label="Agent name" maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <input className="input mono" placeholder="handle" aria-label="Handle" maxLength={30} spellCheck={false} value={form.handle} onChange={(e) => setForm({ ...form, handle: e.target.value.toLowerCase() })} />
          </div>
          <div className="ql-gh-row">
            <PixelSelect aria-label="Category" value={form.category} onChange={(v) => setForm({ ...form, category: v as MarketRegister['category'] })}
              options={MARKET_CATEGORIES.map((c) => ({ value: c, label: c.replace(/_/g, ' ') }))} />
            <button className="btn primary small" type="submit" disabled={busy || !form.name.trim() || !form.handle.trim()}>Register</button>
          </div>
        </form>
        <details className="ql-note">
          <summary>Made the agent on market.near.ai already?</summary>
          <form className="ql-gh" onSubmit={(e) => { e.preventDefault(); run(api.marketToken(paste.handle.trim(), paste.token.trim()), (v) => { done(v); setPaste({ handle: '', token: '' }); }); }}>
            <p>Edit the agent, then Agent API tokens, Create token. Leave the webhook empty: Vibe City polls.</p>
            <div className="ql-gh-row">
              <input className="input mono" placeholder="handle" aria-label="Market handle" value={paste.handle} onChange={(e) => setPaste({ ...paste, handle: e.target.value })} />
              <input className="input mono" type="password" autoComplete="off" placeholder="aat_…" aria-label="Agent token" value={paste.token} onChange={(e) => setPaste({ ...paste, token: e.target.value })} />
              <button className="btn primary small" type="submit" disabled={busy || !paste.handle.trim() || !paste.token.trim()}>Connect</button>
            </div>
          </form>
        </details>
        {note && <p className="ql-note" role="status">{note}</p>}
      </div>
    );
  }

  const checked = m.lastPollAt ? new Date(m.lastPollAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
  return (
    <div className="mk">
      <div className="mk-id">
        <span className="chip sm mk-handle">@{m.handle}</span>
        <span className="ql-note">{m.verifiedAt ? 'Token verified' : 'Token not verified yet'} · jobs go to the Marketplace Agency</span>
      </div>
      <ol className="mk-steps">
        <li>
          <span className="mk-n">1</span>
          <span className="mk-t">Set a USDC price and switch the listing to <b>Live</b> so buyers can find it.</span>
          <a className="btn secondary small" href={MARKET} target="_blank" rel="noreferrer">Open market</a>
        </li>
        <li className={m.agencyReady ? 'done' : ''}>
          <span className="mk-n">{m.agencyReady ? <Icon n="sparkle" size={11} /> : 2}</span>
          <span className="mk-t">{m.agencyReady ? 'The Marketplace Agency is open for work.' : 'Hire the Marketplace Agency, the floor that does the jobs.'}</span>
          {!m.agencyReady && <button className="btn secondary small" type="button" onClick={() => s.ui$({ modal: 'create' })}>Hire</button>}
        </li>
      </ol>
      {copy}
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
        <span className="ql-note" role="status">{note ?? m.lastError ?? (checked ? `Checked the market at ${checked}; it is checked every 45 s.` : 'The market is checked every 45 s.')}</span>
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
    case 'hire': return <button className="btn primary small" onClick={go(() => s.ui$({ modal: 'create' }))}>Hire a department</button>;
    case 'connector': return <ConnectorQuest name={t.name} />;
    case 'quest-board': return <button className="btn secondary small" onClick={go(() => s.openPanel('board', { composer: false, boardDept: null }))}>Open the Ops board</button>;
    case 'ipo': return <button className="btn primary small" disabled title="The IPO button arrives with the IPO work">Go public</button>;
    case 'github': return <GithubTokenForm />;
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
      {g.quests.map((q) => <i key={q.id} className={q.done ? 'done' : q === next ? 'now' : ''} />)}
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
        {!next && <p className="ql-intro">Every quest is done. The company is public.</p>}
    </DeskSheet>
  );
}
