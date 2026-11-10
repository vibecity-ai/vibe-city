/* The public buy page (/invest): anyone connects a NEAR wallet and calls `buy` on the company's city token, which
   sends tokens at the fixed offering price and forwards the NEAR to the company's DAO. */
import { useEffect, useState, type ReactNode } from 'react';
import { NearConnector } from '@hot-labs/near-connect';
import type { IpoState } from '@vibe-city/shared';
import { api, ApiError } from '../api';
import { fmtNear } from '../town/ui/IpoCard';
import { Device, Digits, Grille, Key, LcdBar, Screen } from '../town/ui/Device';
import { estimateTokens, nearToYocto } from './buy';
import '../town/fonts.css';
import '../town/styles.css';

const RPC = 'https://rpc.mainnet.fastnear.com';
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
    const c = near();
    c.getConnectedWallet().then(({ accounts }) => setAccount(accounts[0]?.accountId ?? null), () => {});
    c.on('wallet:signIn', (t) => setAccount(t.accounts[0]?.accountId ?? null));
    c.on('wallet:signOut', () => { setAccount(null); setBalance(null); });
  }, []);
  useEffect(() => {
    if (!token || !account) return;
    balanceOf(token, account).then(setBalance, () => setBalance(null));
  }, [token, account, tx]);

  const shell = (body: ReactNode, keys: ReactNode, led: 'green' | 'amber' | 'off' = 'off') => (
    <main className="invest">
      <Device model="IPO-1" name={`${name || 'Vibe City company'} · share terminal`} shell="graphite" led={led} className="safe-dev invest-dev">
        <div className="safe-body">
          <Screen kind="lcd" className="safe-lcd" label="Share terminal display">{body}</Screen>
          <div className="safe-keys" role="group" aria-label="Terminal keys">{keys}<Grille className="safe-grille" /></div>
        </div>
      </Device>
    </main>
  );
  if (!ipo) return shell(err ? <p className="scr-mono safe-err" role="alert">! {err}</p> : <p className="scr-mono">Loading…</p>, null);
  if (!token) return shell(<><div className="scr-row"><span>{name || 'Vibe City'}</span><span>○ Private</span></div><p className="scr-mono safe-hint">This company has not gone public yet.</p></>, null);

  const sale = ipo.sale, offer = ipo.offer;
  const float = sale ? sale.sold + sale.remaining : 0;
  const deposit = nearToYocto(amount);
  const estimate = deposit && offer && sale ? estimateTokens(deposit, offer.priceYocto, !balance, sale.remaining) : 0;
  const canBuy = !!account && !!deposit && !!sale?.open && estimate > 0 && !busy;

  const buy = async () => {
    if (!deposit) return;
    setBusy(true); setErr(null); setTx(null);
    try {
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

  const connect = () => void near().connect().catch((e) => setErr(errText(e)));
  return shell(<>
    <div className="scr-row"><span>{ipo.symbol} · city shares</span><span>{sale ? (sale.open ? '● Offering open' : '○ Offering closed') : '…'}</span></div>
    <div className="scr-mono safe-acct"><a href={`${NB}/address/${token}`} target="_blank" rel="noreferrer">{token}</a></div>
    <div className="scr-row safe-lbl"><span>Price per share</span><span>{offer && `≈ $${(offer.priceNear * offer.nearUsd).toFixed(4)}`}</span></div>
    <div><Digits value={offer ? fmtNear(offer.priceNear) : '-'} /> <span className="scr-mono">NEAR</span></div>
    {sale && <>
      <div className="scr-row safe-lbl"><span>Sold</span><span>{sale.sold.toLocaleString(undefined, { maximumFractionDigits: 2 })} / {float.toLocaleString()}</span></div>
      <LcdBar value={sale.sold} max={float} label="Shares sold" />
      <div className="scr-row safe-lbl"><span>Raised by the company</span><span>{fmtNear(sale.raisedNear)} NEAR · {sale.buyers} holder{sale.buyers === 1 ? '' : 's'}</span></div>
    </>}
    <div className="scr-rule" />
    <div className="scr-row"><span>Your wallet</span><span>{account ? `${balance === null ? '?' : balance.toLocaleString()} ${ipo.symbol}` : '○ Not connected'}</span></div>
    {account && <div className="scr-mono safe-acct">{account}</div>}
    {sale?.open ? (
      <form onSubmit={(e) => { e.preventDefault(); if (canBuy) void buy(); }}>
        <div className="scr-row safe-lbl"><span>Invest · NEAR</span><span>{deposit && offer ? `≈ ${estimate.toLocaleString(undefined, { maximumFractionDigits: 3 })} ${ipo.symbol}` : ''}</span></div>
        <input className="scr-input lcd-seg md" inputMode="decimal" placeholder="0.00" aria-label="NEAR to invest" value={amount} onChange={(e) => setAmount(e.target.value.trim())} />
        {deposit && !balance && <p className="scr-mono safe-hint">A first purchase keeps ~0.0033 NEAR for your share account.</p>}
      </form>
    ) : sale && <p className="scr-mono safe-hint">The offering is closed.</p>}
    {tx && <p className="scr-mono" role="status">{tx.ok ? '✓ Bought.' : '! The transaction failed.'} {tx.hash && <a href={`${NB}/txns/${tx.hash}`} target="_blank" rel="noreferrer">View ▸</a>}</p>}
    {err && <p className="scr-mono safe-err" role="alert">! {err}</p>}
    <div className="scr-row safe-foot"><span>Your NEAR goes to the company's DAO</span><span>Payouts by DAO vote · nothing promised</span></div>
  </>, <>
    {account
      ? <Key hot type="button" disabled={!canBuy} onClick={() => void buy()}>{busy ? 'Buying' : 'Buy'}</Key>
      : <Key hot onClick={connect}>Connect</Key>}
    {account && <Key onClick={() => void near().disconnect()}>Disconnect</Key>}
    <Key href={`${NB}/address/${token}`} title="The token on NearBlocks">Token</Key>
  </>, sale?.open ? 'green' : 'off');
}
