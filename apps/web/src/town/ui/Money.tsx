/* The safe: the company's OutLayer custody wallet (docs/briefs/03-outlayer-wallet.md). Its keys live in OutLayer's TEE;
   Vibe City keeps only the wallet's agent key, server-side, for the floors that trade. The CEO creates the wallet at
   app.outlayer.ai/wallet/new and pastes its agent key. Spending limits are set in OutLayer, never here.
   Binding to the CEO's NEAR account (POST /api/wallet/bind) is not offered: on mainnet OutLayer cannot build that
   transaction yet (its wallet contract is not published there, checked 2026-11-08). */
import { useEffect, useState } from 'react';
import type { WalletState } from '@vibe-city/shared';
import { useStore } from '../store';
import { api, ApiError } from '../../api';
import { Device, Digits, Grille, Key, Screen } from './Device';
import { IpoCard } from './IpoCard';

const NEW_WALLET_URL = 'https://app.outlayer.ai/wallet/new';
/** Native USDC on NEAR (what the trading connectors settle in, through Intents). */
const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const OUTLAYER_APP = 'https://app.outlayer.ai/wallet';
const errText = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Something went wrong.');
/** A raw token amount in human units, up to 4 decimals. */
const human = (raw: string, d: number) => (d >= 4 ? Number(BigInt(raw) / 10n ** BigInt(d - 4)) / 1e4 : Number(raw) / 10 ** d).toLocaleString(undefined, { maximumFractionDigits: 4 });
const usd = (n: number) => n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
/** LCD digits with their unlit segments behind: every digit's ghost is an 8. */
const refreshGame = () => void api.game().then((game) => useStore.setState({ game })).catch(() => undefined);

export function MoneyScreen() {
  const [w, setW] = useState<WalletState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(true);
  const load = async () => { try { setW(await api.wallet()); setError(null); } catch (e) { setError(errText(e)); } };
  useEffect(() => { void load(); const t = window.setTimeout(() => setOpening(false), 900); return () => window.clearTimeout(t); }, []);

  if (opening) return <SafeDial />;
  if (!w) return error ? <p className="field-err" role="alert">{error}</p> : <p className="muted" aria-busy="true">Opening the safe…</p>;
  const done = (x: WalletState) => { setW(x); refreshGame(); };
  return (
    <div className="money">
      <WalletPager w={w} loadError={error} onChange={done} onRefresh={() => void load().then(refreshGame)} />
      <IpoCard wallet={w} />
      <p className="fine">Vibe City keeps the wallet's agent key on its server and gives it only to the floors that trade (Trading Desk, Prediction Desk, Treasury Ops). Spending limits are yours to set in OutLayer; Vibe City cannot read them back.</p>
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

/** SAFE-2, the wallet pager: a reflective LCD and four keys. The keys change with the mode: viewing the balances,
    funding the wallet, or pasting an agent key. */
function WalletPager({ w, loadError, onChange, onRefresh }: { w: WalletState; loadError: string | null; onChange: (w: WalletState) => void; onRefresh: () => void }) {
  const [mode, setMode] = useState<'view' | 'fund' | 'key'>(w.registered ? 'view' : 'key');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [token, setToken] = useState<'usdc' | 'near'>('usdc');
  const total = w.balances.reduce((t, x) => t + (x.usd ?? 0), 0);
  const connect = async () => {
    if (!key.trim()) return;
    setBusy(true); setErr(null);
    try { const x = await api.walletKey(key.trim()); setKey(''); onChange(x); setMode('view'); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const fundOk = Number(amount) > 0 && !!w.accountId;
  const fundUrl = w.accountId ? `${OUTLAYER_APP}/fund?${new URLSearchParams({ to: w.accountId, amount, ...(token === 'usdc' ? { token: USDC, dest: 'intents' } : { token: 'near' }), msg: 'Fund the Vibe City company wallet' })}` : '';
  const short = (a: string) => (a.length > 26 ? `${a.slice(0, 12)}…${a.slice(-10)}` : a);
  const problem = err ?? w.error ?? loadError;

  return (
    <Device model="SAFE-2" name="wallet pager" shell="graphite" led={w.registered ? 'green' : 'amber'} className="safe-dev">
      <div className="safe-body">
        <Screen kind="lcd" className="safe-lcd" label="Wallet display">
          <div className="scr-row"><span>OutLayer custody</span><span>{w.registered ? '● Linked' : '○ No wallet'}</span></div>
          {mode === 'view' && w.registered && (
            <>
              <div className="scr-mono safe-acct" title={w.accountId ?? ''}>{w.accountId ? short(w.accountId) : '…'}</div>
              <div className="scr-row safe-lbl"><span>Portfolio · every token held</span>{w.binding.status === 'active' && <span>Acting as {w.binding.accountId}</span>}</div>
              <div><Digits value={usd(total)} /></div>
              {w.balances.length === 0 && !w.error && <p className="scr-mono safe-hint">Nothing here yet. Press Fund.</p>}
              {/* every non-zero holding, largest USD value first (the backend sorts and drops zeros) */}
              <ul className="safe-holdings">
                {w.balances.map((x) => (
                  <li key={`${x.source}-${x.chain}-${x.token}`} className="scr-row">
                    <span>{x.logo ? <img className="coin" src={x.logo} alt="" loading="lazy" /> : <i className="coin" aria-hidden="true">{x.token.slice(0, 1)}</i>}{x.token} · {x.source === 'bound' ? `${w.binding.accountId} (bound)` : x.source === 'intents' ? `Intents${x.chain ? ` · ${x.chain}` : ''}` : 'wallet (gas)'}</span>
                    <span>{human(x.amount, x.decimals)}{x.usd !== null && <small> · {usd(x.usd)}</small>}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {mode === 'fund' && (
            <form onSubmit={(e) => { e.preventDefault(); if (fundOk) window.open(fundUrl, '_blank', 'noreferrer'); }}>
              <div className="scr-row safe-lbl"><span>Fund · {token === 'usdc' ? 'USDC to Intents' : 'NEAR for gas'}</span></div>
              <input className="scr-input lcd-seg" inputMode="decimal" autoFocus placeholder="0.00" aria-label="Amount to fund" value={amount} onChange={(e) => setAmount(e.target.value.trim())} />
              <p className="scr-mono safe-hint">{token === 'usdc' ? 'Lands on the Intents balance that swaps and the trading floors spend from.' : 'Lands on the wallet account and pays for transactions.'} OutLayer's page opens; you pay from your own wallet.</p>
            </form>
          )}
          {mode === 'key' && (
            <form onSubmit={(e) => { e.preventDefault(); void connect(); }}>
              <div className="scr-row safe-lbl"><span>{w.registered ? 'Replace the agent key' : 'Link the company wallet'}</span></div>
              <ol className="scr-mono safe-steps">
                <li><a href={NEW_WALLET_URL} target="_blank" rel="noreferrer">Create a wallet on OutLayer</a> and set its spending policy there.</li>
                <li>Copy its agent key (<b>wk_…</b>, shown once) and paste it below.</li>
              </ol>
              <input className="scr-input scr-mono" type="password" autoComplete="off" spellCheck={false} placeholder="wk_…" aria-label="OutLayer agent API key" value={key} onChange={(e) => setKey(e.target.value)} />
            </form>
          )}
          {problem && <p className="scr-mono safe-err" role="alert">! {problem}</p>}
          <div className="scr-row safe-foot"><span>Keys stay in OutLayer's TEE</span><span>Policy: set in OutLayer</span></div>
        </Screen>
        <div className="safe-keys" role="group" aria-label="Safe keys">
          {mode === 'view' && <>
            <Key hot onClick={() => setMode('fund')} disabled={!w.registered}>Fund</Key>
            <Key href={OUTLAYER_APP} title="Set the spending policy on OutLayer">Policy</Key>
            <Key onClick={() => { setErr(null); setMode('key'); }}>New key</Key>
            <Key onClick={onRefresh}>Refresh</Key>
          </>}
          {mode === 'fund' && <>
            <Key hot disabled={!fundOk} href={fundOk ? fundUrl : undefined}>Open ▸</Key>
            <Key lit={token === 'usdc'} pressed={token === 'usdc'} onClick={() => setToken('usdc')}>USDC</Key>
            <Key lit={token === 'near'} pressed={token === 'near'} onClick={() => setToken('near')}>NEAR</Key>
            <Key onClick={() => setMode('view')}>Back</Key>
          </>}
          {mode === 'key' && <>
            <Key hot disabled={busy || !key.trim()} onClick={() => void connect()}>{busy ? 'Checking' : 'Connect'}</Key>
            <Key href={NEW_WALLET_URL} title="Create a wallet on OutLayer">New wallet</Key>
            {w.registered && <Key onClick={() => setMode('view')}>Back</Key>}
          </>}
          <Grille className="safe-grille" />
        </div>
      </div>
    </Device>
  );
}
