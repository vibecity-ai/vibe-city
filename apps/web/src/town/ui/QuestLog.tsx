/* The CEO quest log (docs/briefs/05-game-loop.md).
   - CurrentQuestCard: the one quest to do next, in the Executive Office panel, with its button.
   - QuestLogWindow: the whole journey in three acts and the floors each quest unlocks. Opened from the top bar, the
     current-quest card and the Executive Office's trophy shelf. */
import { useEffect, useRef, useState } from 'react';
import type { CeoQuest, GameState, TemplateList } from '@vibe-city/shared';
import { useStore } from '../store';
import { api, ApiError } from '../../api';
import { Icon, useDialog } from './kit';
import { acts, nextQuest, progressLabel, questTarget } from '../data/game';

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

/** The button (or note) that takes the CEO where the quest is done; the mapping lives in data/game.ts. */
function QuestAction({ q, onGo }: { q: CeoQuest; onGo?: () => void }) {
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
    case 'note': return <span className="ql-note">{t.text}</span>;
    default: return null;
  }
}

function Pips({ g }: { g: GameState }) {
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
  const ref = useRef<HTMLDivElement>(null);
  const [floors, setFloors] = useState<TemplateList | null>(null);
  const close = () => useStore.getState().ui$({ questLog: false });
  useDialog(ref, true, close);
  useEffect(() => {
    api.templates().then(setFloors).catch(() => undefined);
    api.game().then((g) => useStore.setState({ game: g })).catch(() => undefined);
  }, []);
  if (!game) return null;
  const next = nextQuest(game);
  const titleOf = (id: string | null) => (id ? game.quests.find((q) => q.id === id)?.title ?? id : null);
  return (
    <div className="hire-scrim" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="hire exec-modal ql" ref={ref} role="dialog" aria-modal="true" aria-labelledby="ql-t">
        <header className="hire-head">
          <div><span className="dlg-tag">Executive office</span><h2 id="ql-t">Quest log</h2></div>
          <button className="dlg-icon" onClick={close} aria-label="Close"><Icon n="x" size={14} /></button>
        </header>
        <div className="ql-progress"><Pips g={game} /><span>{progressLabel(game)}</span></div>

        <div className="ql-cols">
          <div className="ql-main">
            {next && (
              <section className="ql-hero" aria-labelledby="ql-now">
                <span className="ql-tag">Now</span>
                <h3 id="ql-now">{next.title}</h3>
                <p>{next.hint}</p>
                <div className="ql-card-act"><QuestAction q={next} onGo={close} />{next.unlocks && <span className="ql-unl"><Icon n="lock" size={11} />Unlocks {next.unlocks}</span>}</div>
              </section>
            )}
            {acts(game).map((a, ai) => {
              const done = a.quests.filter((q) => q.done).length;
              return (
                <section key={a.title} className="ql-act" aria-label={a.title}>
                  <h3 className="ql-act-t"><span className="ql-act-n">Act {ai + 1}</span>{a.title}<span className="ql-act-c">{done}/{a.quests.length}</span></h3>
                  <p className="ql-act-b">{a.blurb}</p>
                  <ol className="ql-list">
                    {a.quests.map((q) => (
                      <li key={q.id} className={`ql-row ${q.done ? 'done' : q === next ? 'now' : 'later'}`}>
                        <span className="ql-mark" aria-hidden="true">{q.done ? <Icon n="sparkle" size={11} /> : q === next ? <i /> : null}</span>
                        <span className="ql-row-t">{q.title}<span className="sr">{q.done ? ', done' : q === next ? ', next' : ''}</span></span>
                        {q.unlocks && <span className={`ql-chip${q.done ? ' on' : ''}`}>{q.done ? 'Unlocked' : 'Unlocks'} {q.unlocks}</span>}
                      </li>
                    ))}
                  </ol>
                </section>
              );
            })}
          </div>

          <aside className="ql-side" aria-labelledby="ql-floors">
            <h3 className="ql-act-t" id="ql-floors">Floors you can hire</h3>
            <p className="ql-act-b">Each quest opens a floor. Hire one from the Chief of Staff or Add department.</p>
            {!floors && <p className="muted small">Loading…</p>}
            <ul className="ql-floors">
              {floors?.map((t) => (
                <li key={t.id} className={t.locked ? 'locked' : 'open'}>
                  <span className="ql-floor-n">{t.locked ? <Icon n="lock" size={12} /> : <Icon n="building" size={12} />}{t.name}</span>
                  <span className="ql-floor-s">{t.seats.length} agents · {t.seats.map((x) => x.title).slice(0, 2).join(', ')}{t.seats.length > 2 ? '…' : ''}</span>
                  <span className="ql-floor-u">{t.locked ? `After: ${titleOf(t.unlocks)}` : 'Ready to hire'}</span>
                </li>
              ))}
            </ul>
            {floors?.some((t) => !t.locked) && <button className="btn secondary small block" onClick={() => { close(); useStore.getState().ui$({ modal: 'create' }); }}>Hire a department</button>}
          </aside>
        </div>
      </div>
    </div>
  );
}
