/* The money screen behind the safe (feature spec 6.1). Three pots, never added together: your NEAR wallets, the
   agents' credits, and the company treasury (a Sputnik DAO). Read from the backend; anything that moves funds is
   reviewed here first and then signed in your own wallet. Agents hold no keys and never sign. */
import { useEffect, useState } from 'react';
import type { MoneyView, NearNetwork } from '@vibe-city/shared';
import { useStore } from '../store';
import { api, ApiError } from '../../api';
import { Glyph, Icon, type StatusKey } from './kit';
import { formatNear, parseNear } from '../near/wallet';

type Wallet = typeof import('../near/wallet');
let walletMod: Promise<Wallet> | null = null;
const wallet = () => (walletMod ??= import('../near/wallet'));
const errText = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Something went wrong.');
const STATUS_K: Record<string, StatusKey> = { Approved: 'completed', InProgress: 'running', Rejected: 'failed', Removed: 'idle', Expired: 'idle', Failed: 'failed', Moved: 'idle' };

export function MoneyScreen() {
  const [v, setV] = useState<MoneyView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(true);
  const [signedIn, setSignedIn] = useState<string[]>([]);
  const load = async (fresh = false) => { try { setV(await api.money(fresh)); setError(null); } catch (e) { setError(errText(e)); } };
  useEffect(() => { void load(); const t = window.setTimeout(() => setOpening(false), 900); return () => window.clearTimeout(t); }, []);
  // Wallet session: a newly signed-in account is linked (public id only).
  const network = v?.settings.network;
  useEffect(() => {
    if (!network) return;
    let stop: (() => void) | null = null, live = true;
    void wallet().then((w) => w.watchAccounts(network, (ids) => {
      if (!live) return;
      setSignedIn(ids);
      for (const id of ids) if (!v?.wallets.some((x) => x.accountId === id)) void api.linkWallet(id).then(setV).catch(() => undefined);
    })).then((s) => { stop = s; }).catch((e) => setError(`Wallets could not load: ${errText(e)}`));
    return () => { live = false; stop?.(); };
  }, [network]); // eslint-disable-line react-hooks/exhaustive-deps

  if (opening) return <SafeDial />;
  if (!v) return error ? <p className="field-err" role="alert">{error}</p> : <p className="muted" aria-busy="true">Opening the safe…</p>;
  return (
    <div className="money">
      <div className="money-bar">
        <span className={`net ${v.settings.network}`}>{v.settings.network}</span>
        <span className="muted small">Read {new Date(v.readAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · three pots, never added together</span>
        <button className="btn small" onClick={() => void load(true)}><Icon n="refresh" size={12} />Refresh</button>
      </div>
      {error && <p className="field-err" role="alert">{error}</p>}
      <div className="money-cols">
        <Wallets v={v} signedIn={signedIn} onChange={setV} />
        <Credits v={v} />
        <Treasury v={v} signedIn={signedIn} reload={() => load(true)} />
      </div>
      <p className="fine">Vibe City stores public account ids only. It never holds keys: deposits and proposals are signed in your wallet, and treasury spending is approved by the DAO's signers.</p>
    </div>
  );
}

function SafeDial() {
  return (
    <div className="safe-dial" aria-label="Opening the safe" role="img">
      <div className="dial"><i /><b /></div>
      <span>Click… click… clunk.</span>
    </div>
  );
}

function Wallets({ v, signedIn, onChange }: { v: MoneyView; signedIn: string[]; onChange: (v: MoneyView) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const act = async (fn: () => Promise<MoneyView | void>) => { setBusy(true); setErr(null); try { const r = await fn(); if (r) onChange(r); } catch (e) { setErr(errText(e)); } finally { setBusy(false); } };
  return (
    <section className="pot">
      <h3 className="pot-h"><Icon n="shield" size={14} />Your wallets</h3>
      <p className="fine">Only you can move these funds, by signing in your wallet.</p>
      {v.wallets.length === 0 && <p className="muted">No wallet linked yet.</p>}
      <ul className="pot-list">
        {v.wallets.map((w) => (
          <li key={w.accountId} className="wallet">
            <div><b className="mono">{w.accountId}</b>{w.primary && <span className="tag-mini">primary</span>}{signedIn.includes(w.accountId) && <span className="tag-mini on">signed in</span>}</div>
            <div className="amt">{w.balance != null ? <>{formatNear(w.balance)} <small>NEAR</small></> : <span className="bad small">{w.error}</span>}</div>
            <div className="row">
              {!w.primary && <button className="btn small" disabled={busy} onClick={() => void act(() => api.primaryWallet(w.accountId))}>Make primary</button>}
              <button className="btn small" disabled={busy} onClick={() => void act(async () => { if (signedIn.includes(w.accountId)) await (await wallet()).disconnect(v.settings.network); return api.unlinkWallet(w.accountId); })}>Remove</button>
            </div>
          </li>
        ))}
      </ul>
      {err && <p className="field-err" role="alert">{err}</p>}
      <button className="btn primary small" disabled={busy} onClick={() => void act(async () => (await wallet()).connect(v.settings.network))}>Connect wallet</button>
      <p className="fine">Meteor, HOT, MyNearWallet or Ledger, on {v.settings.network}.</p>
    </section>
  );
}

function Credits({ v }: { v: MoneyView }) {
  const c = v.credits;
  return (
    <section className="pot">
      <h3 className="pot-h"><Icon n="gauge" size={14} />Agent credits</h3>
      <p className="fine">What the agents spend on models (NEAR AI Cloud). Day-to-day fuel, separate from your wallet and the treasury.</p>
      {!c.connected && (
        <div className="exec-note">
          <p>Not connected. To show the balance here, add your NEAR AI Cloud organization id and an access token to <span className="mono">.env</span> and restart:</p>
          <pre className="mono small">NEAR_AI_ORG_ID=…{'\n'}NEAR_AI_ACCESS_TOKEN=…</pre>
          <p className="muted small">The access token is a session token from cloud.near.ai (the API key cannot read billing). It stays on the server.</p>
        </div>
      )}
      {c.connected && c.error && <p className="field-err" role="alert">{c.error}</p>}
      {c.connected && !c.error && (
        <dl className="record">
          <div><dt>Remaining</dt><dd>{c.remaining ?? '—'}</dd></div>
          <div><dt>Spent</dt><dd>{c.spent ?? '—'}</dd></div>
          <div><dt>Requests</dt><dd>{c.requests?.toLocaleString() ?? '—'}</dd></div>
          <div><dt>Tokens</dt><dd>{c.tokens != null ? `${(c.tokens / 1000).toFixed(0)}k` : '—'}</dd></div>
        </dl>
      )}
      <p className="muted small">Burn rate per floor and daily caps need per-agent usage records; they arrive with the Finance floor (spec 6.3).</p>
    </section>
  );
}

function Treasury({ v, signedIn, reload }: { v: MoneyView; signedIn: string[]; reload: () => Promise<void> }) {
  const [editing, setEditing] = useState(!v.settings.daoAccountId);
  const [dao, setDao] = useState(v.settings.daoAccountId ?? '');
  const [trezu, setTrezu] = useState(v.settings.trezuUrl ?? 'https://trezu.app');
  const [net, setNet] = useState<NearNetwork>(v.settings.network);
  const [mode, setMode] = useState<'deposit' | 'spend' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const t = v.treasury;
  const saveSettings = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null);
    try { await api.setMoneySettings({ daoAccountId: dao.trim() || null, trezuUrl: trezu.trim() || null, network: net }); await reload(); setEditing(false); }
    catch (er) { setErr(errText(er)); }
  };
  if (editing) return (
    <section className="pot">
      <h3 className="pot-h"><Icon n="lock" size={14} />Company treasury</h3>
      <p className="fine">A Sputnik DAO multisig (for example one created in Trezu). Shown read-only; spending needs the DAO's signers.</p>
      <form className="sched-form" onSubmit={saveSettings}>
        <label className="field"><span className="lbl">DAO account</span><input className="input mono" value={dao} onChange={(e) => setDao(e.target.value)} placeholder="yourcompany.sputnik-dao.near" /></label>
        <label className="field"><span className="lbl">Treasury link in Trezu</span><input className="input" value={trezu} onChange={(e) => setTrezu(e.target.value)} placeholder="https://trezu.app/…" /></label>
        <div className="field"><span className="lbl">Network</span>
          <div className="seg-row" role="group" aria-label="NEAR network">{(['mainnet', 'testnet'] as const).map((n) => <button type="button" key={n} aria-pressed={net === n} className={net === n ? 'on' : ''} onClick={() => setNet(n)}>{n}</button>)}</div>
        </div>
        {err && <p className="field-err" role="alert">{err}</p>}
        <div className="row"><button className="btn primary small" type="submit">Save</button>{v.settings.daoAccountId && <button type="button" className="btn small" onClick={() => setEditing(false)}>Cancel</button>}</div>
      </form>
    </section>
  );
  if (!t) return null;
  const primary = v.wallets.find((w) => w.primary)?.accountId ?? null;
  return (
    <section className="pot">
      <h3 className="pot-h"><Icon n="lock" size={14} />Company treasury<button className="link small" onClick={() => setEditing(true)}>Change</button></h3>
      <p className="mono small">{t.daoAccountId}</p>
      <div className="amt big">{t.balance != null ? <>{formatNear(t.balance)} <small>NEAR</small></> : '—'}</div>
      {t.error && <p className="field-err" role="alert">{t.error}</p>}
      {t.roles.length > 0 && <p className="muted small">Signers: {t.roles.map((r) => `${r.name}${r.members != null ? ` (${r.members})` : ''}`).join(' · ')}</p>}
      <div className="row">
        <button className="btn small" disabled={!primary} title={primary ? '' : 'Link a wallet first'} onClick={() => setMode('deposit')}>Deposit</button>
        <button className="btn small" disabled={!primary || !t.proposalBond} title={primary ? '' : 'Link a wallet first'} onClick={() => setMode('spend')}>Request spend</button>
        {v.settings.trezuUrl && <a className="btn small" href={v.settings.trezuUrl} target="_blank" rel="noreferrer">Open in Trezu <Icon n="ext" size={11} /></a>}
      </div>
      {mode && primary && <Transfer mode={mode} v={v} from={primary} signedIn={signedIn.includes(primary)} onDone={() => { setMode(null); void reload(); }} />}
      <h4 className="pot-sub">Recent proposals</h4>
      {t.proposals.length === 0 && <p className="muted small">No proposals yet.</p>}
      <ul className="pot-list props">
        {t.proposals.map((p) => (
          <li key={p.id}>
            <Glyph k={STATUS_K[p.status] ?? 'awaiting'} />
            <div><b>#{p.id} {p.kind}</b><span className="muted small">{p.description || 'No description'} · by {p.proposer} · {p.status.replace(/([a-z])([A-Z])/g, '$1 $2')} · {p.approve} for, {p.reject} against</span></div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Review, then sign in the wallet. Nothing is sent until the user signs. */
function Transfer({ mode, v, from, signedIn, onDone }: { mode: 'deposit' | 'spend'; v: MoneyView; from: string; signedIn: boolean; onDone: () => void }) {
  const t = v.treasury!;
  const [amount, setAmount] = useState('');
  const [to, setTo] = useState('');
  const [why, setWhy] = useState('');
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const yocto = parseNear(amount);
  const bond = BigInt(t.proposalBond ?? '0');
  const valid = !!yocto && (mode === 'deposit' || (/^[a-z0-9._-]{2,64}$/.test(to.trim()) && why.trim().length > 3));
  const sign = async () => {
    setBusy(true); setErr(null);
    try {
      const w = await wallet();
      const out = mode === 'deposit'
        ? await w.sendNear(v.settings.network, from, t.daoAccountId, yocto!)
        : await w.proposeTransfer(v.settings.network, from, t.daoAccountId, to.trim(), yocto!, why.trim(), bond);
      useStore.getState().toast(out ? (mode === 'deposit' ? 'Deposit sent to the treasury.' : 'Proposal created. The signers can approve it in Trezu.') : 'Continue in your wallet.', 'good');
      onDone();
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  return (
    <div className="xfer">
      {!review ? (
        <form onSubmit={(e) => { e.preventDefault(); if (valid) setReview(true); }}>
          <label className="field"><span className="lbl">{mode === 'deposit' ? 'Deposit amount (NEAR)' : 'Amount to pay (NEAR)'}</span><input className="input mono" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1.5" /></label>
          {mode === 'spend' && <>
            <label className="field"><span className="lbl">Pay to (NEAR account)</span><input className="input mono" value={to} onChange={(e) => setTo(e.target.value)} placeholder="designer.near" /></label>
            <label className="field"><span className="lbl">What for</span><input className="input" value={why} maxLength={300} onChange={(e) => setWhy(e.target.value)} placeholder="Logo design, invoice #12" /></label>
          </>}
          <div className="row"><button className="btn primary small" type="submit" disabled={!valid}>Review</button><button type="button" className="btn small" onClick={onDone}>Cancel</button></div>
        </form>
      ) : (
        <div>
          <p className="xfer-sum">{mode === 'deposit'
            ? <>Send <b>{formatNear(yocto!)} NEAR</b> from <span className="mono">{from}</span> to the treasury <span className="mono">{t.daoAccountId}</span>.</>
            : <>Create a DAO proposal: pay <b>{formatNear(yocto!)} NEAR</b> to <span className="mono">{to.trim()}</span> for “{why.trim()}”. You attach the DAO's bond of <b>{formatNear(bond)} NEAR</b>; the DAO's signers decide, nothing is paid until they approve.</>}</p>
          {!signedIn && <p className="field-err">Your wallet session for {from} is not active: press Connect wallet and sign in with it first.</p>}
          {err && <p className="field-err" role="alert">{err}</p>}
          <div className="row"><button className="btn primary small" disabled={busy || !signedIn} onClick={() => void sign()}>{busy ? 'Waiting for your wallet…' : 'Sign in wallet'}</button><button className="btn small" disabled={busy} onClick={() => setReview(false)}>Back</button></div>
        </div>
      )}
    </div>
  );
}
