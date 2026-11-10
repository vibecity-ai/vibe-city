/* The company's OutLayer custody wallet (docs/briefs/03-outlayer-wallet.md, reduced to the two ways in).
   Its keys live in OutLayer's TEE; Vibe City holds only the wallet's agent API key (wk_), server-side, and gives it to
   the floors whose template says wallet: 'company'. Two ways to get one:
     - paste: the CEO creates the wallet at app.outlayer.ai/wallet/new and pastes its key (checked against OutLayer first);
     - bind:  we register a wallet, record a binding to the CEO's NEAR account, and the CEO signs once on OutLayer's
              connect page. The wallet then acts as that account under that account's policy.
   Spending policy is set by the owner in OutLayer; nothing here can read it back. */
import type { DatabaseSync } from 'node:sqlite';
import { WalletStateSchema, type ConnectorName, type WalletState } from '@vibe-city/shared';
import { readSettings, secret, setSecrets, writeSettings } from '../routes/company.ts';
import { ConflictError, InvalidInputError, UpstreamError } from './errors.ts';
import { scrub } from './scrub.ts';
import { DEFAULT_RPC, NearRpc } from '../near/rpc.ts';

export const OUTLAYER_API = process.env.OUTLAYER_API_URL || 'https://api.outlayer.ai';
export const OUTLAYER_APP = 'https://app.outlayer.ai';
/** Every token NEAR Intents trades (symbol, decimals, chain, USD price); public, no key. */
export const INTENTS_TOKENS_URL = 'https://1click.chaindefuser.com/v0/tokens';
type IntentsToken = { assetId: string; symbol: string; decimals: number; blockchain: string; price?: number; coingeckoId?: string };
/** Token logos by CoinGecko id; keyless (rate limited), so only held tokens are asked for, once each. */
export const COINGECKO_MARKETS_URL = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=';
const TOKENS_TTL_MS = 5 * 60_000;

export const EMPTY_WALLET: WalletState = { registered: false, accountId: null, handoffUrl: null, binding: { accountId: null, status: 'none' }, balances: [], shielded: false, error: null };

type Json = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

export type CallOutcome = { status: 'success'; txHash: string | null; result: unknown } | { status: 'pending'; requestId: string };
/** OutLayer's request statuses: success; pending_approval / approved / processing (not final); failed, rejected,
    needs_review (final: needs_review means funds may have moved, so nothing here retries it on its own). */
function outcome(r: Json, what: string): CallOutcome {
  // a call answers { tx_hash, result }; a request row nests it: { result: { tx_hash, result } }
  const status = str(r.status), row = r.result !== null && typeof r.result === 'object' ? (r.result as Json) : null;
  const result = r.result as Json | undefined;
  if (status === 'success') return { status, txHash: str(r.tx_hash) ?? str(row?.tx_hash), result: row && 'tx_hash' in row ? row.result : r.result };
  if ((status === 'pending_approval' || status === 'approved' || status === 'processing') && str(r.request_id)) return { status: 'pending', requestId: str(r.request_id)! };
  const why = str(r.error) ?? str(r.message) ?? str(result?.reason) ?? status ?? 'no status';
  throw new UpstreamError(scrub(`The wallet's call to ${what} did not succeed: ${why}${status === 'needs_review' ? ' (check it in OutLayer before trying again)' : ''}`, 300)!);
}

export class WalletService {
  private db: DatabaseSync;
  private fetch_: typeof fetch;
  private api: string;
  private tokens: { at: number; list: IntentsToken[] } | null = null;
  private logos = new Map<string, string | null>();

  /** Fills `logos` for ids not asked yet; a failure leaves them unknown (null) until the process restarts. */
  private async loadLogos(ids: string[]) {
    const ask = [...new Set(ids)].filter((id) => !this.logos.has(id));
    if (!ask.length) return;
    for (const id of ask) this.logos.set(id, null);
    const r = await this.fetch_(COINGECKO_MARKETS_URL + ask.map(encodeURIComponent).join(','), { signal: AbortSignal.timeout(10_000) }).catch(() => null);
    const rows = r?.ok ? ((await r.json().catch(() => [])) as { id?: string; image?: string }[]) : [];
    for (const x of Array.isArray(rows) ? rows : []) if (x.id && typeof x.image === 'string' && x.image.startsWith('https://')) this.logos.set(x.id, x.image);
  }
  constructor(db: DatabaseSync, fetch_: typeof fetch = fetch, api = OUTLAYER_API) { this.db = db; this.fetch_ = fetch_; this.api = api; }

  /** The wallet's Intents holdings, every token at once: one 1Click token list (cached), one intents.near view call. */
  private async intents(accountId: string): Promise<WalletState['balances']> {
    if (!this.tokens || Date.now() - this.tokens.at > TOKENS_TTL_MS) {
      const r = await this.fetch_(INTENTS_TOKENS_URL, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
      if (!r?.ok) throw new UpstreamError('The NEAR Intents token list is unreachable.');
      this.tokens = { at: Date.now(), list: (await r.json()) as IntentsToken[] };
    }
    const list = this.tokens.list;
    const amounts = await new NearRpc(DEFAULT_RPC.mainnet, { fetch: this.fetch_ })
      .view<string[]>('intents.near', 'mt_batch_balance_of', { account_id: accountId, token_ids: list.map((t) => t.assetId) });
    const held = list.flatMap((t, i) => (amounts[i] && amounts[i] !== '0' ? [{ t, amount: amounts[i] }] : []));
    await this.loadLogos([...held.flatMap(({ t }) => (t.coingeckoId ? [t.coingeckoId] : [])), 'near']);
    return held.map(({ t, amount }) => ({
      token: t.symbol, amount, decimals: t.decimals, source: 'intents' as const, chain: t.blockchain,
      usd: typeof t.price === 'number' ? (Number(amount) / 10 ** t.decimals) * t.price : null,
      logo: (t.coingeckoId && this.logos.get(t.coingeckoId)) || null,
    })).sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
  }

  private key() { return secret(this.db, 'outlayerApiKey'); }

  private async call(path: string, opts: { method?: string; body?: Json; key?: string | null; headers?: Record<string, string> } = {}): Promise<Json & { status?: number }> {
    const key = opts.key === undefined ? this.key() : opts.key;
    let r: Response;
    try {
      r = await this.fetch_(this.api + path, {
        method: opts.method ?? 'GET',
        headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(opts.body ? { 'content-type': 'application/json' } : {}), ...opts.headers },
        ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch { throw new UpstreamError('OutLayer is unreachable.'); }
    const j = (await r.json().catch(() => ({}))) as Json;
    if (r.ok) return j;
    const msg = scrub(str(j.message) ?? str(j.error) ?? `OutLayer answered ${r.status}`, 300)!;
    if ((r.status === 401 || r.status === 403) && key) throw new InvalidInputError(`OutLayer does not accept this wallet key: ${msg}`);
    if (r.status === 404) return { status: 404 };
    if (r.status === 409) throw new ConflictError(msg);
    if (r.status < 500) throw new InvalidInputError(msg);
    throw new UpstreamError(`OutLayer: ${msg}`);
  }

  private store(apiKey: string, walletId: string | null, accountId: string | null) {
    setSecrets(this.db, { outlayerApiKey: apiKey });
    writeSettings(this.db, { outlayerWalletId: walletId, outlayerAccountId: accountId });
  }

  /** Paste: a key from app.outlayer.ai/wallet/new, accepted only if OutLayer knows it. Replaces any earlier wallet. */
  async useKey(apiKey: string): Promise<void> {
    const a = await this.call('/wallet/v1/address?chain=near', { key: apiKey });
    if (a.status === 404 || !str(a.address)) throw new InvalidInputError('OutLayer did not return an address for this key.');
    this.store(apiKey, str(a.wallet_id), str(a.address));
  }

  /** Bind: registers a wallet first if there is none, records the binding, returns OutLayer's page where the CEO signs. */
  async bind(accountId: string): Promise<string> {
    let key = this.key();
    if (!key) {
      const r = await this.call('/register', { method: 'POST', key: null });
      key = str(r.api_key);
      if (!key) throw new UpstreamError('OutLayer did not return a wallet key.');
      this.store(key, str(r.wallet_id), str(r.near_account_id));
    }
    await this.call('/wallet/v1/binding', { method: 'PUT', body: { asset_account_id: accountId, kind: 'personal_account' } });
    // The transaction the CEO would sign: OutLayer refuses to build it when it cannot work (an account that already
    // runs a contract: 409; binding not available on this network: 400). Surface that here, not on a dead signing page.
    await this.call('/wallet/v1/binding/setup?kind=personal_account');
    // embeds the key: returned once to the CEO who asked, never stored in a view
    return `${OUTLAYER_APP}/wallet/connect?key=${encodeURIComponent(key)}`;
  }

  /** Read live from OutLayer, best effort: an OutLayer failure is reported in `error`, never thrown. */
  async state(): Promise<WalletState> {
    if (!this.key()) return EMPTY_WALLET;
    const s = readSettings(this.db);
    const base: WalletState = { ...EMPTY_WALLET, registered: true, accountId: s.outlayerAccountId };
    try {
      const [bal, b, intents] = await Promise.all([
        this.call('/wallet/v1/balance?chain=near'), this.call('/wallet/v1/binding'), s.outlayerAccountId ? this.intents(s.outlayerAccountId) : [],
      ]);
      const raw = str(b.binding_status) ?? str(b.status);
      const status = raw === 'active' ? 'active' : raw === 'pending' ? 'pending' : 'none';
      const balances: WalletState['balances'] = [];
      const nearPrice = this.tokens?.list.find((t) => t.assetId === 'nep141:wrap.near')?.price;
      const nearUsd = (raw: string) => (typeof nearPrice === 'number' ? (Number(raw) / 1e24) * nearPrice : null);
      if (status === 'active') {
        const bound = await this.call('/wallet/v1/binding/balance');
        if (str(bound.balance) && bound.balance !== '0') balances.push({ token: 'NEAR', amount: str(bound.balance)!, decimals: 24, source: 'bound', chain: 'near', usd: nearUsd(str(bound.balance)!), logo: this.logos.get('near') ?? null });
      }
      if (str(bal.balance) && bal.balance !== '0') balances.push({ token: 'NEAR', amount: str(bal.balance)!, decimals: 24, source: 'wallet', chain: 'near', usd: nearUsd(str(bal.balance)!), logo: this.logos.get('near') ?? null });
      balances.push(...intents);
      return WalletStateSchema.parse({ ...base, binding: { accountId: str(b.asset_account_id), status }, balances });
    } catch (e) {
      return { ...base, error: scrub((e as Error).message, 300) };
    }
  }

  /** The wallet's connector payment key: the one its key already claimed, else the free trial (fifty calls, first week). */
  private async paymentKey(): Promise<string> {
    const have = await this.call('/wallet/v1/payment-key');
    const key = str(have.payment_key) ?? str((await this.call('/trial-key', { method: 'POST' })).payment_key);
    if (!key) throw new UpstreamError('OutLayer did not return a payment key for the wallet.');
    return key;
  }

  /** One `status` call to a trading connector (free, but it counts as one of the trial's calls): is the owner's policy
      stored for this wallet? That is the caps the agents trade under, set at app.outlayer.ai/connect/<name>. */
  async connectorPolicy(name: ConnectorName): Promise<{ present: boolean; error: string | null; callsLeft: number | null }> {
    const walletId = readSettings(this.db).outlayerWalletId;
    if (!this.key() || !walletId) throw new InvalidInputError('Connect the company wallet in the safe first.');
    const contract = this.api.includes('testnet') ? 'connectors.outlayer.testnet' : 'connectors.outlayer.near';
    const pk = await this.paymentKey();
    const r = await this.call(`/call/${contract}/${name}`, {
      method: 'POST', key: null, body: { input: { operation: 'status' } },
      headers: { 'X-Payment-Key': pk, 'X-Wallet-Id': walletId },
    });
    // free: what is left of the trial, so the CEO sees what each check costs
    const sub = await this.call('/subscription/status', { headers: { 'X-Payment-Key': pk } }).catch(() => ({}) as Json);
    const left = ((sub as Json).trial as Json | undefined)?.calls_left;
    const callsLeft = typeof left === 'number' ? left : null;
    const out = (r.output ?? {}) as Json;
    if ((r as Json).status === 'failed' || out.success === false) return { present: false, callsLeft, error: scrub(str(r.error) ?? str(out.error) ?? 'the connector refused the status call', 300) };
    const policy = ((out.output ?? {}) as Json).policy as Json | undefined;
    return { present: policy?.present === true, error: null, callsLeft };
  }

  /** One NEAR function call signed by the company wallet (POST /wallet/v1/call), inside the owner's OutLayer policy.
      `gas` and `deposit` are strings (gas units, yoctoNEAR). A wallet whose policy needs approvers answers `pending`
      with the request to follow (`request`); never send the call again while it is pending. Throws on a failure. */
  async callContract(receiverId: string, method: string, args: Json, gas: string, deposit: string): Promise<CallOutcome> {
    if (!this.key()) throw new InvalidInputError('Connect the company wallet in the safe first.');
    const r = await this.call('/wallet/v1/call', { method: 'POST', body: { receiver_id: receiverId, method_name: method, args, gas, deposit } });
    return outcome(r, `${receiverId} ${method}`);
  }

  /** Where a wallet request stands now (GET /wallet/v1/requests/{id}). */
  async request(requestId: string, what: string): Promise<CallOutcome> {
    return outcome(await this.call(`/wallet/v1/requests/${encodeURIComponent(requestId)}`), what);
  }

  /** What a company-wallet floor's agents get in their profile .env; null until there is a wallet. */
  env(): Record<string, string> | null {
    const key = this.key(), id = readSettings(this.db).outlayerWalletId;
    return key ? { OUTLAYER_API_KEY: key, ...(id ? { OUTLAYER_WALLET_ID: id } : {}) } : null;
  }
}
