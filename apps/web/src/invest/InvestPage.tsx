/* The public buy page (/invest): anyone connects a NEAR wallet and calls `buy` on the company's city token, which
   sends tokens at the fixed offering price and forwards the NEAR to the company's DAO. */
import { useEffect, useState } from 'react';
import { NearConnector } from '@hot-labs/near-connect';
import type { IpoState } from '@vibe-city/shared';
import { api, ApiError } from '../api';
import { SaleBar } from '../town/ui/IpoCard';
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

  if (!ipo) return <main className="invest">{err ? <p className="field-err" role="alert">{err}</p> : <p className="muted">Loading…</p>}</main>;
  if (!token) return <main className="invest"><h1>{name || 'Vibe City'}</h1><p>This company has not gone public yet.</p></main>;

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

  return (
    <main className="invest">
      <h1>{name || 'Vibe City company'} · {ipo.symbol}</h1>
      <dl className="kv">
        <div><dt>Token</dt><dd><a href={`${NB}/address/${token}`} target="_blank" rel="noreferrer">{token}</a></dd></div>
        <div><dt>Price</dt><dd>{offer ? `${offer.priceNear} NEAR per ${ipo.symbol}` : 'unavailable'}</dd></div>
        {sale && <>
          <div><dt>Offering</dt><dd>{sale.open ? 'Open' : 'Closed'}</dd></div>
          <div><dt>Sold</dt><dd>{sale.sold.toLocaleString()} / {float.toLocaleString()} ({sale.remaining.toLocaleString()} left)<SaleBar sold={sale.sold} float={float} /></dd></div>
          <div><dt>Raised</dt><dd>{sale.raisedNear.toLocaleString()} NEAR · {sale.buyers} buyer{sale.buyers === 1 ? '' : 's'}</dd></div>
        </>}
      </dl>

      {account ? (
        <div className="row">
          <span className="mono grow">{account} · {balance === null ? '?' : balance.toLocaleString()} {ipo.symbol}</span>
          <button className="btn small" onClick={() => void near().disconnect()}>Disconnect</button>
        </div>
      ) : <button className="btn primary" onClick={() => void near().connect().catch((e) => setErr(errText(e)))}>Connect wallet</button>}

      <form onSubmit={(e) => { e.preventDefault(); if (canBuy) void buy(); }}>
        <label className="field"><span className="lbl">NEAR to invest</span>
          <div className="row">
            <input className="input" inputMode="decimal" placeholder="1.0" value={amount} disabled={!sale?.open} onChange={(e) => setAmount(e.target.value.trim())} />
            <button className="btn primary" type="submit" disabled={!canBuy}>{busy ? 'Buying…' : 'Buy'}</button>
          </div>
        </label>
        {deposit && offer && <p className="fine">≈ {estimate.toLocaleString(undefined, { maximumFractionDigits: 6 })} {ipo.symbol}{!balance && ' (after the ~0.0033 NEAR first-buy storage fee)'}</p>}
        {sale && !sale.open && <p className="fine">The offering is closed.</p>}
      </form>

      {tx && <p role="status">{tx.ok ? 'Bought.' : 'The transaction failed.'} {tx.hash && <a href={`${NB}/txns/${tx.hash}`} target="_blank" rel="noreferrer">View transaction</a>}</p>}
      {err && <p className="field-err" role="alert">{err}</p>}
      <p className="fine">You pay NEAR to the company's DAO and receive city tokens. Revenue share is decided by the DAO; nothing is promised.</p>
    </main>
  );
}
