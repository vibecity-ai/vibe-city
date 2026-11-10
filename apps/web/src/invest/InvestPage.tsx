/* The public subscription page (/invest), drawn as a stock certificate: anyone connects a NEAR wallet and calls `buy`
   on the company's city token, which sends shares at the fixed offering price and forwards the NEAR to the company's
   DAO. The wax seal is the subscribe button. */
import { useEffect, useState, type ReactNode } from 'react';
import { NearConnector } from '@hot-labs/near-connect';
import type { IpoState } from '@vibe-city/shared';
import { api, ApiError } from '../api';
import { fmtNear } from '../town/ui/IpoCard';
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

  const paper = (body: ReactNode) => (
    <main className="invest">
      <article className="cert" aria-label={`${name || 'Vibe City company'} share certificate`}>
        <div className="cert-inner">
          <header className="cert-head">
            <span className="cert-no">{ipo?.symbol ?? ''}</span>
            <span className="cert-kicker">Vibe City · Certificate of shares</span>
            <span className="cert-no">{ipo?.offer ? `${ipo.offer.supply.toLocaleString()} shares` : ''}</span>
          </header>
          <h1 className="cert-name">{name || 'A Vibe City company'}</h1>
          {body}
        </div>
      </article>
    </main>
  );
  if (!ipo) return paper(err ? <p className="cert-err" role="alert">{err}</p> : <p className="cert-text">Loading…</p>);
  if (!token) return paper(<p className="cert-text">This company has not gone public yet. Its shares will be offered here when it rings the opening bell.</p>);

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
  const holder = account ?? '______________________';
  return paper(<>
    <p className="cert-sub">City shares · <b>{ipo.symbol}</b> · offered at <b>{offer ? fmtNear(offer.priceNear) : '—'} NEAR</b> a share{offer && <> (≈ ${(offer.priceNear * offer.nearUsd).toFixed(4)})</>}</p>
    <p className="cert-text">
      This certifies that <span className="cert-fill">{holder}</span> is the registered holder of{' '}
      <span className="cert-fill">{account ? (balance === null ? '…' : balance.toLocaleString(undefined, { maximumFractionDigits: 6 })) : '____'}</span> fully paid shares of{' '}
      {name || 'the company'}, transferable on the NEAR blockchain at <a href={`${NB}/address/${token}`} target="_blank" rel="noreferrer">{token}</a>.
    </p>
    {sale && (
      <div className="cert-offering">
        <span><b>{sale.sold.toLocaleString(undefined, { maximumFractionDigits: 2 })}</b> of {float.toLocaleString()} offered shares subscribed</span>
        <span className="cert-meter" role="progressbar" aria-label="Offered shares subscribed" aria-valuenow={Math.round(float ? (sale.sold / float) * 100 : 0)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${Math.max(float ? (sale.sold / float) * 100 : 0, sale.sold > 0 ? 1 : 0)}%` }} /></span>
        <span>{fmtNear(sale.raisedNear)} NEAR raised by the company · {sale.buyers} holder{sale.buyers === 1 ? '' : 's'}</span>
      </div>
    )}

    {sale?.open ? (
      <form className="cert-sub-form" onSubmit={(e) => { e.preventDefault(); if (canBuy) void buy(); }}>
        <label>
          <span>Subscribe with</span>
          <input inputMode="decimal" placeholder="0.00" aria-label="NEAR to invest" value={amount} disabled={!account} onChange={(e) => setAmount(e.target.value.trim())} />
          <span>NEAR {deposit && offer ? <>for <b>≈ {estimate.toLocaleString(undefined, { maximumFractionDigits: 3 })}</b> shares</> : ''}</span>
        </label>
        {deposit && !balance && <small>A first subscription keeps about 0.0033 NEAR to open your share account.</small>}
        <div className="cert-seal-row">
          {account
            ? <button className="seal" type="submit" disabled={!canBuy} aria-label="Subscribe"><span>{busy ? 'Signing' : 'Subscribe'}</span></button>
            : <button className="seal" type="button" onClick={connect} aria-label="Connect a NEAR wallet"><span>Connect wallet</span></button>}
          {account && <button className="cert-link" type="button" onClick={() => void near().disconnect()}>Not {short(account)}? Disconnect</button>}
        </div>
      </form>
    ) : sale && <p className="cert-text"><b>The offering is closed.</b> The company's books are shut; shares now move only between holders.</p>}

    {tx && <p className="cert-text" role="status">{tx.ok ? 'Subscribed. Your shares are on the register.' : 'The transaction failed.'} {tx.hash && <a href={`${NB}/txns/${tx.hash}`} target="_blank" rel="noreferrer">View the transaction</a>}</p>}
    {err && <p className="cert-err" role="alert">{err}</p>}

    <footer className="cert-foot">
      <span className="cert-sign"><i>{ipo.ceoAccountId ?? ''}</i>Chair of the board</span>
      <span className="cert-sign"><i>tokens.vibecity.near</i>Registrar</span>
    </footer>
    <p className="cert-fine">Your NEAR goes to the company's DAO ({ipo.daoAccountId}). Dividends are decided by DAO vote; nothing is promised.</p>
  </>);
}

const short = (a: string) => (a.length > 24 ? `${a.slice(0, 10)}…${a.slice(-8)}` : a);
