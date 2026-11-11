import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db/db.ts';
import { DAO_DEPOSIT, IpoService, BASE_VALUATION_USD, PAYOUT, TOKEN_FACTORY, TOKEN_FACTORY_HASH, TOKEN_HASH, daoName, offerFrom, shares, units } from './domain/ipoService.ts';
import type { AccountInfo, NearReader } from './near/rpc.ts';
import { ConflictError, UpstreamError } from './domain/errors.ts';

const WALLET = 'a'.repeat(64), CEO = 'boss.near', DAO = 'acme-labs.sputnik-dao.near', TOKEN = `acme.${TOKEN_FACTORY}`, USDC = PAYOUT.USDC.contract;
const NEAR_USD = 4;
const decode = (b64: string) => JSON.parse(Buffer.from(b64, 'base64').toString());
type Kind = { kind: { FunctionCall: { receiver_id: string; actions: { method_name: string; args: string; deposit: string }[] } } };

/** A tiny mainnet: accounts, the DAO's policy, token balances and the token's offering, and what the company wallet's
    calls do to them. */
function fakeChain() {
  const accounts = new Map<string, AccountInfo>([[TOKEN_FACTORY, { amount: '0', codeHash: TOKEN_FACTORY_HASH, globalCodeHash: null }]]);
  const keys = new Map<string, number>();
  const policies = new Map<string, unknown>();
  const tokens = new Map<string, { owner_id: string }>();
  const ft = new Map<string, Map<string, bigint>>(); // contract -> account -> balance
  const sales = new Map<string, { price: string; open: boolean; sold: bigint; raised: bigint; buyers: string[] }>();
  const registered = new Set<string>();
  const calls: { receiver: string; method: string; args: Record<string, unknown>; deposit: string }[] = [];
  let failNext: string | null = null;
  let needsApproval = false;
  /** How many reads of a just-created token account still answer "no such account": the factory lists a token one block before its account exists. */
  let lag = 0;
  const late = new Map<string, number>();
  let walletNear = 10n ** 26n; // 100 NEAR
  const queued = new Map<string, () => { status: 'success'; txHash: string; result: unknown }>();
  const requests = new Map<string, 'pending' | 'rejected' | { status: 'success'; txHash: string; result: unknown }>();
  const bal = (c: string, a: string) => ft.get(c)?.get(a) ?? 0n;
  const setBal = (c: string, a: string, n: bigint) => { if (!ft.has(c)) ft.set(c, new Map()); ft.get(c)!.set(a, n); };
  const rpc: NearReader = {
    balance: async (id) => (id === WALLET ? String(walletNear) : '0'),
    account: async (id) => { const n = late.get(id) ?? 0; if (n > 0) { late.set(id, n - 1); return null; } return accounts.get(id) ?? null; },
    keyCount: async (id) => keys.get(id) ?? 0,
    view: async <T>(contract: string, method: string, args: Record<string, unknown> = {}) => {
      if (method === 'get_policy') { if (!policies.has(contract)) throw new Error('no contract'); return policies.get(contract) as T; }
      if (method === 'get_token') return (tokens.get(String(args.token_id)) ?? null) as T;
      if (method === 'get_required_deposit') return '2228440000000000000000000' as T;
      if (method === 'storage_balance_of') return (registered.has(`${contract}:${args.account_id}`) ? { total: '1', available: '0' } : null) as T;
      if (method === 'ft_balance_of') return String(bal(contract, String(args.account_id))) as T;
      if (method === 'ft_total_supply') return String([...(ft.get(contract)?.values() ?? [])].reduce((a, b) => a + b, 0n)) as T;
      const sale = sales.get(contract);
      if (method === 'sale_info' && sale) return { open: sale.open, sold: String(sale.sold), remaining: String(bal(contract, contract)), raised: String(sale.raised), buyers: sale.buyers.length, price: sale.price } as T;
      if (method === 'get_buyers' && sale) return sale.buyers.slice(Number(args.from_index), Number(args.from_index) + Number(args.limit)) as T;
      throw new Error(`unexpected view ${contract}.${method}`);
    },
  };
  let n = 0;
  const execute = (receiver: string, method: string, args: Record<string, unknown>, deposit: string) => {
    calls.push({ receiver, method, args, deposit });
    if (method === 'create') {
      const id = `${args.name}.sputnik-dao.near`;
      accounts.set(id, { amount: deposit, codeHash: '1'.repeat(32), globalCodeHash: 'DtHZA1mU' });
      policies.set(id, decode(String(args.args)).policy);
    }
    if (method === 'storage_deposit') registered.add(`${receiver}:${args.account_id}`);
    if (method === 'create_token') {
      const a = args.args as { owner_id: string; total_supply: string; sale_amount: string; price: string; metadata: { symbol: string } };
      const token = `${a.metadata.symbol.toLowerCase()}.${TOKEN_FACTORY}`;
      accounts.set(token, { amount: '0', codeHash: TOKEN_HASH, globalCodeHash: null });
      late.set(token, lag);
      tokens.set(a.metadata.symbol.toLowerCase(), { owner_id: a.owner_id });
      setBal(token, a.owner_id, BigInt(a.total_supply) - BigInt(a.sale_amount));
      setBal(token, token, BigInt(a.sale_amount));
      sales.set(token, { price: a.price, open: true, sold: 0n, raised: 0n, buyers: [] });
    }
    return { status: 'success' as const, txHash: `tx${++n}`, result: method === 'add_proposal' ? n : null };
  };
  const sent: string[] = [];
  const wallet = {
    callContract: async (receiver: string, method: string, args: Record<string, unknown>, _gas: string, deposit: string) => {
      if (failNext === method) { failNext = null; throw new Error('OutLayer: the call timed out'); }
      sent.push(method);
      if (!needsApproval) return execute(receiver, method, args, deposit);
      const id = `req${sent.length}`;
      queued.set(id, () => execute(receiver, method, args, deposit));
      requests.set(id, 'pending');
      return { status: 'pending' as const, requestId: id };
    },
    request: async (id: string) => {
      const r = requests.get(id);
      if (r === 'pending') return { status: 'pending' as const, requestId: id };
      if (r === 'rejected' || !r) throw new UpstreamError('The wallet\'s call did not succeed: rejected');
      return r;
    },
  };
  /** Someone buys `tokens` whole tokens from the offering. */
  const buy = (token: string, who: string, tokens: number) => {
    const s = sales.get(token)!, u = units(tokens, 6);
    setBal(token, token, bal(token, token) - u); setBal(token, who, bal(token, who) + u);
    s.sold += u; s.raised += (u * BigInt(s.price)) / 1_000_000n; if (!s.buyers.includes(who)) s.buyers.push(who);
  };
  /** The owner approves (or rejects) every queued request in OutLayer. */
  const decide = (ok: boolean) => { for (const [id, run] of queued) { requests.set(id, ok ? run() : 'rejected'); queued.delete(id); } };
  return { rpc, wallet, calls, sent, accounts, keys, tokens, sales, setBal, bal, buy, fund: (y: bigint) => { walletNear = y; }, failOn: (m: string) => { failNext = m; }, approvals: (on: boolean) => { needsApproval = on; }, decide, late, lagAccounts: (reads: number) => { lag = reads; } };
}

function service(chain = fakeChain()) {
  const db = openDb(':memory:');
  const ipo = new IpoService({ db, wallet: chain.wallet, rpc: chain.rpc, walletAccount: () => WALLET, companyName: () => 'Acme Labs', nearUsd: async () => NEAR_USD, pauseMs: 0 });
  return { ipo, chain, db };
}
const LAUNCH = { ceoAccountId: CEO, symbol: 'ACME' };
/** $500 earned: $1,000 + 20 x 500 = $11,000 valuation */
const EARNED = 50_000;

test('the offer: a base valuation plus earnings, 40% float, the price per token in NEAR', () => {
  const o = offerFrom(EARNED, NEAR_USD);
  assert.equal(o.valuationUsd, 11_000);
  assert.equal(o.floatTokens, 400_000);
  assert.equal(o.priceNear, 0.00275, '$11,000 / 1,000,000 tokens = $0.011 = 0.00275 NEAR at $4');
  assert.equal(o.priceYocto, '2750000000000000000000');
  assert.equal(offerFrom(0, NEAR_USD).valuationUsd, BASE_VALUATION_USD);
  assert.ok(offerFrom(48, NEAR_USD).priceNear > offerFrom(0, NEAR_USD).priceNear, 'a first job of 48 cents already moves the price');
  assert.equal(offerFrom(-500, NEAR_USD).earnedUsd, 0);
});

test('locked: 409 and nothing is called; the offer is still previewed', async () => {
  const { ipo, chain } = service();
  const v = await ipo.view(false, EARNED);
  assert.equal(v.state, 'locked');
  assert.equal(v.offer?.priceNear, 0.00275);
  await assert.rejects(ipo.launch(LAUNCH, false, EARNED), ConflictError);
  assert.equal(chain.calls.length, 0);
});

test('unlocked: the DAO (CEO approves, wallet only proposes), its registrations, then the token with the 40% offering at the fixed price', async () => {
  const { ipo, chain } = service();
  assert.equal((await ipo.view(true, EARNED)).state, 'ready');
  const s = await ipo.launch(LAUNCH, true, EARNED);
  assert.deepEqual(chain.calls.map((c) => `${c.receiver} ${c.method}`), [
    'sputnik-dao.near create', `${USDC} storage_deposit`, 'wrap.near storage_deposit', `${TOKEN_FACTORY} create_token`,
  ]);
  const create = chain.calls[0]!;
  assert.equal(create.args.name, 'acme-labs');
  assert.equal(create.deposit, DAO_DEPOSIT.toString(), '1 NEAR so the DAO can pay for its proposals');
  const policy = decode(String(create.args.args)).policy;
  const role = (name: string) => policy.roles.find((r: { name: string }) => r.name === name);
  assert.deepEqual(role('Approver').kind.Group, [CEO]);
  assert.deepEqual(role('Admin').kind.Group, [CEO]);
  assert.deepEqual(role('Requestor').kind.Group, [CEO, WALLET]);
  assert.ok(!role('Requestor').permissions.some((p: string) => p.includes('Vote')), 'the agent wallet cannot vote');
  assert.equal(policy.proposal_bond, '0');
  const tok = chain.calls[3]!;
  assert.equal(tok.deposit, '2228440000000000000000000', 'what the factory asks for');
  const a = tok.args.args as Record<string, string>;
  assert.deepEqual([a.owner_id, a.total_supply, a.sale_amount, a.price], [DAO, '1000000000000', '400000000000', '2750000000000000000000']);
  assert.equal(s.state, 'done');
  assert.equal(s.tokenAccountId, TOKEN);
  assert.deepEqual(s.sale, { open: true, sold: 0, remaining: 400_000, raisedNear: 0, buyers: 0 });
  assert.ok(ipo.isDone());
  assert.equal((await ipo.view(true, 9_999_999)).offer?.priceNear, 0.00275, 'the price is fixed once the IPO starts');
  await assert.rejects(ipo.launch(LAUNCH, true, EARNED), ConflictError, 'only once');
});

test('a failure between steps, then a retry (now locked: the IPO spent the funds) creates no second DAO', async () => {
  const { ipo, chain } = service();
  chain.failOn('create_token');
  await assert.rejects(ipo.launch(LAUNCH, true, EARNED));
  const failed = await ipo.view(false, EARNED);
  assert.equal(failed.state, 'error');
  assert.match(failed.error!, /timed out/);
  assert.equal(failed.daoAccountId, DAO);
  const s = await ipo.launch({ ceoAccountId: 'someone-else.near', symbol: 'ACME' }, false, 99_999_999);
  assert.equal(s.state, 'done');
  assert.equal(chain.calls.filter((c) => c.method === 'create').length, 1);
  assert.equal(chain.calls.filter((c) => c.method === 'storage_deposit').length, 2, 'registrations are not repeated');
  assert.equal(s.ceoAccountId, CEO, 'the council is fixed once the DAO exists');
  assert.equal(s.offer?.priceNear, 0.00275, 'and so is the price');
});

test('a DAO name or token symbol someone else owns is refused, not adopted', async () => {
  const chain = fakeChain();
  chain.accounts.set(DAO, { amount: '0', codeHash: '1', globalCodeHash: null });
  await assert.rejects(service(chain).ipo.launch(LAUNCH, true, EARNED), /not this company's DAO/);

  const chain2 = fakeChain();
  chain2.accounts.set(TOKEN, { amount: '0', codeHash: TOKEN_HASH, globalCodeHash: null });
  chain2.tokens.set('acme', { owner_id: 'squatter.near' });
  await assert.rejects(service(chain2).ipo.launch(LAUNCH, true, EARNED), /belongs to someone else/);
  assert.equal(chain2.calls.filter((c) => c.method === 'create_token').length, 0);
});

test('a factory or token that is not the code we checked is not paid / not marked done', async () => {
  const chain = fakeChain();
  chain.accounts.set(TOKEN_FACTORY, { amount: '0', codeHash: 'other', globalCodeHash: null });
  await assert.rejects(service(chain).ipo.launch(LAUNCH, true, EARNED), /different code/);
  assert.equal(chain.calls.filter((c) => c.method === 'create_token').length, 0);

  const chain2 = fakeChain();
  const s2 = service(chain2);
  chain2.keys.set(TOKEN, 1);
  await assert.rejects(s2.ipo.launch(LAUNCH, true, EARNED), /not the token code/);
  assert.equal(s2.ipo.isDone(), false);
});

test('a token account that appears a block after the factory lists it is waited for, not called the wrong code', async () => {
  const { ipo, chain } = service();
  chain.lagAccounts(2);
  const s = await ipo.launch(LAUNCH, true, EARNED);
  assert.equal(s.state, 'done');
  assert.equal(s.tokenAccountId, TOKEN);
  assert.equal(chain.calls.filter((c) => c.method === 'create_token').length, 1);
});

test('a mint whose check failed is finished with the same symbol; another symbol is refused instead of paying for a second token', async () => {
  const { ipo, chain } = service();
  chain.lagAccounts(99); // the account never shows up while we wait
  await assert.rejects(ipo.launch(LAUNCH, true, EARNED), /did not answer after it was created; press IPO again/);
  const failed = await ipo.view(false, EARNED);
  assert.equal(failed.state, 'error');
  assert.equal(failed.awaiting, `${TOKEN_FACTORY} create_token`, 'the step that failed is named, so the board lights the right lamp');
  chain.lagAccounts(0);
  await assert.rejects(ipo.launch({ ceoAccountId: CEO, symbol: 'OTHER' }, false, EARNED), (e: Error) => e instanceof ConflictError && /already exist as ACME/.test(e.message));
  assert.equal(chain.calls.filter((c) => c.method === 'create_token').length, 1, 'no second token was paid for');
  chain.late.clear();
  const s = await ipo.launch(LAUNCH, false, EARNED);
  assert.equal(s.state, 'done');
  assert.equal(s.awaiting, null);
  assert.equal(chain.calls.filter((c) => c.method === 'create_token').length, 1);
});

test('a failed registration names its step', async () => {
  const { ipo, chain } = service();
  chain.failOn('storage_deposit');
  await assert.rejects(ipo.launch(LAUNCH, true, EARNED));
  assert.match((await ipo.view(false, EARNED)).awaiting!, / storage_deposit$/);
});

test('a wallet too short for a step is told how much to send, before anything is asked of OutLayer', async () => {
  const { ipo, chain } = service();
  chain.fund(5n * 10n ** 24n); // 5 NEAR: enough for the DAO and registrations, not for the token after them
  chain.approvals(true);
  let s = await ipo.launch(LAUNCH, true, EARNED);
  chain.decide(true); s = await ipo.launch(LAUNCH, true, EARNED);
  chain.decide(true); s = await ipo.launch(LAUNCH, true, EARNED);
  chain.decide(true);
  chain.fund(2209n * 10n ** 21n); // the 2026-11-10 mainnet run: 2.209 NEAR, the token costs 2.2284
  await assert.rejects(ipo.launch(LAUNCH, true, EARNED), /holds 2\.209 NEAR; tokens\.vibecity\.near create_token needs 2\.279 \(with gas\)\. Send 0\.07 NEAR/);
  assert.ok(!chain.sent.includes('create_token'), 'nothing was asked of OutLayer');
  s = await ipo.view(false, EARNED);
  assert.equal(s.state, 'error');
  chain.fund(3n * 10n ** 24n);
  s = await ipo.launch(LAUNCH, false, EARNED);
  assert.equal(s.awaiting, `${TOKEN_FACTORY} create_token`);
});

test('no NEAR price: the IPO does not start (the offering cannot be priced)', async () => {
  const chain = fakeChain();
  const ipo = new IpoService({ db: openDb(':memory:'), wallet: chain.wallet, rpc: chain.rpc, walletAccount: () => WALLET, companyName: () => 'Acme Labs', nearUsd: async () => { throw new Error('down'); }, pauseMs: 0 });
  assert.equal((await ipo.view(true, EARNED)).offer, null);
  await assert.rejects(ipo.launch(LAUNCH, true, EARNED), /NEAR price is unavailable/);
  assert.equal(chain.calls.length, 0);
});

test('a wallet that needs approvals: each step waits, Continue never sends a call twice, a rejection lets it start over', async () => {
  const { ipo, chain } = service();
  chain.approvals(true);
  let s = await ipo.launch(LAUNCH, true, EARNED);
  assert.equal(s.state, 'awaiting_approval');
  assert.equal(s.awaiting, 'sputnik-dao.near create');
  s = await ipo.launch(LAUNCH, false, EARNED); // Continue before approving: asks OutLayer, sends nothing
  assert.equal(s.state, 'awaiting_approval');
  assert.deepEqual(chain.sent, ['create']);

  chain.decide(true);
  s = await ipo.launch(LAUNCH, false, EARNED);
  assert.equal(s.awaiting, `${USDC} storage_deposit`, 'the DAO exists; the next step waits');
  assert.equal(s.daoAccountId, DAO);
  assert.deepEqual(s.txHashes, ['tx1']);

  chain.decide(false);
  await assert.rejects(ipo.launch(LAUNCH, false, EARNED), /rejected/);
  assert.equal((await ipo.view(false, EARNED)).state, 'error');
  chain.approvals(false);
  s = await ipo.launch(LAUNCH, false, EARNED);
  assert.equal(s.state, 'done');
  assert.deepEqual(chain.sent, ['create', 'storage_deposit', 'storage_deposit', 'storage_deposit', 'create_token']);

  chain.approvals(true);
  s = await ipo.endSale();
  assert.equal(s.proposals[0]!.awaitingWalletApproval, true);
  chain.decide(true);
  s = await ipo.view(true, EARNED);
  assert.equal(s.proposals[0]!.awaitingWalletApproval, false);
  assert.ok(s.proposals[0]!.id !== null && s.proposals[0]!.txHash, 'filed once approved');
});

test('shareholders are the buyers: the dividend is pro rata over what they hold, leaving out the DAO and the unsold float', async () => {
  const { ipo, chain } = service();
  await assert.rejects(ipo.dividend({ token: 'USDC', amount: 1 }), /not public/);
  await ipo.launch(LAUNCH, true, EARNED);
  await assert.rejects(ipo.dividend({ token: 'USDC', amount: 100 }), /move revenue into it first/);
  chain.setBal(USDC, DAO, units(500, 6)); // Treasury Ops moved revenue in
  await assert.rejects(ipo.dividend({ token: 'USDC', amount: 100 }), /Nobody holds ACME yet/);

  chain.buy(TOKEN, 'bob.near', 10_000);
  chain.buy(TOKEN, 'ann.near', 30_000);
  let s = await ipo.view(true, EARNED);
  assert.deepEqual(s.holders, [{ accountId: 'ann.near', balance: 30_000 }, { accountId: 'bob.near', balance: 10_000 }], 'largest first');
  assert.deepEqual(s.sale, { open: true, sold: 40_000, remaining: 360_000, raisedNear: 110, buyers: 2 });

  s = await ipo.dividend({ token: 'USDC', amount: 100 });
  const div = chain.calls.at(-1)!;
  assert.equal(div.receiver, DAO);
  assert.equal(div.method, 'add_proposal');
  assert.equal(div.deposit, '0', 'no bond');
  const fc = (div.args.proposal as Kind).kind.FunctionCall;
  assert.equal(fc.receiver_id, USDC);
  const transfers = fc.actions.filter((a) => a.method_name === 'ft_transfer').map((a) => decode(a.args));
  assert.deepEqual(transfers.map((t) => [t.receiver_id, t.amount]), [['ann.near', '75000000'], ['bob.near', '25000000']]);
  assert.equal(fc.actions.filter((a) => a.method_name === 'storage_deposit').length, 2, 'each holder is registered in the same proposal');

  s = await ipo.endSale();
  const end = (chain.calls.at(-1)!.args.proposal as Kind).kind.FunctionCall;
  assert.deepEqual([end.receiver_id, end.actions.map((a) => a.method_name)], [TOKEN, ['end_sale']]);
  assert.deepEqual(s.proposals.map((p) => p.kind), ['dividend', 'end_sale']);
  chain.sales.get(TOKEN)!.open = false; // the CEO approved it
  await assert.rejects(ipo.endSale(), /already closed/);
});

test('an IPO saved with an older token (no offering) keeps its DAO and creates the token again', async () => {
  const { ipo, chain, db } = service();
  db.prepare('INSERT INTO ipo (id, state_json) VALUES (1, ?)').run(JSON.stringify({
    ceoAccountId: CEO, symbol: 'ACME', daoAccountId: DAO, tokenAccountId: 'acme.tkn.near', txHashes: ['old'],
    proposals: [{ id: 0, kind: 'allocate', title: 'old', txHash: 'old', at: 'x' }], error: null, done: true, pending: null,
  }));
  chain.accounts.set(DAO, { amount: '1', codeHash: '1', globalCodeHash: null });
  const view = chain.rpc.view.bind(chain.rpc);
  chain.rpc.view = (async (c: string, m: string, a?: Record<string, unknown>) =>
    (m === 'get_policy' && c === DAO ? { roles: [{ name: 'Approver', kind: { Group: [CEO] } }, { name: 'Requestor', kind: { Group: [CEO, WALLET] } }] } : view(c, m, a))) as NearReader['view'];
  assert.equal((await ipo.view(false, EARNED)).state, 'ready');
  const s = await ipo.launch(LAUNCH, false, EARNED);
  assert.equal(s.state, 'done');
  assert.equal(s.tokenAccountId, TOKEN);
  assert.deepEqual(s.proposals, []);
  assert.equal(chain.calls.filter((c) => c.method === 'create').length, 0, 'the DAO is kept');
});

test('helpers: DAO name from the company, units, shares', () => {
  assert.equal(daoName('Acme Labs!'), 'acme-labs');
  assert.equal(daoName('é'), 'vibe-city-company');
  assert.equal(units(1.5, 6), 1_500_000n);
  assert.equal(units(0.1, 24), 10n ** 23n);
  assert.deepEqual(shares(100n, [{ accountId: 'a', balance: 1n }, { accountId: 'b', balance: 0n }], 3n), [{ accountId: 'a', amount: 33n }]);
});
