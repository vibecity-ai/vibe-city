/* The IPO card (docs/briefs/06-ipo.md), under the wallet in the safe: the company wallet creates the Sputnik DAO and a
   city token from the Vibe City token factory, then the CEO shares revenue by DAO proposals approved in Trezu. */
import { useEffect, useState } from 'react';
import { IPO_SYMBOL_RE, PAYOUT_TOKENS, type IpoState } from '@vibe-city/shared';
import { useStore } from '../store';
import { api, ApiError } from '../../api';
import { ipoSymbol } from '../data/game';
import { PixelSelect } from './kit';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Something went wrong.');
const NB = 'https://nearblocks.io';
const ext = (href: string, text: string) => <a href={href} target="_blank" rel="noreferrer">{text}</a>;
const trezu = (dao: string) => `https://trezu.app/${dao}`;

export function IpoCard({ ceo }: { ceo: string | null }) {
  const company = useStore((s) => s.company?.name ?? '');
  const [ipo, setIpo] = useState<IpoState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => { try { setIpo(await api.ipo()); } catch (e) { setErr(errText(e)); } };
  const run = async (f: () => Promise<IpoState>) => {
    setBusy(true); setErr(null);
    try { setIpo(await f()); return true; } catch (e) { setErr(errText(e)); void load(); return false; } finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (ipo?.state !== 'running') return;
    const t = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(t);
  }, [ipo?.state]);

  if (!ipo) return err ? <p className="field-err" role="alert">{err}</p> : null;
  return (
    <section className="ipo">
      <h3>IPO</h3>
      {ipo.state === 'locked' && <>
        <button className="btn primary small" disabled title="Unlocks after your first paid market job and 4 NEAR in the company wallet">IPO</button>
        <p className="fine">Unlocks after your first paid market job and 4 NEAR in the company wallet.</p>
      </>}
      {(ipo.state === 'ready' || ipo.state === 'error') && <LaunchForm ipo={ipo} ceo={ceo} company={company} busy={busy} onLaunch={(x) => void run(() => api.ipoLaunch(x))} />}
      {ipo.state === 'awaiting_approval' && <>
        <p className="fine">Your OutLayer wallet's policy needs your approval for <span className="mono">{ipo.awaiting}</span>. Approve it at {ext('https://app.outlayer.ai', 'app.outlayer.ai')}, then continue. Each IPO step asks once (up to four).</p>
        <button className="btn primary small" disabled={busy} onClick={() => void run(() => api.ipoLaunch({ ceoAccountId: ipo.ceoAccountId ?? '', symbol: ipo.symbol ?? '' }))}>{busy ? 'Checking…' : 'Continue IPO'}</button>
      </>}
      {ipo.state === 'running' && <p className="muted" aria-busy="true">Going public: creating the Sputnik DAO, then the city token… ({ipo.txHashes.length} transaction{ipo.txHashes.length === 1 ? '' : 's'} so far)</p>}
      {ipo.state === 'done' && <Done ipo={ipo} busy={busy} run={run} />}
      {err && <p className="field-err" role="alert">{err}</p>}
    </section>
  );
}

function LaunchForm({ ipo, ceo, company, busy, onLaunch }: { ipo: IpoState; ceo: string | null; company: string; busy: boolean; onLaunch: (x: { ceoAccountId: string; symbol: string }) => void }) {
  const [account, setAccount] = useState(ipo.ceoAccountId ?? ceo ?? '');
  const [symbol, setSymbol] = useState(ipo.symbol ?? ipoSymbol(company));
  const ok = !!account.trim() && IPO_SYMBOL_RE.test(symbol);
  return (
    <form className="sched-form" onSubmit={(e) => { e.preventDefault(); if (ok) onLaunch({ ceoAccountId: account.trim(), symbol }); }}>
      <label className="field"><span className="lbl">Your NEAR account (approves DAO proposals)</span><input className="input mono" value={account} onChange={(e) => setAccount(e.target.value)} placeholder="you.near" /></label>
      <label className="field"><span className="lbl">City token symbol</span><input className="input mono" value={symbol} maxLength={8} onChange={(e) => setSymbol(e.target.value.toUpperCase())} /></label>
      <p className="fine">About 3.4 NEAR from the company wallet: 1 NEAR to the DAO, about 2 NEAR for the token.</p>
      {ipo.state === 'error' && ipo.error && <p className="field-err" role="alert">{ipo.error}</p>}
      <button className="btn primary small" type="submit" disabled={busy || !ok}>{busy ? 'Working…' : ipo.state === 'error' ? 'Retry IPO' : 'IPO'}</button>
    </form>
  );
}

function Done({ ipo, busy, run }: { ipo: IpoState; busy: boolean; run: (f: () => Promise<IpoState>) => Promise<boolean> }) {
  const dao = ipo.daoAccountId ?? '';
  const [to, setTo] = useState('');
  const [tokens, setTokens] = useState('');
  const [payToken, setPayToken] = useState<(typeof PAYOUT_TOKENS)[number]>('USDC');
  const [payAmount, setPayAmount] = useState('');
  const allocOk = !!to.trim() && Number.isInteger(Number(tokens)) && Number(tokens) > 0;
  const payOk = Number(payAmount) > 0;
  return (
    <>
      <dl className="kv">
        <div><dt>DAO</dt><dd>{ext(`${NB}/address/${dao}`, dao)} · {ext(trezu(dao), 'Open in Trezu')}</dd></div>
        <div><dt>Token</dt><dd>{ipo.tokenAccountId && ext(`${NB}/address/${ipo.tokenAccountId}`, ipo.tokenAccountId)} · {ipo.symbol} · Vibe City factory token</dd></div>
        {ipo.txHashes.length > 0 && <div><dt>Transactions</dt><dd>{ipo.txHashes.map((h, i) => <span key={h}>{i > 0 && ' · '}{ext(`${NB}/txns/${h}`, `${h.slice(0, 8)}…`)}</span>)}</dd></div>}
      </dl>
      <h4>Revenue share by DAO vote</h4>
      <p className="fine">Payouts are DAO proposals you approve in Trezu. Holders are accounts the DAO allocated tokens to. No sale, no promised returns.</p>
      {ipo.holders.length === 0 ? <p className="muted">No holders yet. Allocate tokens below.</p> : (
        <ul>{ipo.holders.map((h) => <li key={h.accountId}><span className="mono">{h.accountId}</span> · {h.balance === null ? '?' : h.balance.toLocaleString()} {ipo.symbol}</li>)}</ul>
      )}
      <form className="sched-form" onSubmit={(e) => { e.preventDefault(); if (allocOk) void run(() => api.ipoAllocate({ accountId: to.trim(), amount: Number(tokens) })).then((ok) => { if (ok) { setTo(''); setTokens(''); } }); }}>
        <span className="lbl">Allocate</span>
        <div className="row">
          <input className="input mono" aria-label="Receiving NEAR account" placeholder="investor.near" value={to} onChange={(e) => setTo(e.target.value)} />
          <input className="input" aria-label={`Whole ${ipo.symbol ?? 'city'} tokens`} inputMode="numeric" placeholder="tokens" value={tokens} onChange={(e) => setTokens(e.target.value.trim())} />
          <button className="btn small" type="submit" disabled={busy || !allocOk}>Propose</button>
        </div>
      </form>
      <form className="sched-form" onSubmit={(e) => { e.preventDefault(); if (payOk) void run(() => api.ipoDividend({ token: payToken, amount: Number(payAmount) })).then((ok) => { if (ok) setPayAmount(''); }); }}>
        <span className="lbl">Distribute revenue</span>
        <div className="row">
          <PixelSelect value={payToken} onChange={(v) => setPayToken(v as typeof payToken)} options={PAYOUT_TOKENS.map((t) => ({ value: t, label: t }))} aria-label="Payout token" />
          <input className="input" aria-label="Amount to distribute" inputMode="decimal" placeholder="0.00" value={payAmount} onChange={(e) => setPayAmount(e.target.value.trim())} />
          <button className="btn small" type="submit" disabled={busy || !payOk}>Propose</button>
        </div>
      </form>
      {ipo.proposals.length > 0 && (
        <ul>{ipo.proposals.map((p, i) => <li key={`${p.id ?? 'x'}-${i}`}>{p.kind === 'allocate' ? 'Allocate' : 'Dividend'}{p.id !== null && ` #${p.id}`} · {p.title} · {p.awaitingWalletApproval ? 'waiting for your OutLayer approval' : ext(`${trezu(dao)}/requests`, 'Approve in Trezu')}</li>)}</ul>
      )}
    </>
  );
}
