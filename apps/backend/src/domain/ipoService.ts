/* The IPO (docs/briefs/06-ipo.md). The company OutLayer wallet signs every call; Vibe City holds no NEAR key.
     launch:   a Sputnik DAO on sputnik-dao.near (CEO approves and administers, the wallet only proposes), the DAO
               registered on the payout tokens, then a city token on the tkn.near factory with the whole supply owned
               by the DAO. Each step checks what is already on chain first, so a retry never creates a second one.
     allocate: a DAO proposal sending city tokens to one account (the demo's holders).
     dividend: one DAO proposal paying every holder its share of a payout, pro rata to its city tokens.
   Proposals execute only when the CEO approves them in Trezu.
   A wallet whose OutLayer policy needs approvers answers `pending`: the request id is kept and the IPO waits
   (awaiting_approval); Continue asks OutLayer where that request stands and never sends the call a second time. */
import type { DatabaseSync } from 'node:sqlite';
import type { IpoAllocate, IpoDividend, IpoLaunch, IpoProposal, IpoState } from '@vibe-city/shared';
import type { NearReader } from '../near/rpc.ts';
import type { CallOutcome } from './walletService.ts';
import { ConflictError, InvalidInputError, UpstreamError } from './errors.ts';
import { scrub } from './scrub.ts';

export interface ContractCaller {
  callContract(receiverId: string, method: string, args: Record<string, unknown>, gas: string, deposit: string): Promise<CallOutcome>;
  request(requestId: string, what: string): Promise<CallOutcome>;
}

/** A wallet call is waiting for the owner's approval in OutLayer: the IPO stops here until Continue. */
class Waiting extends Error {}

export const DAO_FACTORY = 'sputnik-dao.near';
export const TOKEN_FACTORY = 'tkn.near';
/** Read on mainnet 2026-11-10: the tkn.near factory's code, and the code of every token it had created (no keys, NEP-141
    methods only). If either changes we stop: the factory has a full-access key, so its owner can change what it deploys. */
export const TOKEN_FACTORY_HASH = 'GqJ8R7fWXGvPQYTUcVBNbbTiMs3fZTdZAJVbQGvJCq9N';
export const TOKEN_HASH = '4AVV1KUVgi17XoXkqxUPzyMhERXu15mGawriPQvWmBKD';
const YOCTO = 10n ** 24n, TGAS = 10n ** 12n;
/** Attached to `create` and forwarded to the DAO: with a zero proposal bond, the DAO pays for proposal storage and
    the holder registrations its proposals make. A 0.09 NEAR DAO has 0.0035 NEAR to spend. */
export const DAO_DEPOSIT = YOCTO;
export const TOKEN_DECIMALS = 6;
export const TOKEN_SUPPLY = 1_000_000;
/** One NEP-145 registration, with room: `registration_only` refunds what the token does not keep (USDC keeps 0.00125). */
const REGISTER = 125n * 10n ** 20n;
export const PAYOUT = {
  USDC: { contract: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', decimals: 6 },
  wNEAR: { contract: 'wrap.near', decimals: 24 },
} as const;
/** A dividend registers and pays each holder (25 Tgas) inside the approver's 300 Tgas act_proposal.
    ponytail: one proposal per payout; split into batches if the demo ever has more holders. */
export const MAX_HOLDERS = 8;

type StoredProposal = Omit<IpoProposal, 'awaitingWalletApproval'> & { requestId?: string };
interface Stored {
  ceoAccountId: string | null; symbol: string | null; daoAccountId: string | null; tokenAccountId: string | null;
  txHashes: string[]; holders: string[]; proposals: StoredProposal[]; error: string | null; done: boolean;
  /** The IPO step's wallet request waiting for the owner's approval in OutLayer. */
  pending: { requestId: string; what: string } | null;
}
const empty = (): Stored => ({ ceoAccountId: null, symbol: null, daoAccountId: null, tokenAccountId: null, txHashes: [], holders: [], proposals: [], error: null, done: false, pending: null });
const proposalId = (r: unknown) => (typeof r === 'number' ? r : typeof r === 'string' && /^\d+$/.test(r) ? Number(r) : null);

/** The DAO's sub-account name: the company name as a NEAR account segment. */
export function daoName(company: string): string {
  const s = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return s.length >= 2 ? s : 'vibe-city-company';
}

/** Trezu's role layout: the wallet may only propose; the CEO approves (one vote passes) and administers. */
export function daoPolicy(ceo: string, wallet: string) {
  const one = { weight_kind: 'RoleWeight', quorum: '0', threshold: '1' };
  const admin = ['config', 'policy', 'add_member_to_role', 'remove_member_from_role', 'upgrade_self', 'upgrade_remote', 'set_vote_token', 'add_bounty', 'bounty_done',
    'factory_info_update', 'policy_add_or_update_role', 'policy_remove_role', 'policy_update_default_vote_policy', 'policy_update_parameters'];
  const week = '604800000000000';
  return {
    roles: [
      { name: 'Requestor', kind: { Group: [...new Set([ceo, wallet])] }, permissions: ['call:AddProposal', 'transfer:AddProposal'], vote_policy: { call: one, transfer: one } },
      { name: 'Admin', kind: { Group: [ceo] }, permissions: admin.map((k) => `${k}:*`), vote_policy: Object.fromEntries(admin.map((k) => [k, one])) },
      { name: 'Approver', kind: { Group: [ceo] }, permissions: ['call', 'transfer'].flatMap((k) => ['VoteApprove', 'VoteReject', 'RemoveProposal', 'Finalize'].map((a) => `${k}:${a}`)), vote_policy: { call: one, transfer: one } },
    ],
    default_vote_policy: { weight_kind: 'RoleWeight', quorum: '0', threshold: [1, 2] },
    proposal_bond: '0', proposal_period: week, bounty_bond: '0', bounty_forgiveness_period: week,
  };
}

type Role = { name: string; kind: { Group?: string[] } | string };
const inRole = (policy: { roles?: Role[] }, role: string, account: string) =>
  (policy.roles ?? []).some((r) => r.name === role && typeof r.kind === 'object' && (r.kind.Group ?? []).includes(account));

/** `amount` whole units in the token's smallest unit. Amounts are typed by a person: 6 decimal places are kept
    (a float has no more to give for an 18 or 24 decimal token). */
export function units(amount: number, decimals: number): bigint {
  const [whole, frac = ''] = amount.toFixed(Math.min(decimals, 6)).split('.');
  return BigInt(whole! + frac.padEnd(decimals, '0'));
}

/** Each holder's share of `pool`, pro rata to its tokens over the circulating supply (rounded down; dust stays in the DAO). */
export function shares(pool: bigint, balances: { accountId: string; balance: bigint }[], circulating: bigint) {
  return balances.map((h) => ({ accountId: h.accountId, amount: circulating > 0n ? (pool * h.balance) / circulating : 0n })).filter((s) => s.amount > 0n);
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64');
const action = (method: string, args: unknown, deposit: bigint, tgas: bigint) => ({ method_name: method, args: b64(args), deposit: deposit.toString(), gas: (tgas * TGAS).toString() });

export class IpoService {
  private db: DatabaseSync; private wallet: ContractCaller; private rpc: NearReader;
  private walletAccount: () => string | null; private companyName: () => string; private pauseMs: number;
  private running = false;

  constructor(deps: { db: DatabaseSync; wallet: ContractCaller; rpc: NearReader; walletAccount: () => string | null; companyName: () => string; pauseMs?: number }) {
    this.db = deps.db; this.wallet = deps.wallet; this.rpc = deps.rpc; this.walletAccount = deps.walletAccount; this.companyName = deps.companyName;
    this.pauseMs = deps.pauseMs ?? 2000;
  }

  private read(): Stored {
    const row = this.db.prepare('SELECT state_json FROM ipo WHERE id = 1').get() as { state_json: string } | undefined;
    return { ...empty(), ...(row ? (JSON.parse(row.state_json) as Partial<Stored>) : {}) };
  }
  private save(s: Stored) {
    this.db.prepare('INSERT INTO ipo (id, state_json) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET state_json = excluded.state_json').run(JSON.stringify(s));
  }

  isDone(): boolean { return this.read().done; }

  async view(unlocked: boolean): Promise<IpoState> {
    const s = this.read();
    if (s.proposals.some((p) => p.requestId)) await this.settleProposals(s);
    const started = s.txHashes.length > 0 || !!s.daoAccountId || !!s.pending;
    const state = this.running ? 'running' : s.pending ? 'awaiting_approval' : s.done ? 'done' : s.error ? 'error' : unlocked || started ? 'ready' : 'locked';
    const holders = await Promise.all(s.holders.map(async (accountId) => {
      if (!s.tokenAccountId) return { accountId, balance: null };
      const raw = await this.rpc.view<string>(s.tokenAccountId, 'ft_balance_of', { account_id: accountId }).catch(() => null);
      return { accountId, balance: raw === null ? null : Number(raw) / 10 ** TOKEN_DECIMALS };
    }));
    return {
      state, awaiting: s.pending?.what ?? null, ceoAccountId: s.ceoAccountId, daoAccountId: s.daoAccountId, tokenAccountId: s.tokenAccountId, symbol: s.symbol,
      txHashes: s.txHashes, holders, proposals: s.proposals.map(({ requestId, ...p }) => ({ ...p, awaitingWalletApproval: !!requestId })), error: s.error,
    };
  }

  /** Proposals whose filing waited for the owner's approval in OutLayer: read where each stands (best effort). */
  private async settleProposals(s: Stored) {
    for (const p of s.proposals) {
      if (!p.requestId) continue;
      try {
        const r = await this.wallet.request(p.requestId, 'add_proposal');
        if (r.status === 'pending') continue;
        p.id = proposalId(r.result); p.txHash = r.txHash;
        if (r.txHash) s.txHashes.push(r.txHash);
      } catch (e) {
        if (!(e instanceof UpstreamError)) continue; // unreachable OutLayer: ask again next time
        p.title += ' (not filed: refused or failed in OutLayer)';
      }
      delete p.requestId;
    }
    this.save(s);
  }

  /** Runs (or resumes) the IPO. `unlocked`: the game says the IPO is open; a started IPO may resume either way (it spent the funds that unlocked it). */
  async launch(input: IpoLaunch, unlocked: boolean): Promise<IpoState> {
    const s = this.read();
    if (s.done) throw new ConflictError('The company is already public.');
    if (this.running) throw new ConflictError('The IPO is already running.');
    if (!unlocked && !s.daoAccountId && !s.txHashes.length && !s.pending) throw new ConflictError('The IPO is locked: win your first market job and hold the NEAR it needs in the company wallet.');
    const wallet = this.walletAccount();
    if (!wallet) throw new InvalidInputError('Connect the company wallet in the safe first: it signs the IPO.');
    // the DAO's council and the token's symbol are fixed once they exist on chain
    const ceo = s.daoAccountId ? s.ceoAccountId! : input.ceoAccountId;
    const symbol = s.tokenAccountId ? s.symbol! : input.symbol;
    if (ceo === wallet) throw new InvalidInputError('The CEO account must be your own NEAR account, not the company wallet.');
    const st: Stored = { ...s, ceoAccountId: ceo, symbol, error: null };
    this.save(st);
    this.running = true;
    try {
      if (st.pending) {
        const r = await this.wallet.request(st.pending.requestId, st.pending.what).catch((e: Error) => {
          if (e instanceof UpstreamError) { st.pending = null; this.save(st); } // final: refused or failed; the next press starts that step again
          throw e;
        });
        if (r.status === 'pending') throw new Waiting();
        st.pending = null;
        if (r.txHash) st.txHashes.push(r.txHash);
        this.save(st);
      }
      await this.createDao(st, ceo, wallet);
      await this.registerDao(st, st.daoAccountId!);
      await this.createToken(st, st.daoAccountId!, symbol, wallet);
      st.done = true;
      this.save(st);
    } catch (e) {
      if (e instanceof Waiting) { this.running = false; return this.view(true); }
      st.error = scrub((e as Error).message, 300) ?? 'The IPO failed.';
      this.save(st);
      throw e;
    } finally { this.running = false; }
    return this.view(true);
  }

  private async call(st: Stored, receiver: string, method: string, args: Record<string, unknown>, tgas: bigint, deposit: bigint) {
    const r = await this.wallet.callContract(receiver, method, args, (tgas * TGAS).toString(), deposit.toString());
    if (r.status === 'pending') { st.pending = { requestId: r.requestId, what: `${receiver} ${method}` }; this.save(st); throw new Waiting(); }
    if (r.txHash) { st.txHashes.push(r.txHash); this.save(st); }
    return r;
  }

  /** Reads until `ok` (the RPC answers at final, a second or two after the wallet's call returns). */
  private async settle<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
    let v = await read();
    for (let i = 0; i < 4 && !ok(v); i++) { await new Promise((r) => setTimeout(r, this.pauseMs)); v = await read(); }
    return v;
  }

  private async createDao(st: Stored, ceo: string, wallet: string) {
    const name = daoName(this.companyName()), dao = `${name}.${DAO_FACTORY}`;
    const existed = !!(await this.rpc.account(dao));
    if (!existed) {
      await this.call(st, DAO_FACTORY, 'create', {
        name, args: b64({ config: { name, purpose: `Treasury of ${this.companyName()}, a Vibe City company.`, metadata: '' }, policy: daoPolicy(ceo, wallet) }),
      }, 300n, DAO_DEPOSIT);
    }
    const read = () => this.rpc.view<{ roles?: Role[] }>(dao, 'get_policy').catch(() => null);
    const policy = existed ? await read() : await this.settle(read, (p) => p !== null);
    if (!policy && !existed) throw new UpstreamError(`${dao} did not answer after it was created; press IPO again to check.`);
    if (!policy || !inRole(policy, 'Approver', ceo) || !inRole(policy, 'Requestor', wallet)) {
      throw new ConflictError(`${dao} already exists and is not this company's DAO. Rename the company to use another name.`);
    }
    st.daoAccountId = dao;
    this.save(st);
  }

  /** The DAO must be registered on a payout token before revenue can be sent to it. */
  private async registerDao(st: Stored, dao: string) {
    for (const p of Object.values(PAYOUT)) {
      if (await this.rpc.view(p.contract, 'storage_balance_of', { account_id: dao })) continue;
      await this.call(st, p.contract, 'storage_deposit', { account_id: dao, registration_only: true }, 30n, REGISTER);
    }
  }

  private async createToken(st: Stored, dao: string, symbol: string, wallet: string) {
    const id = symbol.toLowerCase(), account = `${id}.${TOKEN_FACTORY}`;
    if (!(await this.rpc.account(account))) {
      const factory = await this.rpc.account(TOKEN_FACTORY);
      if (factory?.codeHash !== TOKEN_FACTORY_HASH) throw new UpstreamError('tkn.near runs different code than the code we checked, so the IPO will not pay it. See docs/briefs/06-ipo.md.');
      const args = {
        owner_id: dao, total_supply: units(TOKEN_SUPPLY, TOKEN_DECIMALS).toString(),
        metadata: { spec: 'ft-1.0.0', name: `${this.companyName()} City Token`.slice(0, 60), symbol, decimals: TOKEN_DECIMALS, icon: null, reference: null, reference_hash: null },
      };
      // the factory keeps any overpayment (it has no refund path): attach exactly what it asks for
      const deposit = await this.rpc.view<string>(TOKEN_FACTORY, 'get_required_deposit', { args, account_id: wallet });
      await this.call(st, TOKEN_FACTORY, 'create_token', { args }, 200n, BigInt(deposit));
    }
    const token = await this.settle(() => this.rpc.view<{ owner_id?: string } | null>(TOKEN_FACTORY, 'get_token', { token_id: id }).catch(() => null), (t) => !!t);
    if (!token) throw new UpstreamError(`${account} did not answer after it was created; press IPO again to check.`);
    if (token.owner_id !== dao) throw new ConflictError(`${account} belongs to someone else. Pick another symbol.`);
    const [info, keys] = await Promise.all([this.rpc.account(account), this.rpc.keyCount(account)]);
    if (info?.codeHash !== TOKEN_HASH || keys !== 0) throw new UpstreamError(`${account} is not the token code we checked (or someone holds a key to it), so it is not marked done.`);
    st.tokenAccountId = account;
    this.save(st);
  }

  private async propose(kind: IpoProposal['kind'], title: string, description: string, receiver: string, actions: ReturnType<typeof action>[]): Promise<IpoState> {
    const st = this.read();
    const r = await this.wallet.callContract(st.daoAccountId!, 'add_proposal', { proposal: { description, kind: { FunctionCall: { receiver_id: receiver, actions } } } }, (50n * TGAS).toString(), '0');
    const at = new Date().toISOString();
    if (r.status === 'pending') st.proposals.push({ id: null, kind, title, txHash: null, at, requestId: r.requestId });
    else {
      st.proposals.push({ id: proposalId(r.result), kind, title, txHash: r.txHash, at });
      if (r.txHash) st.txHashes.push(r.txHash);
    }
    this.save(st);
    return this.view(true);
  }

  private publicState(): Stored & { daoAccountId: string; tokenAccountId: string; symbol: string } {
    const s = this.read();
    if (!s.done || !s.daoAccountId || !s.tokenAccountId || !s.symbol) throw new ConflictError('The company is not public yet: press IPO first.');
    return s as Stored & { daoAccountId: string; tokenAccountId: string; symbol: string };
  }

  /** A DAO proposal giving `amount` city tokens to one account, which becomes a recorded holder. */
  async allocate(input: IpoAllocate): Promise<IpoState> {
    const s = this.publicState();
    const raw = units(input.amount, TOKEN_DECIMALS);
    const daoHas = BigInt(await this.rpc.view<string>(s.tokenAccountId, 'ft_balance_of', { account_id: s.daoAccountId }));
    if (daoHas < raw) throw new InvalidInputError(`The DAO holds ${Number(daoHas) / 10 ** TOKEN_DECIMALS} ${s.symbol}.`);
    if (!s.holders.includes(input.accountId)) { s.holders.push(input.accountId); this.save(s); }
    const title = `Allocate ${input.amount} ${s.symbol} to ${input.accountId}`;
    return this.propose('allocate', title, title, s.tokenAccountId, [
      action('storage_deposit', { account_id: input.accountId, registration_only: true }, REGISTER, 10n),
      action('ft_transfer', { receiver_id: input.accountId, amount: raw.toString(), memo: `${s.symbol} allocation` }, 1n, 15n),
    ]);
  }

  /** One DAO proposal paying `amount` of a payout token to the recorded holders, pro rata over the circulating supply
      (the DAO's own city tokens excluded; shares of holders we do not know stay in the DAO). */
  async dividend(input: IpoDividend): Promise<IpoState> {
    const s = this.publicState();
    const p = PAYOUT[input.token];
    const pool = units(input.amount, p.decimals);
    const held = BigInt(await this.rpc.view<string>(p.contract, 'ft_balance_of', { account_id: s.daoAccountId }));
    if (held < pool) throw new InvalidInputError(`The DAO holds ${Number(held) / 10 ** p.decimals} ${input.token}: move revenue into it first.`);
    const [supply, daoTokens] = await Promise.all([
      this.rpc.view<string>(s.tokenAccountId, 'ft_total_supply'),
      this.rpc.view<string>(s.tokenAccountId, 'ft_balance_of', { account_id: s.daoAccountId }),
    ]);
    const circulating = BigInt(supply) - BigInt(daoTokens);
    const balances = await Promise.all(s.holders.map(async (accountId) => ({ accountId, balance: BigInt(await this.rpc.view<string>(s.tokenAccountId, 'ft_balance_of', { account_id: accountId })) })));
    const pay = shares(pool, balances, circulating);
    if (!pay.length) throw new InvalidInputError(`Nobody holds ${s.symbol} yet: allocate some, and approve that in Trezu, first.`);
    if (pay.length > MAX_HOLDERS) throw new InvalidInputError(`One payout reaches at most ${MAX_HOLDERS} holders.`);
    const fmt = (n: bigint) => Number(n) / 10 ** p.decimals;
    const title = `Revenue share: ${input.amount} ${input.token} to ${pay.length} ${s.symbol} holder${pay.length === 1 ? '' : 's'}, pro rata`;
    const description = [title, ...pay.map((x) => `${x.accountId}: ${fmt(x.amount)} ${input.token}`)].join('\n');
    return this.propose('dividend', title, description, p.contract, pay.flatMap((x) => [
      action('storage_deposit', { account_id: x.accountId, registration_only: true }, REGISTER, 10n),
      action('ft_transfer', { receiver_id: x.accountId, amount: x.amount.toString(), memo: `${s.symbol} revenue share` }, 1n, 15n),
    ]));
  }
}
