/* The IPO device (docs/briefs/06-ipo.md), under the wallet pager in the safe: a share ticker in the same device kit.
   Before the IPO its LCD shows the offer (priced from the game's numbers), the three on-chain steps and the launch
   fields; after it, the offering (price, float sold, NEAR raised for the DAO), the shareholders and the DAO's
   proposals. Keys switch the screen like the pager's: payout (revenue share by DAO vote) and end sale. */
import { useEffect, useRef, useState } from 'react';
import { IPO_SYMBOL_RE, PAYOUT_TOKENS, type IpoState } from '@vibe-city/shared';
import { useStore } from '../store';
import { api, ApiError } from '../../api';
import { ipoSteps, ipoSymbol, type IpoStep } from '../data/game';
import { Device, Digits, Grille, Key, LcdBar, Screen } from './Device';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Something went wrong.');
const NB = 'https://nearblocks.io';
const OUTLAYER_APP = 'https://app.outlayer.ai';
const trezu = (dao: string) => `https://trezu.app/${dao}`;
/** While a step waits for the owner's approval in OutLayer, ask again this often (the server never resends the call). */
const APPROVAL_POLL_MS = 5000;
const MARK: Record<IpoStep['status'], string> = { done: '✓', working: '…', approval: '◆', failed: '!', todo: '·' };
const STATUS: Record<IpoStep['status'], string> = { done: 'Done', working: 'Working', approval: 'Approve', failed: 'Failed', todo: '' };

/** A NEAR amount with enough decimals to show three significant digits of small prices. */
export const fmtNear = (n: number) => n.toFixed(n >= 1 || n === 0 ? 2 : Math.min(9, 2 - Math.floor(Math.log10(n))));
const whole = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
const usd = (n: number) => `$${Math.round(n).toLocaleString()}`;
const short = (a: string) => (a.length > 30 ? `${a.slice(0, 14)}…${a.slice(-12)}` : a);
const ext = (href: string, text: string) => <a href={href} target="_blank" rel="noreferrer">{text}</a>;

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
  if (ipo.state === 'done') return <Ticker ipo={ipo} busy={busy} run={run} err={err} />;
  return <Launcher ipo={ipo} ceo={ceo} company={company} busy={busy} checking={checking} err={err} onLaunch={(x) => void run(() => api.ipoLaunch(x))} onCheck={() => void check()} />;
}

/** Before and during the IPO: the offer, the steps, the launch fields. */
function Launcher({ ipo, ceo, company, busy, checking, err, onLaunch, onCheck }: {
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
  const launch = () => { if (ok) onLaunch({ ceoAccountId: account.trim(), symbol }); };
  const o = ipo.offer;
  const problem = (err && err !== ipo.error ? err : null);
  return (
    <Device model="IPO-1" name="share ticker" shell="graphite" led={locked ? 'off' : waiting ? 'amber' : started ? 'green' : 'pink'} className="safe-dev ipo-dev">
      <div className="safe-body">
        <Screen kind="lcd" className="safe-lcd" label="IPO display">
          <div className="scr-row"><span>Initial public offering</span><span>{locked ? '○ Locked' : waiting ? '◆ Approve' : started ? '● Going public' : ipo.state === 'error' ? '! Stopped' : '● Ready'}</span></div>
          {o ? <>
            <div className="scr-row safe-lbl"><span>Valuation</span><span>Earned {usd(o.earnedUsd)} × {o.multiple} · min $1,000</span></div>
            <div><Digits value={usd(o.valuationUsd)} /></div>
            <div className="scr-row"><span>{o.floatTokens.toLocaleString()} shares offered</span><span>{fmtNear(o.priceNear)} NEAR each</span></div>
          </> : <p className="scr-mono safe-hint">NEAR price unavailable: the offering is priced when you press IPO.</p>}
          <div className="scr-rule" />
          {locked ? <p className="scr-mono safe-hint">Unlocks after your first paid market job and 4 NEAR in the company wallet.</p> : <>
            <ol className="ipo-lcd-steps" aria-live="polite">
              {steps.map((s) => (
                <li key={s.id} className={s.status}>
                  <div className="scr-row"><span>{MARK[s.status]} {s.label}</span><span>{STATUS[s.status]}</span></div>
                  <div className="scr-mono">{s.status === 'failed' && ipo.error ? `! ${ipo.error}` : s.status === 'approval' ? 'Approve it in OutLayer; this continues by itself.' : s.detail}</div>
                </li>
              ))}
            </ol>
            {!started && (
              <form className="ipo-lcd-form" onSubmit={(e) => { e.preventDefault(); launch(); }}>
                <label><span className="scr-row"><span>Your NEAR account · approves</span></span>
                  <input className="scr-input scr-mono" value={account} disabled={daoFixed} onChange={(e) => setAccount(e.target.value)} placeholder="you.near" spellCheck={false} /></label>
                <label><span className="scr-row"><span>Share symbol</span></span>
                  <input className="scr-input scr-mono" value={symbol} disabled={tokenFixed} maxLength={8} onChange={(e) => setSymbol(e.target.value.toUpperCase())} spellCheck={false} /></label>
              </form>
            )}
          </>}
          {problem && <p className="scr-mono safe-err" role="alert">! {problem}</p>}
          <div className="scr-row safe-foot"><span>{daoFixed ? 'Token: ~2.3 NEAR' : 'DAO 1 + token ~2.3 NEAR'}</span><span>Signed by the company wallet</span></div>
        </Screen>
        <div className="safe-keys" role="group" aria-label="IPO keys">
          {waiting
            ? <Key hot disabled={checking} onClick={onCheck}>{checking ? 'Checking' : 'Check'}</Key>
            : <Key hot disabled={!ok} onClick={launch}>{started ? 'Working' : ipo.state === 'error' ? 'Retry' : daoFixed ? 'Continue' : 'IPO'}</Key>}
          <Key href={OUTLAYER_APP} title="Approve the company wallet's calls on OutLayer">OutLayer</Key>
          {ipo.daoAccountId && <Key href={trezu(ipo.daoAccountId)} title="The company's DAO on Trezu">Trezu</Key>}
          <Grille className="safe-grille" />
        </div>
      </div>
    </Device>
  );
}

/** After the IPO: the offering and the shareholders, revenue share and closing the offering. */
function Ticker({ ipo, busy, run, err }: { ipo: IpoState; busy: boolean; run: (f: () => Promise<IpoState>) => Promise<boolean>; err: string | null }) {
  const [mode, setMode] = useState<'view' | 'payout' | 'end'>('view');
  const [payToken, setPayToken] = useState<(typeof PAYOUT_TOKENS)[number]>('USDC');
  const [payAmount, setPayAmount] = useState('');
  const [copied, setCopied] = useState(false);
  const dao = ipo.daoAccountId ?? '';
  const sale = ipo.sale, offer = ipo.offer;
  const float = sale ? sale.sold + sale.remaining : 0;
  const buyLink = `${window.location.origin}/invest`;
  const payOk = Number(payAmount) > 0;
  const copy = () => { void navigator.clipboard?.writeText(buyLink).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }); };
  const payout = () => { if (payOk) void run(() => api.ipoDividend({ token: payToken, amount: Number(payAmount) })).then((ok) => { if (ok) { setPayAmount(''); setMode('view'); } }); };
  const endSale = () => void run(() => api.ipoEndSale()).then((ok) => { if (ok) setMode('view'); });
  const recent = ipo.proposals.slice(-3).reverse();
  return (
    <Device model="IPO-1" name="share ticker" shell="graphite" led={sale?.open ? 'green' : 'off'} className="safe-dev ipo-dev">
      <div className="safe-body">
        <Screen kind="lcd" className="safe-lcd" label="Share ticker display">
          <div className="scr-row"><span>{ipo.symbol} · city shares</span><span>{sale ? (sale.open ? '● Offering open' : '○ Offering closed') : '…'}</span></div>
          <div className="scr-mono safe-acct">{ipo.tokenAccountId && ext(`${NB}/address/${ipo.tokenAccountId}`, short(ipo.tokenAccountId))}</div>
          {mode === 'view' && <>
            <div className="scr-row safe-lbl"><span>Price per share</span><span>{offer && `≈ $${(offer.priceNear * offer.nearUsd).toFixed(4)}`}</span></div>
            <div><Digits value={offer ? fmtNear(offer.priceNear) : '-'} /> <span className="scr-mono">NEAR</span></div>
            {sale ? <>
              <div className="scr-row safe-lbl"><span>Sold</span><span>{whole(sale.sold)} / {whole(float)}</span></div>
              <LcdBar value={sale.sold} max={float} label="Shares sold" />
              <div className="scr-row safe-lbl"><span>Raised · to the DAO</span><span>{fmtNear(sale.raisedNear)} NEAR</span></div>
            </> : <p className="scr-mono safe-hint">The offering could not be read right now.</p>}
            <div className="scr-row safe-lbl"><span>Shareholders · {ipo.holders.length}</span><span>{ipo.symbol}</span></div>
            {ipo.holders.length === 0 ? <p className="scr-mono safe-hint">No buyers yet. Press Buy link and share it.</p> : (
              <ul className="safe-holdings">
                {ipo.holders.map((h) => <li key={h.accountId} className="scr-row"><span>{short(h.accountId)}</span><span>{h.balance === null ? '?' : whole(h.balance)}</span></li>)}
              </ul>
            )}
            {recent.length > 0 && <>
              <div className="scr-row safe-lbl"><span>DAO proposals</span><span>{ext(`${trezu(dao)}/requests`, 'Approve in Trezu ▸')}</span></div>
              <ul className="safe-holdings">
                {recent.map((p, i) => <li key={`${p.id ?? 'x'}-${i}`} className="scr-row"><span>{p.kind === 'end_sale' ? 'End sale' : 'Payout'}{p.id !== null && ` #${p.id}`}</span><span>{p.awaitingWalletApproval ? 'OutLayer approval' : 'In Trezu'}</span></li>)}
              </ul>
            </>}
          </>}
          {mode === 'payout' && (
            <form onSubmit={(e) => { e.preventDefault(); payout(); }}>
              <div className="scr-row safe-lbl"><span>Revenue share · by DAO vote</span><span>{payToken}</span></div>
              <input className="scr-input lcd-seg" inputMode="decimal" autoFocus placeholder="0.00" aria-label={`${payToken} to distribute`} value={payAmount} onChange={(e) => setPayAmount(e.target.value.trim())} />
              <p className="scr-mono safe-hint">One DAO proposal pays the {ipo.holders.length} shareholder{ipo.holders.length === 1 ? '' : 's'} pro rata to their shares, from the DAO's {payToken}. You approve it in Trezu. Nothing is promised to holders.</p>
            </form>
          )}
          {mode === 'end' && sale && <>
            <div className="scr-row safe-lbl"><span>End the offering</span></div>
            <p className="scr-mono safe-hint">{whole(sale.remaining)} unsold {ipo.symbol} return to the DAO and nobody can buy after. This files a DAO proposal you approve in Trezu.</p>
          </>}
          {err && <p className="scr-mono safe-err" role="alert">! {err}</p>}
          <div className="scr-row safe-foot"><span>{ext(trezu(dao), short(dao))}</span><span>Payouts by DAO vote</span></div>
        </Screen>
        <div className="safe-keys" role="group" aria-label="Share ticker keys">
          {mode === 'view' && <>
            <Key hot onClick={copy} title={buyLink}>{copied ? 'Copied' : 'Buy link'}</Key>
            <Key onClick={() => setMode('payout')}>Payout</Key>
            {sale?.open && <Key onClick={() => setMode('end')}>End sale</Key>}
            <Key href={trezu(dao)} title="The company's DAO on Trezu">Trezu</Key>
          </>}
          {mode === 'payout' && <>
            <Key hot disabled={busy || !payOk} onClick={payout}>{busy ? 'Filing' : 'Propose'}</Key>
            {PAYOUT_TOKENS.map((t) => <Key key={t} lit={payToken === t} pressed={payToken === t} onClick={() => setPayToken(t)}>{t}</Key>)}
            <Key onClick={() => setMode('view')}>Back</Key>
          </>}
          {mode === 'end' && <>
            <Key hot disabled={busy} onClick={endSale}>{busy ? 'Filing' : 'Propose'}</Key>
            <Key onClick={() => setMode('view')}>Back</Key>
          </>}
          <Grille className="safe-grille" />
        </div>
      </div>
    </Device>
  );
}
