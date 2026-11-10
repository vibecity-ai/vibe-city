/* The IPO card (docs/briefs/06-ipo.md), under the wallet in the safe: the company wallet creates the Sputnik DAO and a
   city token from the Vibe City token factory, then the CEO shares revenue by DAO proposals approved in Trezu. */
import { useEffect, useRef, useState } from 'react';
import { IPO_SYMBOL_RE, PAYOUT_TOKENS, type IpoState } from '@vibe-city/shared';
import { useStore } from '../store';
import { api, ApiError } from '../../api';
import { ipoSteps, ipoSymbol, type IpoStep } from '../data/game';
import { PixelSelect } from './kit';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Something went wrong.');
const NB = 'https://nearblocks.io';
const ext = (href: string, text: string) => <a href={href} target="_blank" rel="noreferrer">{text}</a>;
const trezu = (dao: string) => `https://trezu.app/${dao}`;
/** While a step waits for the owner's approval in OutLayer, ask again this often (the server never resends the call). */
const APPROVAL_POLL_MS = 5000;
const CHIP: Record<IpoStep['status'], string> = { done: 'Done', working: 'Working…', approval: 'Approve in OutLayer', failed: 'Failed', todo: '' };

export function IpoCard({ ceo }: { ceo: string | null }) {
  const company = useStore((s) => s.company?.name ?? '');
  const [ipo, setIpo] = useState<IpoState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const load = async () => { try { setIpo(await api.ipo()); } catch (e) { setErr(errText(e)); } };
  const run = async (f: () => Promise<IpoState>) => {
    setBusy(true); setErr(null);
    try { setIpo(await f()); return true; } catch (e) { setErr(errText(e)); void load(); return false; } finally { setBusy(false); }
  };
  /** Continue a waiting IPO: the server asks OutLayer where the request stands and goes on if it was approved. */
  const check = async () => {
    if (!ipo || checking) return;
    setChecking(true);
    try { setIpo(await api.ipoLaunch({ ceoAccountId: ipo.ceoAccountId ?? '', symbol: ipo.symbol ?? '' })); setErr(null); }
    catch (e) { setErr(errText(e)); void load(); }
    finally { setChecking(false); }
  };
  const checkRef = useRef(check);
  checkRef.current = check;
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (ipo?.state !== 'running' && ipo?.state !== 'awaiting_approval') return;
    const t = window.setInterval(() => void (ipo.state === 'running' ? load() : checkRef.current()), ipo.state === 'running' ? 3000 : APPROVAL_POLL_MS);
    return () => window.clearInterval(t);
  }, [ipo?.state]);

  if (!ipo) return err ? <p className="field-err" role="alert">{err}</p> : null;
  const steps = ipoSteps(ipo, busy);
  const waiting = steps.find((s) => s.status === 'approval');
  return (
    <section className="ipo">
      <h3>IPO</h3>
      {ipo.state === 'locked' && <>
        <button className="btn primary small" disabled title="Unlocks after your first paid market job and 4 NEAR in the company wallet">IPO</button>
        <p className="fine">Unlocks after your first paid market job and 4 NEAR in the company wallet.</p>
      </>}
      {ipo.state !== 'locked' && ipo.state !== 'done' && <><Offer ipo={ipo} /><Steps steps={steps} error={ipo.error} /></>}
      {waiting && (
        <div className="ipo-approve" role="status">
          <p>Your OutLayer wallet asks you to approve each call. Approve <b>{waiting.label.toLowerCase()}</b> at {ext('https://app.outlayer.ai', 'app.outlayer.ai')}; this continues by itself.</p>
          <button className="btn secondary small" disabled={checking} onClick={() => void check()}>{checking ? 'Checking…' : 'Check now'}</button>
        </div>
      )}
      {!busy && (ipo.state === 'ready' || ipo.state === 'error') && <LaunchForm ipo={ipo} ceo={ceo} company={company} onLaunch={(x) => void run(() => api.ipoLaunch(x))} />}
      {ipo.state === 'done' && <Done ipo={ipo} busy={busy} run={run} />}
      {err && err !== ipo.error && <p className="field-err" role="alert">{err}</p>}
    </section>
  );
}

const usd = (n: number) => `$${Math.round(n).toLocaleString()}`;

function Offer({ ipo }: { ipo: IpoState }) {
  const o = ipo.offer;
  if (!o) return <p className="fine">NEAR price unavailable; the price is set when you press IPO.</p>;
  return (
    <p className="fine">
      Valuation {usd(o.valuationUsd)} (earned {usd(o.earnedUsd)} × {o.multiple}, minimum $1,000) · 40% float: {o.floatTokens.toLocaleString()} tokens
      at {o.priceNear} NEAR each (≈ ${(o.priceNear * o.nearUsd).toFixed(4)})
    </p>
  );
}

function Steps({ steps, error }: { steps: IpoStep[]; error: string | null }) {
  return (
    <ol className="ipo-steps" aria-live="polite">
      {steps.map((s) => (
        <li key={s.id} className={s.status}>
          <span className="ipo-dot" aria-hidden="true">{s.status === 'done' ? '✓' : s.status === 'failed' ? '!' : ''}</span>
          <span className="ipo-step-t"><b>{s.label}</b><small className={s.status === 'failed' ? 'field-err' : undefined}>{s.status === 'failed' && error ? error : s.detail}</small></span>
          <span className="ipo-chip">{CHIP[s.status]}</span>
        </li>
      ))}
    </ol>
  );
}

function LaunchForm({ ipo, ceo, company, onLaunch }: { ipo: IpoState; ceo: string | null; company: string; onLaunch: (x: { ceoAccountId: string; symbol: string }) => void }) {
  const [account, setAccount] = useState(ipo.ceoAccountId ?? ceo ?? '');
  const [symbol, setSymbol] = useState(ipo.symbol ?? ipoSymbol(company));
  const ok = !!account.trim() && IPO_SYMBOL_RE.test(symbol);
  // fixed on chain once the DAO (the council) or the token (the symbol) exists
  const daoFixed = !!ipo.daoAccountId, tokenFixed = !!ipo.tokenAccountId;
  return (
    <form className="sched-form" onSubmit={(e) => { e.preventDefault(); if (ok) onLaunch({ ceoAccountId: account.trim(), symbol }); }}>
      <label className="field"><span className="lbl">Your NEAR account (approves DAO proposals)</span><input className="input mono" value={account} disabled={daoFixed} onChange={(e) => setAccount(e.target.value)} placeholder="you.near" /></label>
      <label className="field"><span className="lbl">City token symbol</span><input className="input mono" value={symbol} disabled={tokenFixed} maxLength={8} onChange={(e) => setSymbol(e.target.value.toUpperCase())} /></label>
      <p className="fine">{daoFixed ? 'The DAO exists; the token needs about 2.3 NEAR in the company wallet.' : 'About 3.3 NEAR in the company wallet: 1 NEAR to the DAO, about 2.3 NEAR for the token.'}</p>
      <button className="btn primary small" type="submit" disabled={!ok}>{ipo.state === 'error' ? 'Retry IPO' : daoFixed ? 'Continue IPO' : 'IPO'}</button>
    </form>
  );
}

function Done({ ipo, busy, run }: { ipo: IpoState; busy: boolean; run: (f: () => Promise<IpoState>) => Promise<boolean> }) {
  const dao = ipo.daoAccountId ?? '';
  const sale = ipo.sale;
  const float = sale ? sale.sold + sale.remaining : 0;
  const buyLink = `${window.location.origin}/invest`;
  const [payToken, setPayToken] = useState<(typeof PAYOUT_TOKENS)[number]>('USDC');
  const [payAmount, setPayAmount] = useState('');
  const payOk = Number(payAmount) > 0;
  return (
    <>
      <dl className="kv">
        <div><dt>DAO</dt><dd>{ext(`${NB}/address/${dao}`, dao)} · {ext(trezu(dao), 'Open in Trezu')}</dd></div>
        <div><dt>Token</dt><dd>{ipo.tokenAccountId && ext(`${NB}/address/${ipo.tokenAccountId}`, ipo.tokenAccountId)} · {ipo.symbol} · Vibe City factory token</dd></div>
        {ipo.txHashes.length > 0 && <div><dt>Transactions</dt><dd>{ipo.txHashes.map((h, i) => <span key={h}>{i > 0 && ' · '}{ext(`${NB}/txns/${h}`, `${h.slice(0, 8)}…`)}</span>)}</dd></div>}
      </dl>
      <h4>Offering</h4>
      {!sale ? <p className="muted">The offering could not be read right now.</p> : <>
        <dl className="kv">
          <div><dt>Status</dt><dd>{sale.open ? 'Open' : 'Closed'}</dd></div>
          <div><dt>Sold</dt><dd>{sale.sold.toLocaleString()} / {float.toLocaleString()} {ipo.symbol}<SaleBar sold={sale.sold} float={float} /></dd></div>
          <div><dt>Raised</dt><dd>{sale.raisedNear.toLocaleString()} NEAR · {sale.buyers} buyer{sale.buyers === 1 ? '' : 's'}</dd></div>
          <div><dt>Buy link</dt><dd><a href="/invest" target="_blank" rel="noreferrer">/invest</a> · <span className="mono">{buyLink}</span> <button className="btn small" type="button" onClick={() => void navigator.clipboard?.writeText(buyLink)}>Copy</button></dd></div>
        </dl>
        {sale.open && <button className="btn secondary small" disabled={busy} onClick={() => void run(() => api.ipoEndSale())}>End the offering</button>}
      </>}
      <h4>Revenue share by DAO vote</h4>
      <p className="fine">Shareholders are the offering's buyers. Payouts are DAO proposals you approve in Trezu. No promised returns.</p>
      {ipo.holders.length === 0 ? <p className="muted">No buyers yet. Share the buy link.</p> : (
        <ul>{ipo.holders.map((h) => <li key={h.accountId}><span className="mono">{h.accountId}</span> · {h.balance === null ? '?' : h.balance.toLocaleString()} {ipo.symbol}</li>)}</ul>
      )}
      <form className="sched-form" onSubmit={(e) => { e.preventDefault(); if (payOk) void run(() => api.ipoDividend({ token: payToken, amount: Number(payAmount) })).then((ok) => { if (ok) setPayAmount(''); }); }}>
        <span className="lbl">Distribute revenue</span>
        <div className="row">
          <PixelSelect value={payToken} onChange={(v) => setPayToken(v as typeof payToken)} options={PAYOUT_TOKENS.map((t) => ({ value: t, label: t }))} aria-label="Payout token" />
          <input className="input" aria-label="Amount to distribute" inputMode="decimal" placeholder="0.00" value={payAmount} onChange={(e) => setPayAmount(e.target.value.trim())} />
          <button className="btn small" type="submit" disabled={busy || !payOk}>Propose</button>
        </div>
      </form>
      {ipo.proposals.length > 0 && (
        <ul>{ipo.proposals.map((p, i) => <li key={`${p.id ?? 'x'}-${i}`}>{p.kind === 'end_sale' ? 'End the offering' : 'Dividend'}{p.id !== null && ` #${p.id}`} · {p.title} · {p.awaitingWalletApproval ? 'waiting for your OutLayer approval' : ext(`${trezu(dao)}/requests`, 'approve in Trezu')}</li>)}</ul>
      )}
    </>
  );
}

export function SaleBar({ sold, float }: { sold: number; float: number }) {
  const pct = float > 0 ? Math.min(100, (sold / float) * 100) : 0;
  return <span className="sale-bar" role="progressbar" aria-label="Float sold" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${pct}%` }} /></span>;
}
