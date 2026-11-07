/* The safe (feature spec 6.1): one read of the three pots, kept separate.
   - Wallets: the founder's NEAR accounts (public ids only, linked from the browser's wallet selector) and balances.
   - Treasury: a read-only mirror of a Sputnik DAO (balance, roles, proposal bond, recent proposals).
   - Credits: NEAR AI Cloud's organization balance, when an organization id and access token are configured.
   Every read is best effort and reports its own error; nothing here can move funds. */
import type { DatabaseSync } from 'node:sqlite';
import {
  MoneySettingsSchema, NEAR_ACCOUNT_RE,
  type CreditsView, type DaoProposalView, type MoneySettings, type MoneyView, type NearNetwork, type TreasuryView, type WalletView,
} from '@vibe-city/shared';
import { DEFAULT_RPC, NearRpc, type NearReader } from '../near/rpc.ts';
import { InvalidInputError, NotFoundError } from './errors.ts';

export interface CreditsSource {
  readonly configured: boolean;
  read(): Promise<Omit<CreditsView, 'connected' | 'error'>>;
}

/** NEAR AI Cloud: GET /v1/organizations/{org}/usage/balance (amounts in nano-dollars; needs a session token, not an API key). */
export class NearAiCredits implements CreditsSource {
  private o: { baseUrl: string; orgId: string | null; token: string | null; fetch?: typeof fetch };
  constructor(o: { baseUrl: string; orgId: string | null; token: string | null; fetch?: typeof fetch }) { this.o = o; }
  get configured() { return !!(this.o.orgId && this.o.token); }
  async read() {
    const base = this.o.baseUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
    const res = await (this.o.fetch ?? fetch)(`${base}/v1/organizations/${encodeURIComponent(this.o.orgId!)}/usage/balance`, { headers: { authorization: `Bearer ${this.o.token}` } });
    if (res.status === 401 || res.status === 403) throw new Error('NEAR AI Cloud rejected the access token (it may have expired).');
    if (!res.ok) throw new Error(`NEAR AI Cloud answered HTTP ${res.status}.`);
    const b = (await res.json()) as Record<string, unknown>;
    const usd = (nano: unknown, display: unknown) => (typeof display === 'string' ? display : typeof nano === 'number' ? `$${(nano / 1e9).toFixed(2)}` : null);
    return {
      remaining: usd(b.remaining, b.remaining_display), spent: usd(b.total_spent, b.total_spent_display),
      requests: typeof b.total_requests === 'number' ? b.total_requests : null, tokens: typeof b.total_tokens === 'number' ? b.total_tokens : null,
      lastUsageAt: typeof b.last_usage_at === 'string' ? b.last_usage_at : null,
    };
  }
}

export interface MoneyDeps {
  db: DatabaseSync;
  credits: CreditsSource;
  /** RPC per network (tests and the demo pass a fake). */
  reader?: (network: NearNetwork) => { url: string; rpc: NearReader };
  rpcUrl?: Partial<Record<NearNetwork, string>>;
  now?: () => Date;
}

const DEFAULTS: MoneySettings = { network: 'mainnet', daoAccountId: null, trezuUrl: null };
const CACHE_MS = 15_000;

export class MoneyService {
  private d: MoneyDeps;
  private cache: { key: string; at: number; view: MoneyView } | null = null;
  constructor(d: MoneyDeps) { this.d = d; }

  settings(): MoneySettings {
    const r = this.d.db.prepare('SELECT settings_json FROM money_settings WHERE id = 1').get() as { settings_json: string } | undefined;
    return r ? MoneySettingsSchema.parse({ ...DEFAULTS, ...JSON.parse(r.settings_json) }) : DEFAULTS;
  }

  setSettings(patch: Partial<MoneySettings>): MoneySettings {
    const next = MoneySettingsSchema.parse({ ...this.settings(), ...patch });
    this.d.db.prepare('INSERT INTO money_settings (id, settings_json) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET settings_json = excluded.settings_json').run(JSON.stringify(next));
    this.cache = null;
    return next;
  }

  linkWallet(accountId: string): void {
    if (!NEAR_ACCOUNT_RE.test(accountId)) throw new InvalidInputError('not a NEAR account id');
    const network = this.settings().network;
    const first = (this.d.db.prepare('SELECT COUNT(*) AS n FROM near_wallet WHERE network = ?').get(network) as { n: number }).n === 0;
    this.d.db.prepare('INSERT OR IGNORE INTO near_wallet (account_id, network, is_primary, linked_at) VALUES (?, ?, ?, ?)').run(accountId, network, first ? 1 : 0, new Date().toISOString());
    this.cache = null;
  }

  unlinkWallet(accountId: string): void {
    const network = this.settings().network;
    const r = this.d.db.prepare('DELETE FROM near_wallet WHERE account_id = ? AND network = ?').run(accountId, network);
    if (!r.changes) throw new NotFoundError('wallet not linked');
    // keep one primary if any wallet is left
    const hasPrimary = (this.d.db.prepare('SELECT COUNT(*) AS n FROM near_wallet WHERE network = ? AND is_primary = 1').get(network) as { n: number }).n > 0;
    if (!hasPrimary) this.d.db.prepare('UPDATE near_wallet SET is_primary = 1 WHERE rowid = (SELECT rowid FROM near_wallet WHERE network = ? ORDER BY linked_at LIMIT 1)').run(network);
    this.cache = null;
  }

  setPrimary(accountId: string): void {
    const network = this.settings().network;
    const exists = this.d.db.prepare('SELECT 1 FROM near_wallet WHERE account_id = ? AND network = ?').get(accountId, network);
    if (!exists) throw new NotFoundError('wallet not linked');
    this.d.db.prepare('UPDATE near_wallet SET is_primary = CASE WHEN account_id = ? THEN 1 ELSE 0 END WHERE network = ?').run(accountId, network);
    this.cache = null;
  }

  async view(fresh = false): Promise<MoneyView> {
    const settings = this.settings();
    const wallets = this.d.db.prepare('SELECT account_id, is_primary FROM near_wallet WHERE network = ? ORDER BY is_primary DESC, linked_at').all(settings.network) as { account_id: string; is_primary: number }[];
    const key = JSON.stringify([settings, wallets]);
    if (!fresh && this.cache && this.cache.key === key && Date.now() - this.cache.at < CACHE_MS) return this.cache.view;
    const { url, rpc } = this.reader(settings.network);
    const err = (e: unknown) => (e as Error).message || 'Could not read it.';
    const [walletViews, treasury, credits] = await Promise.all([
      Promise.all(wallets.map(async (w): Promise<WalletView> => {
        try { return { accountId: w.account_id, primary: !!w.is_primary, balance: await rpc.balance(w.account_id), error: null }; }
        catch (e) { return { accountId: w.account_id, primary: !!w.is_primary, balance: null, error: err(e) }; }
      })),
      settings.daoAccountId ? this.treasury(rpc, settings.daoAccountId) : Promise.resolve(null),
      this.creditsView(),
    ]);
    const view: MoneyView = { settings, rpcUrl: url, wallets: walletViews, treasury, credits, readAt: new Date().toISOString() };
    this.cache = { key, at: Date.now(), view };
    return view;
  }

  private reader(network: NearNetwork) {
    if (this.d.reader) return this.d.reader(network);
    const url = this.d.rpcUrl?.[network] ?? DEFAULT_RPC[network];
    return { url, rpc: new NearRpc(url) };
  }

  private async treasury(rpc: NearReader, dao: string): Promise<TreasuryView> {
    const out: TreasuryView = { daoAccountId: dao, balance: null, proposalBond: null, roles: [], proposals: [], error: null };
    const errors: string[] = [];
    await Promise.all([
      rpc.balance(dao).then((b) => { out.balance = b; }).catch((e) => errors.push((e as Error).message)),
      rpc.view<{ proposal_bond?: string; roles?: { name: string; kind: unknown }[] }>(dao, 'get_policy').then((p) => {
        out.proposalBond = typeof p.proposal_bond === 'string' ? p.proposal_bond : null;
        out.roles = (p.roles ?? []).map((r) => ({ name: String(r.name), members: r.kind && typeof r.kind === 'object' && 'Group' in (r.kind as object) ? ((r.kind as { Group: unknown[] }).Group?.length ?? null) : null }));
      }).catch((e) => errors.push((e as Error).message)),
      (async () => {
        const last = await rpc.view<number>(dao, 'get_last_proposal_id');
        if (!last) return;
        const from = Math.max(0, last - 10);
        const list = await rpc.view<RawProposal[]>(dao, 'get_proposals', { from_index: from, limit: 10 });
        out.proposals = list.map(proposalView).reverse();
      })().catch((e) => errors.push((e as Error).message)),
    ]);
    out.error = errors.length ? [...new Set(errors)][0]! : null;
    return out;
  }

  private async creditsView(): Promise<CreditsView> {
    const none = { remaining: null, spent: null, requests: null, tokens: null, lastUsageAt: null };
    if (!this.d.credits.configured) return { connected: false, ...none, error: null };
    try { return { connected: true, ...(await this.d.credits.read()), error: null }; }
    catch (e) { return { connected: true, ...none, error: (e as Error).message }; }
  }
}

interface RawProposal { id: number; proposer: string; description: string; kind: unknown; status: string; vote_counts?: Record<string, [number, number, number]>; submission_time?: string }

/** yoctoNEAR (decimal string) to a short NEAR amount. */
export function formatNear(yocto: string, digits = 4): string {
  const v = BigInt(yocto), whole = v / 10n ** 24n, frac = (v % 10n ** 24n).toString().padStart(24, '0').slice(0, digits).replace(/0+$/, '');
  return `${whole.toLocaleString('en-US')}${frac ? '.' + frac : ''}`;
}

function proposalView(p: RawProposal): DaoProposalView {
  let approve = 0, reject = 0;
  for (const c of Object.values(p.vote_counts ?? {})) { approve += c[0] ?? 0; reject += c[1] ?? 0; }
  const nanos = p.submission_time ? Number(BigInt(p.submission_time) / 1_000_000n) : NaN;
  return {
    id: p.id, proposer: p.proposer, description: String(p.description ?? '').slice(0, 300), kind: describeKind(p.kind), status: p.status,
    approve, reject, submittedAt: Number.isFinite(nanos) ? new Date(nanos).toISOString() : null,
  };
}

export function describeKind(kind: unknown): string {
  if (typeof kind === 'string') return kind.replace(/([a-z])([A-Z])/g, '$1 $2');
  if (!kind || typeof kind !== 'object') return 'Unknown';
  const [name, body] = Object.entries(kind as Record<string, Record<string, unknown>>)[0] ?? ['Unknown', {}];
  if (name === 'Transfer') {
    const amount = typeof body.amount === 'string' ? body.amount : '0';
    const token = body.token_id ? ` of ${String(body.token_id)}` : ' NEAR';
    return `Transfer ${body.token_id ? amount : formatNear(amount)}${token} to ${String(body.receiver_id)}`;
  }
  if (name === 'FunctionCall') return `Call ${String(body.receiver_id)}`;
  if (name === 'AddMemberToRole') return `Add ${String(body.member_id)} as ${String(body.role)}`;
  if (name === 'RemoveMemberFromRole') return `Remove ${String(body.member_id)} from ${String(body.role)}`;
  return name.replace(/([a-z])([A-Z])/g, '$1 $2');
}
