/* The company's OutLayer custody wallet (docs/briefs/03-outlayer-wallet.md, reduced to the two ways in).
   Its keys live in OutLayer's TEE; Vibe City holds only the wallet's agent API key (wk_), server-side, and gives it to
   the floors whose template says wallet: 'company'. Two ways to get one:
     - paste: the CEO creates the wallet at app.outlayer.ai/wallet/new and pastes its key (checked against OutLayer first);
     - bind:  we register a wallet, record a binding to the CEO's NEAR account, and the CEO signs once on OutLayer's
              connect page. The wallet then acts as that account under that account's policy.
   Spending policy is set by the owner in OutLayer; nothing here can read it back. */
import type { DatabaseSync } from 'node:sqlite';
import { WalletStateSchema, type WalletState } from '@vibe-city/shared';
import { readSettings, secret, setSecrets, writeSettings } from '../routes/company.ts';
import { ConflictError, InvalidInputError, UpstreamError } from './errors.ts';
import { scrub } from './scrub.ts';

export const OUTLAYER_API = process.env.OUTLAYER_API_URL || 'https://api.outlayer.ai';
export const OUTLAYER_APP = 'https://app.outlayer.ai';
/** Native USDC on NEAR: funding sends it to the wallet's Intents balance, which swaps and the trading connectors spend. */
export const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

export const EMPTY_WALLET: WalletState = { registered: false, accountId: null, handoffUrl: null, binding: { accountId: null, status: 'none' }, balances: [], shielded: false, error: null };

type Json = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

export class WalletService {
  private db: DatabaseSync;
  private fetch_: typeof fetch;
  private api: string;
  constructor(db: DatabaseSync, fetch_: typeof fetch = fetch, api = OUTLAYER_API) { this.db = db; this.fetch_ = fetch_; this.api = api; }

  private key() { return secret(this.db, 'outlayerApiKey'); }

  private async call(path: string, opts: { method?: string; body?: Json; key?: string | null } = {}): Promise<Json & { status?: number }> {
    const key = opts.key === undefined ? this.key() : opts.key;
    let r: Response;
    try {
      r = await this.fetch_(this.api + path, {
        method: opts.method ?? 'GET',
        headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(opts.body ? { 'content-type': 'application/json' } : {}) },
        ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch { throw new UpstreamError('OutLayer is unreachable.'); }
    const j = (await r.json().catch(() => ({}))) as Json;
    if (r.ok) return j;
    const msg = scrub(str(j.message) ?? str(j.error) ?? `OutLayer answered ${r.status}`, 300)!;
    if (r.status === 401 || r.status === 403) throw new InvalidInputError(`OutLayer does not accept this wallet key: ${msg}`);
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
      const [bal, usdc, b] = await Promise.all([
        this.call('/wallet/v1/balance?chain=near'), this.call(`/wallet/v1/balance?token=${USDC}&source=intents`), this.call('/wallet/v1/binding'),
      ]);
      const raw = str(b.binding_status) ?? str(b.status);
      const status = raw === 'active' ? 'active' : raw === 'pending' ? 'pending' : 'none';
      const balances: WalletState['balances'] = [];
      if (status === 'active') {
        const bound = await this.call('/wallet/v1/binding/balance');
        if (str(bound.balance)) balances.push({ token: 'near', amount: str(bound.balance)!, source: 'bound' });
      }
      if (str(bal.balance)) balances.push({ token: 'near', amount: str(bal.balance)!, source: 'wallet' });
      if (str(usdc.balance)) balances.push({ token: 'usdc', amount: str(usdc.balance)!, source: 'intents' });
      return WalletStateSchema.parse({ ...base, binding: { accountId: str(b.asset_account_id), status }, balances });
    } catch (e) {
      return { ...base, error: scrub((e as Error).message, 300) };
    }
  }

  /** What a company-wallet floor's agents get in their profile .env; null until there is a wallet. */
  env(): Record<string, string> | null {
    const key = this.key(), id = readSettings(this.db).outlayerWalletId;
    return key ? { OUTLAYER_API_KEY: key, ...(id ? { OUTLAYER_WALLET_ID: id } : {}) } : null;
  }
}
