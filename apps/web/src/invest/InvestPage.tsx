/* The public subscription page (/invest), the Vibe City Exchange: the city at night behind one glass card. Anyone
   connects a NEAR wallet and calls `buy` on the company's city token, which sends shares at the fixed offering price
   and forwards the NEAR to the company's DAO. */
import { useEffect, useState, type ReactNode } from 'react';
import { NearConnector } from '@hot-labs/near-connect';
import type { IpoState } from '@vibe-city/shared';
import { api, ApiError, DEMO } from '../api';
import { fmtNear } from '../town/ui/IpoCard';
import { estimateTokens, nearToYocto } from './buy';
import { Wordmark } from '../town/ui/Wordmark';
import '../town/fonts.css';
import '../town/styles.css';

/** In the demo build, a fake wallet that reads and buys on the demo server's fake chain. */
const DEMO_ACCOUNT = 'demo-investor.near';
const RPC = DEMO ? '/demo/rpc' : 'https://rpc.mainnet.fastnear.com';
const BUY_GAS = '50000000000000';
const NB = 'https://nearblocks.io';
const errText = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : 'Something went wrong.');

let connector: NearConnector | null = null;
const near = () => (connector ??= new NearConnector({ network: 'mainnet' }));

/** NEP-141 balance in whole tokens (6 decimals), read from a public RPC. */
async function balanceOf(token: string, accountId: string): Promise<number> {
  const res = await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: {
      request_type: 'call_function', finality: 'final', account_id: token, method_name: 'ft_balance_of',
      args_base64: btoa(JSON.stringify({ account_id: accountId })),
    } }),
  });
  const j = await res.json() as { result?: { result: number[] }; error?: { message?: string } };
  if (!j.result) throw new Error(j.error?.message ?? 'RPC error');
  return Number(JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result)))) / 1e6;
}

export function InvestPage() {
  const [ipo, setIpo] = useState<IpoState | null>(null);
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [tx, setTx] = useState<{ hash: string | null; ok: boolean } | null>(null);
  const token = ipo?.tokenAccountId ?? null;

  const load = async () => {
    try { setIpo(await api.ipo()); } catch (e) { setErr(errText(e)); }
  };
  useEffect(() => {
    void load();
    api.company().then((c) => setName(c.name), () => {});
    if (DEMO) return;
    const c = near();
    c.getConnectedWallet().then(({ accounts }) => setAccount(accounts[0]?.accountId ?? null), () => {});
    c.on('wallet:signIn', (t) => setAccount(t.accounts[0]?.accountId ?? null));
    c.on('wallet:signOut', () => { setAccount(null); setBalance(null); });
  }, []);
  useEffect(() => {
    if (!token || !account) return;
    balanceOf(token, account).then(setBalance, () => setBalance(null));
  }, [token, account, tx]);

  const paper = (body: ReactNode) => (
    <main className="vx">
      <Skyline />
      <header className="vx-top">
        <a className="vx-brand" href="/" aria-label="Vibe City"><Wordmark height={22} /></a>
        <span className="vx-ex">Exchange</span>
        {ipo?.symbol && <span className="vx-sym">{ipo.symbol}</span>}
      </header>
      <article className="vx-card" aria-label={`${name || 'Vibe City company'} shares`}>
        <span className="vx-kicker">City shares{ipo?.offer ? ` · ${ipo.offer.supply.toLocaleString()} shares` : ''}</span>
        <h1 className="vx-name">{name || 'A Vibe City company'}</h1>
        {body}
      </article>
    </main>
  );
  if (!ipo) return paper(err ? <p className="vx-err" role="alert">{err}</p> : <p className="vx-text">Loading…</p>);
  if (!token) return paper(<p className="vx-text">This company has not gone public yet. Its shares will be offered here when it rings the opening bell.</p>);

  const sale = ipo.sale, offer = ipo.offer;
  const float = sale ? sale.sold + sale.remaining : 0;
  const deposit = nearToYocto(amount);
  const estimate = deposit && offer && sale ? estimateTokens(deposit, offer.priceYocto, !balance, sale.remaining) : 0;
  const canBuy = !!account && !!deposit && !!sale?.open && estimate > 0 && !busy;

  const buy = async () => {
    if (!deposit) return;
    setBusy(true); setErr(null); setTx(null);
    try {
      if (DEMO) {
        const r = await fetch('/demo/buy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, accountId: account, deposit }) });
        if (!r.ok) throw new Error(((await r.json()) as { message: string }).message);
        setTx({ hash: null, ok: true }); setAmount('');
        return;
      }
      const wallet = await near().wallet();
      const out = await wallet.signAndSendTransaction({
        receiverId: token,
        actions: [{ type: 'FunctionCall', params: { methodName: 'buy', args: {}, gas: BUY_GAS, deposit } }],
      }) as { transaction?: { hash?: string }; status?: { Failure?: unknown } } | undefined;
      setTx({ hash: out?.transaction?.hash ?? null, ok: !out?.status?.Failure });
      setAmount('');
    } catch (e) { setErr(errText(e)); }
    finally { setBusy(false); void load(); }
  };

  const connect = () => (DEMO ? setAccount(DEMO_ACCOUNT) : void near().connect().catch((e) => setErr(errText(e))));
  const disconnect = () => (DEMO ? (setAccount(null), setBalance(null)) : void near().disconnect());
  const pct = sale && float ? (sale.sold / float) * 100 : 0;
  return paper(<>
    <dl className="vx-stats">
      <div><dt>Offer price</dt><dd>{offer ? fmtNear(offer.priceNear) : '—'}<small>NEAR</small></dd>{offer && <span>≈ ${(offer.priceNear * offer.nearUsd).toFixed(4)} a share</span>}</div>
      <div><dt>Raised</dt><dd>{sale ? fmtNear(sale.raisedNear) : '0'}<small>NEAR</small></dd><span>{sale ? `${sale.buyers} holder${sale.buyers === 1 ? '' : 's'}` : 'Not open yet'}</span></div>
    </dl>
    {sale && (
      <div className="vx-offering">
        <div className="vx-offering-h"><span>Offered shares subscribed</span><b>{sale.sold.toLocaleString(undefined, { maximumFractionDigits: 2 })} <small>/ {float.toLocaleString()}</small></b></div>
        <span className="vx-meter" role="progressbar" aria-label="Offered shares subscribed" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${Math.max(pct, sale.sold > 0 ? 1 : 0)}%` }} /></span>
      </div>
    )}

    {sale?.open ? (
      <form className="vx-buy" onSubmit={(e) => { e.preventDefault(); if (canBuy) void buy(); }}>
        <label className="vx-amount">
          <span className="vx-lbl">You pay</span>
          <span className="vx-field"><input inputMode="decimal" placeholder="0.00" aria-label="NEAR to invest" value={amount} disabled={!account} onChange={(e) => setAmount(e.target.value.trim())} /><b>NEAR</b></span>
          <span className="vx-est">{deposit && offer ? <>You get <b>≈ {estimate.toLocaleString(undefined, { maximumFractionDigits: 3 })}</b> {ipo.symbol}</> : account ? 'Enter an amount' : 'Connect a wallet to subscribe'}</span>
        </label>
        {deposit && !balance && <small className="vx-note">A first subscription keeps about 0.0033 NEAR to open your share account.</small>}
        {account
          ? <button className="btn primary lg block" type="submit" disabled={!canBuy}>{busy ? 'Signing…' : `Subscribe to ${ipo.symbol}`}</button>
          : <button className="btn primary lg block" type="button" onClick={connect}>{DEMO ? 'Connect demo wallet' : 'Connect a NEAR wallet'}</button>}
        {account && <p className="vx-acct"><span>{short(account)} holds <b>{balance === null ? '…' : balance.toLocaleString(undefined, { maximumFractionDigits: 6 })}</b> {ipo.symbol}</span><button className="vx-link" type="button" onClick={disconnect}>Disconnect</button></p>}
      </form>
    ) : sale && <p className="vx-text"><b>The offering is closed.</b> Shares now move only between holders.</p>}

    {tx && <p className={`vx-tx${tx.ok ? '' : ' bad'}`} role="status">{tx.ok ? 'Subscribed. Your shares are on the register.' : 'The transaction failed.'} {tx.hash && <a href={`${NB}/txns/${tx.hash}`} target="_blank" rel="noreferrer">View the transaction</a>}</p>}
    {err && <p className="vx-err" role="alert">{err}</p>}

    <dl className="vx-reg">
      <div><dt>Token</dt><dd><a href={`${NB}/address/${token}`} target="_blank" rel="noreferrer">{token}</a></dd></div>
      <div><dt>Company DAO</dt><dd><a href={`${NB}/address/${ipo.daoAccountId}`} target="_blank" rel="noreferrer">{ipo.daoAccountId}</a></dd></div>
      {ipo.ceoAccountId && <div><dt>Chair</dt><dd>{ipo.ceoAccountId}</dd></div>}
    </dl>
    <p className="vx-fine">Your NEAR goes straight to the company's DAO. Dividends are decided by DAO vote; nothing is promised.</p>
  </>);
}

/** The city at night behind the card: a sliced sun and two rows of towers with lit windows, drawn once from a seed. */
function Skyline() {
  const rows = [0, 1].map((r) => {
    let seed = 7 + r * 31; const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
    const out: { x: number; w: number; h: number; lit: [number, number][] }[] = [];
    for (let x = -4; x < 480;) {
      const w = 14 + Math.floor(rnd() * 22), h = (r ? 40 : 70) + Math.floor(rnd() * (r ? 60 : 110));
      const lit: [number, number][] = [];
      for (let wy = 6; wy < h - 4; wy += 6) for (let wx = 3; wx < w - 3; wx += 5) if (rnd() < (r ? .32 : .18)) lit.push([wx, wy]);
      out.push({ x, w, h, lit }); x += w + (rnd() < .3 ? 3 : 1);
    }
    return out;
  });
  return (
    <div className="vx-sky" aria-hidden="true">
      <i className="vx-sun" />
      <svg viewBox="0 0 480 240" preserveAspectRatio="xMidYMax slice" shapeRendering="crispEdges">
        {rows.map((row, r) => <g key={r} fill={r ? '#120A1D' : '#1E1230'}>{row.map((b, i) => <g key={i}>
          <rect x={b.x} y={240 - b.h} width={b.w} height={b.h} />
          {b.lit.map(([wx, wy], k) => <rect key={k} x={b.x + wx} y={240 - b.h + wy} width="2" height="2" fill={k % 7 === 0 ? '#2EE6F0' : k % 5 === 0 ? '#FF3EA5' : '#FFC75A'} opacity={r ? .85 : .45} />)}
        </g>)}</g>)}
      </svg>
    </div>
  );
}

const short = (a: string) => (a.length > 24 ? `${a.slice(0, 10)}…${a.slice(-8)}` : a);
