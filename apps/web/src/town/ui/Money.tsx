/* The safe: the company's OutLayer custody wallet (docs/briefs/03-outlayer-wallet.md). Its keys live in OutLayer's TEE;
   Vibe City keeps only the wallet's agent key, server-side, for the floors that trade. The CEO creates the wallet at
   app.outlayer.ai/wallet/new and pastes its agent key. Spending limits are set in OutLayer, never here.
   Binding to the CEO's NEAR account (POST /api/wallet/bind) is not offered: on mainnet OutLayer cannot build that
   transaction yet (its wallet contract is not published there, checked 2026-11-08). */
import { useEffect, useState } from 'react';
import type { WalletState } from '@vibe-city/shared';
import { useStore } from '../store';
import { api, ApiError } from '../../api';
import { Icon } from './kit';

const NEW_WALLET_URL = 'https://app.outlayer.ai/wallet/new';
/** Native USDC on NEAR (what the trading connectors settle in, through Intents). */
const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const OUTLAYER_APP = 'https://app.outlayer.ai/wallet';
const errText = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Something went wrong.');
/** A raw token amount in human units, up to 4 decimals (NEAR has 24 decimals, USDC 6). */
const DECIMALS: Record<string, number> = { near: 24, usdc: 6 };
const human = (raw: string, token: string) => { const d = DECIMALS[token] ?? 0; return (d >= 4 ? Number(BigInt(raw) / 10n ** BigInt(d - 4)) / 1e4 : Number(raw)).toLocaleString(undefined, { maximumFractionDigits: 4 }); };
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
      <div className="money-bar">
        <span className="muted small">OutLayer company wallet · keys stay in OutLayer's TEE</span>
        <button className="btn small" onClick={() => void load()}><Icon n="refresh" size={12} />Refresh</button>
      </div>
      {error && <p className="field-err" role="alert">{error}</p>}
      {w.registered
        ? <WalletCard w={w} onReplaced={done} />
        : <PasteKey onDone={done} />}
      <p className="fine">Vibe City keeps the wallet's agent key on its server and gives it only to the floors that trade (Trading Desk, Prediction Desk, Token &amp; Treasury). Spending limits are yours to set in OutLayer; Vibe City cannot read them back.</p>
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

/** inline: just the steps and the field, for the connected wallet's "use a different wallet". */
function PasteKey({ onDone, inline = false }: { onDone: (w: WalletState) => void; inline?: boolean }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setErr(null);
    try { onDone(await api.walletKey(key.trim())); setKey(''); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const body = (
    <>
      <ol className="fine steps">
        <li><a href={NEW_WALLET_URL} target="_blank" rel="noreferrer">Create a wallet on OutLayer</a> and set its spending policy there.</li>
        <li>Copy its agent API key (<code>wk_…</code>, shown once) and paste it here.</li>
      </ol>
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (key.trim()) void save(); }}>
        <input className="input mono" type="password" autoComplete="off" spellCheck={false} placeholder="wk_…" aria-label="OutLayer agent API key" value={key} onChange={(e) => setKey(e.target.value)} />
        <button className="btn primary small" type="submit" disabled={busy || !key.trim()}>Connect</button>
      </form>
      {err && <p className="field-err" role="alert">{err}</p>}
    </>
  );
  return inline ? body : <section className="pot"><h3 className="pot-h"><Icon n="shield" size={14} />Paste an agent key</h3>{body}</section>;
}

function WalletCard({ w, onReplaced }: { w: WalletState; onReplaced: (w: WalletState) => void }) {
  const b = w.binding;
  return (
    <section className="pot">
      <h3 className="pot-h"><Icon n="shield" size={14} />Company wallet</h3>
      <div className="wallet"><span className="muted small">Wallet account</span><b className="mono">{w.accountId ?? '…'}</b></div>
      {b.status === 'active' && <p className="fine">Acting as <b className="mono">{b.accountId}</b>, under that account's policy.</p>}
      {w.error && <p className="field-err" role="alert">{w.error}</p>}
      <ul className="pot-list">
        {w.balances.map((x) => (
          <li key={`${x.source}-${x.token}`} className="wallet">
            <span className="muted small">{x.source === 'bound' ? `${b.accountId} (bound)` : x.source === 'intents' ? 'Intents balance (trading)' : 'Wallet account (gas)'}</span>
            <div className="amt">{human(x.amount, x.token)} <small>{x.token.toUpperCase()}</small></div>
          </li>
        ))}
      </ul>
      {w.accountId && <Fund to={w.accountId} />}
      <div className="row"><a className="btn small" href={OUTLAYER_APP} target="_blank" rel="noreferrer">Spending policy</a></div>
      <details className="fine">
        <summary>Use a different wallet (paste its agent key)</summary>
        <PasteKey onDone={onReplaced} inline />
      </details>
    </section>
  );
}

/** OutLayer's fund page needs `to` and a human `amount`. NEAR lands on the wallet account (gas); USDC goes straight to
   its Intents balance (dest=intents, FT only), which swaps and the trading connectors spend from. */
function Fund({ to }: { to: string }) {
  const [amount, setAmount] = useState('');
  const [token, setToken] = useState<'near' | 'usdc'>('usdc');
  const ok = Number(amount) > 0;
  const url = `${OUTLAYER_APP}/fund?${new URLSearchParams({ to, amount, ...(token === 'usdc' ? { token: USDC, dest: 'intents' } : { token: 'near' }), msg: 'Fund the Vibe City company wallet' })}`;
  return (
    <form className="row" onSubmit={(e) => { e.preventDefault(); if (ok) window.open(url, '_blank', 'noreferrer'); }}>
      <input className="input mono" inputMode="decimal" placeholder="Amount" aria-label="Amount to fund" value={amount} onChange={(e) => setAmount(e.target.value.trim())} />
      <select className="input" aria-label="Token" value={token} onChange={(e) => setToken(e.target.value as 'near' | 'usdc')}>
        <option value="usdc">USDC (trading, to Intents)</option>
        <option value="near">NEAR (gas)</option>
      </select>
      <button className="btn small" type="submit" disabled={!ok}>Fund</button>
    </form>
  );
}
