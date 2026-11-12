/* The IPO (docs/briefs/06-ipo.md), under the wallet pager in the safe, as the Vibe City Exchange's listing board.
   Before the IPO: the prospectus (valuation, the offer, a listing checklist with lamps, the launch fields) and the
   opening bell. After it: the symbol and price on split-flap tiles, a ticker tape, the share register, and the
   board's two acts: declare a dividend (a DAO proposal) and close the books (end the offering). */
import { useEffect, useRef, useState } from 'react';
import { IPO_SYMBOL_RE, PAYOUT_TOKENS, type IpoState, type WalletState } from '@vibe-city/shared';
import { useStore } from '../store';
import { api, ApiError } from '../../api';
import { ipoRang, ipoSteps, ipoSymbol, type IpoStep } from '../data/game';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Something went wrong.');
const NB = 'https://nearblocks.io';
const OUTLAYER_APP = 'https://app.outlayer.ai';
const trezu = (dao: string) => `https://trezu.app/${dao}`;
/** While a step waits for the owner's approval in OutLayer, ask again this often (the server never resends the call). */
const APPROVAL_POLL_MS = 5000;
const LAMP: Record<IpoStep['status'], string> = { done: 'Done', working: 'Working', approval: 'Approve in OutLayer', failed: 'Failed', todo: 'Pending' };

/** A NEAR amount with enough decimals to show three significant digits of small prices. */
export const fmtNear = (n: number) => n.toFixed(n >= 1 || n === 0 ? 2 : Math.min(9, 2 - Math.floor(Math.log10(n))));
const whole = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
// cents while small, so a first job's $0.48 does not read as $0
const usd = (n: number) => `$${n < 100 ? n.toFixed(2).replace(/\.00$/, '') : Math.round(n).toLocaleString()}`;
const short = (a: string) => (a.length > 30 ? `${a.slice(0, 14)}…${a.slice(-12)}` : a);
const ext = (href: string, text: string) => <a href={href} target="_blank" rel="noreferrer">{text}</a>;

/** Split-flap tiles: one per character; a tile that changes flips (it remounts with its new character). */
export function Flaps({ text, label }: { text: string; label: string }) {
  return (
    <span className="flaps" role="img" aria-label={`${label}: ${text}`}>
      {[...text].map((c, i) => <span key={`${i}-${c}`} className="flap" aria-hidden="true">{c === ' ' ? ' ' : c}</span>)}
    </span>
  );
}

function Bell() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3a1.5 1.5 0 0 1 1.5 1.5v.6A6 6 0 0 1 18 11v4l2 2.5V19H4v-1.5L6 15v-4a6 6 0 0 1 4.5-5.9v-.6A1.5 1.5 0 0 1 12 3Z" fill="currentColor" />
      <circle cx="12" cy="21" r="1.8" fill="currentColor" />
    </svg>
  );
}

export function IpoCard({ wallet }: { wallet: WalletState }) {
  const ceo = wallet.binding.accountId;
  const company = useStore((s) => s.company?.name ?? '');
  const [ipo, setIpoState] = useState<IpoState | null>(null);
  const was = useRef<IpoState['state'] | null>(null);
  /** Every answer from the server comes through here: the one that completes the IPO shuts the safe and rings the bell
      on the roof (world/City.ts), where the player can see it. */
  const setIpo = (x: IpoState) => {
    if (ipoRang(was.current, x.state)) { const s = useStore.getState(); s.closeFloor(); s.emit({ k: 'ipo', symbol: x.symbol ?? '' }); }
    was.current = x.state; setIpoState(x);
  };
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
  // the wallet's funds unlock the listing: read it again whenever the wallet was (Fund, Refresh, a new key)
  useEffect(() => { void load(); }, [wallet]);
  useEffect(() => {
    if (ipo?.state !== 'running' && ipo?.state !== 'awaiting_approval') return;
    const t = window.setInterval(() => void (ipo.state === 'running' ? load() : checkRef.current()), ipo.state === 'running' ? 3000 : APPROVAL_POLL_MS);
    return () => window.clearInterval(t);
  }, [ipo?.state]);

  if (!ipo) return err ? <p className="field-err" role="alert">{err}</p> : null;
  return (
    <section className="xb" aria-label="Vibe City Exchange">
      <header className="xb-head">
        <span className="xb-logo">VCX</span>
        <span className="xb-title">Vibe City Exchange<small>{ipo.state === 'done' ? 'Listed · city shares' : 'Pre-listing · prospectus'}</small></span>
        <span className={`xb-status ${ipo.state === 'done' ? (ipo.sale?.open ? 'open' : 'closed') : ipo.state === 'locked' ? 'closed' : 'pre'}`}>
          {ipo.state === 'done' ? (ipo.sale?.open ? 'Offering open' : 'Offering closed') : ipo.state === 'locked' ? 'Locked' : 'Pre-IPO'}
        </span>
      </header>
      {ipo.state === 'done'
        ? <Listed ipo={ipo} busy={busy} run={run} err={err} />
        : <Prospectus ipo={ipo} ceo={ceo} company={company} busy={busy} checking={checking} err={err} onLaunch={(x) => void run(() => api.ipoLaunch(x))} onCheck={() => void check()} />}
    </section>
  );
}

/** Before and during the IPO: the offer, the listing checklist, the launch fields and the opening bell. */
function Prospectus({ ipo, ceo, company, busy, checking, err, onLaunch, onCheck }: {
  ipo: IpoState; ceo: string | null; company: string; busy: boolean; checking: boolean; err: string | null;
  onLaunch: (x: { ceoAccountId: string; symbol: string }) => void; onCheck: () => void;
}) {
  const [account, setAccount] = useState(ipo.ceoAccountId ?? ceo ?? '');
  const [symbol, setSymbol] = useState(ipo.symbol ?? ipoSymbol(company));
  const locked = ipo.state === 'locked';
  const steps = ipoSteps(ipo, busy);
  const waiting = steps.find((s) => s.status === 'approval');
  const started = busy || ipo.state === 'running' || ipo.state === 'awaiting_approval';
  // fixed on chain once the DAO (the council) or the token (the symbol) exists
  const daoFixed = !!ipo.daoAccountId, tokenFixed = !!ipo.tokenAccountId;
  const ok = !locked && !started && !!account.trim() && IPO_SYMBOL_RE.test(symbol);
  const o = ipo.offer;
  const problem = err && err !== ipo.error ? err : null;
  return (
    <div className="xb-body">
      <div className="xb-board">
        <div className="xb-cell"><span className="xb-k">Valuation</span><Flaps text={o ? usd(o.valuationUsd) : '—'} label="Valuation" /></div>
        <div className="xb-cell"><span className="xb-k">Offer price · NEAR</span><Flaps text={o ? fmtNear(o.priceNear) : '—'} label="Offer price" /></div>
      </div>
      <p className="xb-fine">
        {o ? <>$1,000 + earned {usd(o.earnedUsd)} × {o.multiple} over {o.supply.toLocaleString()} shares; {o.floatTokens.toLocaleString()} offered to the public, the rest kept by the company's DAO.</>
          : 'NEAR price unavailable: the offering is priced when the bell rings.'}
      </p>
      {locked ? <p className="xb-fine">The listing opens after your first paid market job and with 4 NEAR in the company wallet.</p> : <>
        <ol className="xb-check" aria-live="polite">
          {steps.map((s) => (
            <li key={s.id} className={s.status}>
              <i className="lamp" aria-hidden="true" />
              <span><b>{s.label}</b><small>{s.status === 'failed' && ipo.error ? ipo.error : s.status === 'approval' ? 'Approve it in OutLayer; the board carries on by itself.' : s.detail}</small></span>
              <em>{LAMP[s.status]}</em>
            </li>
          ))}
        </ol>
        {!started && (
          <form className="xb-form" onSubmit={(e) => { e.preventDefault(); if (ok) onLaunch({ ceoAccountId: account.trim(), symbol }); }}>
            <label><span>Chair · your NEAR account</span><input value={account} disabled={daoFixed} onChange={(e) => setAccount(e.target.value)} placeholder="you.near" spellCheck={false} /></label>
            <label><span>Ticker symbol</span><input value={symbol} disabled={tokenFixed} maxLength={8} onChange={(e) => setSymbol(e.target.value.toUpperCase())} spellCheck={false} /></label>
          </form>
        )}
        {/* a disabled bell says why */}
        {!started && !ok && <p className="xb-fine">{!account.trim() ? 'Enter your NEAR account to ring the bell.' : 'Ticker: 2 to 8 letters or digits, starting with a letter.'}</p>}
      </>}
      {problem && <p className="xb-err" role="alert">{problem}</p>}
      <div className="xb-actions">
        {waiting
          ? <button className="bell" type="button" disabled={checking} onClick={onCheck}><Bell /><span>{checking ? 'Checking OutLayer…' : 'Check approval'}</span></button>
          : <button className="bell" type="button" disabled={!ok} onClick={() => onLaunch({ ceoAccountId: account.trim(), symbol })}><Bell />
            <span>{started ? 'Listing…' : ipo.state === 'error' ? 'Ring the bell again' : daoFixed ? 'Continue the listing' : 'Ring the opening bell'}</span></button>}
        <span className="xb-links">
          {/* only when there is something to approve there; the safe's Policy button covers the rest of OutLayer */}
          {waiting && ext(OUTLAYER_APP, 'Approve in OutLayer ▸')}
          {ipo.daoAccountId && ext(trezu(ipo.daoAccountId), 'DAO on Trezu ▸')}
        </span>
      </div>
      <p className="xb-fine">{daoFixed ? 'The DAO exists; the shares need about 2.3 NEAR in the company wallet.' : 'About 3.3 NEAR from the company wallet: 1 for the DAO, about 2.3 for the shares. Each call is approved by you in OutLayer.'}</p>
    </div>
  );
}

/** After the IPO: the board, the tape, the register, and the two acts. */
function Listed({ ipo, busy, run, err }: { ipo: IpoState; busy: boolean; run: (f: () => Promise<IpoState>) => Promise<boolean>; err: string | null }) {
  const [act, setAct] = useState<'none' | 'dividend' | 'close'>('none');
  const [payToken, setPayToken] = useState<(typeof PAYOUT_TOKENS)[number]>('USDC');
  const [payAmount, setPayAmount] = useState('');
  const [copied, setCopied] = useState(false);
  const dao = ipo.daoAccountId ?? '';
  const sale = ipo.sale, offer = ipo.offer;
  const float = sale ? sale.sold + sale.remaining : 0;
  const pct = sale && float > 0 ? (sale.sold / float) * 100 : 0;
  const buyLink = `${window.location.origin}/invest`;
  const payOk = Number(payAmount) > 0;
  const copy = () => { void navigator.clipboard?.writeText(buyLink).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }); };
  const declare = () => { if (payOk) void run(() => api.ipoDividend({ token: payToken, amount: Number(payAmount) })).then((ok) => { if (ok) { setPayAmount(''); setAct('none'); } }); };
  const close = () => void run(() => api.ipoEndSale()).then((ok) => { if (ok) setAct('none'); });
  const tape = [
    `${ipo.symbol} ${offer ? fmtNear(offer.priceNear) : '—'} NEAR`,
    sale && `${whole(sale.sold)} SOLD`,
    sale && `${fmtNear(sale.raisedNear)} NEAR RAISED`,
    ...ipo.holders.map((h) => `${short(h.accountId)} ${h.balance === null ? '?' : whole(h.balance)}`),
  ].filter(Boolean).join('  ◆  ');
  return (
    <div className="xb-body">
      <div className="xb-board">
        <div className="xb-cell"><span className="xb-k">Symbol</span><Flaps text={ipo.symbol ?? ''} label="Symbol" /></div>
        <div className="xb-cell"><span className="xb-k">Price · NEAR</span><Flaps text={offer ? fmtNear(offer.priceNear) : '—'} label="Price" /></div>
      </div>
      <div className="xb-tape" aria-hidden="true"><div className="xb-tape-track"><span>{tape}  ◆  </span><span>{tape}  ◆  </span></div></div>
      {sale ? (
        <div className="xb-stats">
          <div><span className="xb-k">Float sold</span><b>{whole(sale.sold)}</b><small>of {whole(float)} · {pct < 1 && pct > 0 ? pct.toFixed(2) : Math.round(pct)}%</small></div>
          <div><span className="xb-k">Raised · to the DAO</span><b>{fmtNear(sale.raisedNear)}</b><small>NEAR</small></div>
          <div><span className="xb-k">Shareholders</span><b>{sale.buyers}</b><small>{offer && `≈ $${(offer.priceNear * offer.nearUsd).toFixed(4)} a share`}</small></div>
        </div>
      ) : <p className="xb-fine">The offering could not be read right now.</p>}
      {sale && <div className="xb-meter" role="progressbar" aria-label="Float sold" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${Math.max(pct, sale.sold > 0 ? 1 : 0)}%` }} /></div>}

      <table className="xb-register">
        <caption>Register of shareholders</caption>
        <thead><tr><th scope="col">Holder</th><th scope="col">Shares</th><th scope="col">Of float</th></tr></thead>
        <tbody>
          {ipo.holders.length === 0
            ? <tr><td colSpan={3} className="xb-empty">No subscribers yet. Share the subscription link.</td></tr>
            : ipo.holders.map((h) => <tr key={h.accountId}><td>{ext(`${NB}/address/${h.accountId}`, short(h.accountId))}</td><td>{h.balance === null ? '?' : whole(h.balance)}</td><td>{h.balance !== null && float > 0 ? `${((h.balance / float) * 100).toFixed(2)}%` : ''}</td></tr>)}
        </tbody>
      </table>

      {act === 'dividend' && (
        <form className="xb-act" onSubmit={(e) => { e.preventDefault(); declare(); }}>
          <b>Declare a dividend</b>
          <div className="xb-act-row">
            <span className="xb-seg" role="group" aria-label="Pay in">
              {PAYOUT_TOKENS.map((t) => <button key={t} type="button" aria-pressed={payToken === t} className={payToken === t ? 'on' : undefined} onClick={() => setPayToken(t)}>{t}</button>)}
            </span>
            <input inputMode="decimal" autoFocus placeholder="0.00" aria-label={`${payToken} to distribute`} value={payAmount} onChange={(e) => setPayAmount(e.target.value.trim())} />
            <button className="xb-btn primary" type="submit" disabled={busy || !payOk}>{busy ? 'Filing…' : 'Propose'}</button>
            <button className="xb-btn" type="button" onClick={() => setAct('none')}>Cancel</button>
          </div>
          <small>One DAO proposal pays the {ipo.holders.length} shareholder{ipo.holders.length === 1 ? '' : 's'} pro rata from the DAO's {payToken}. You approve it in Trezu; nothing is promised to holders.</small>
        </form>
      )}
      {act === 'close' && sale && (
        <div className="xb-act">
          <b>Close the books</b>
          <small>{whole(sale.remaining)} unsold {ipo.symbol} return to the DAO and the offering stops. This files a DAO proposal you approve in Trezu.</small>
          <div className="xb-act-row">
            <button className="xb-btn primary" type="button" disabled={busy} onClick={close}>{busy ? 'Filing…' : 'Propose closing'}</button>
            <button className="xb-btn" type="button" onClick={() => setAct('none')}>Cancel</button>
          </div>
        </div>
      )}
      {act === 'none' && (
        <div className="xb-actions">
          <button className="xb-btn primary" type="button" onClick={copy} title={buyLink}>{copied ? 'Link copied' : 'Copy subscription link'}</button>
          <button className="xb-btn" type="button" onClick={() => setAct('dividend')}>Declare a dividend</button>
          {sale?.open && <button className="xb-btn" type="button" onClick={() => setAct('close')}>Close the books</button>}
        </div>
      )}
      {err && <p className="xb-err" role="alert">{err}</p>}

      {ipo.proposals.length > 0 && (
        <ul className="xb-minutes" aria-label="DAO proposals">
          {ipo.proposals.slice(-3).reverse().map((p, i) => (
            <li key={`${p.id ?? 'x'}-${i}`}><span>{p.kind === 'end_sale' ? 'Close the books' : 'Dividend'}{p.id !== null && ` · #${p.id}`}</span>
              {p.awaitingWalletApproval ? <em>waiting for your OutLayer approval</em> : ext(`${trezu(dao)}/requests`, 'approve in Trezu ▸')}</li>
          ))}
        </ul>
      )}
      <p className="xb-fine">
        {ext(`${NB}/address/${ipo.tokenAccountId}`, ipo.tokenAccountId ?? '')} · proceeds to {ext(trezu(dao), dao)} · dividends by DAO vote
      </p>
    </div>
  );
}
