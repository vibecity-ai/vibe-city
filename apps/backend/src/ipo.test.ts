import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db/db.ts';
import { DAO_DEPOSIT, IpoService, PAYOUT, TOKEN_FACTORY_HASH, TOKEN_HASH, daoName, shares, units } from './domain/ipoService.ts';
import type { AccountInfo, NearReader } from './near/rpc.ts';
import { ConflictError, UpstreamError } from './domain/errors.ts';

const WALLET = 'a'.repeat(64), CEO = 'boss.near', DAO = 'acme-labs.sputnik-dao.near', TOKEN = 'acme.tkn.near', USDC = PAYOUT.USDC.contract;
const decode = (b64: string) => JSON.parse(Buffer.from(b64, 'base64').toString());

/** A tiny mainnet: accounts, the DAO's policy, token balances, and what the company wallet's calls do to them. */
function fakeChain() {
  const accounts = new Map<string, AccountInfo>([['tkn.near', { amount: '0', codeHash: TOKEN_FACTORY_HASH, globalCodeHash: null }]]);
  const keys = new Map<string, number>();
  const policies = new Map<string, unknown>();
  const tokens = new Map<string, { owner_id: string }>();
  const ft = new Map<string, Map<string, bigint>>(); // contract -> account -> balance
  const registered = new Set<string>();
  const calls: { receiver: string; method: string; args: Record<string, unknown>; deposit: string }[] = [];
  let failNext: string | null = null;
  /** The wallet's OutLayer policy needs the owner's approval: calls queue until approve() runs them. */
  let needsApproval = false;
  const queued = new Map<string, () => { status: 'success'; txHash: string; result: unknown }>();
  const requests = new Map<string, 'pending' | 'rejected' | { status: 'success'; txHash: string; result: unknown }>();
  const bal = (c: string, a: string) => ft.get(c)?.get(a) ?? 0n;
  const setBal = (c: string, a: string, n: bigint) => { if (!ft.has(c)) ft.set(c, new Map()); ft.get(c)!.set(a, n); };
  const rpc: NearReader = {
    balance: async () => '0',
    account: async (id) => accounts.get(id) ?? null,
    keyCount: async (id) => keys.get(id) ?? 0,
    view: async <T>(contract: string, method: string, args: Record<string, unknown> = {}) => {
      if (method === 'get_policy') { if (!policies.has(contract)) throw new Error('no contract'); return policies.get(contract) as T; }
      if (method === 'get_token') return (tokens.get(String(args.token_id)) ?? null) as T;
      if (method === 'get_required_deposit') return '2233430000000000000000000' as T;
      if (method === 'storage_balance_of') return (registered.has(`${contract}:${args.account_id}`) ? { total: '1', available: '0' } : null) as T;
      if (method === 'ft_balance_of') return String(bal(contract, String(args.account_id))) as T;
      if (method === 'ft_total_supply') return String([...(ft.get(contract)?.values() ?? [])].reduce((a, b) => a + b, 0n)) as T;
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
        const a = args.args as { owner_id: string; total_supply: string; metadata: { symbol: string } };
        const id = a.metadata.symbol.toLowerCase();
        accounts.set(`${id}.tkn.near`, { amount: '0', codeHash: TOKEN_HASH, globalCodeHash: null });
        tokens.set(id, { owner_id: a.owner_id });
        setBal(`${id}.tkn.near`, a.owner_id, BigInt(a.total_supply));
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
  /** The owner approves (or rejects) every queued request in OutLayer. */
  const decide = (ok: boolean) => { for (const [id, run] of queued) { requests.set(id, ok ? run() : 'rejected'); queued.delete(id); } };
  return { rpc, wallet, calls, sent, accounts, keys, tokens, setBal, bal, failOn: (m: string) => { failNext = m; }, approvals: (on: boolean) => { needsApproval = on; }, decide };
}

function service(chain = fakeChain()) {
  const db = openDb(':memory:');
  const ipo = new IpoService({ db, wallet: chain.wallet, rpc: chain.rpc, walletAccount: () => WALLET, companyName: () => 'Acme Labs', pauseMs: 0 });
  return { ipo, chain, db };
}
const LAUNCH = { ceoAccountId: CEO, symbol: 'ACME' };

test('locked: 409 and nothing is called', async () => {
  const { ipo, chain } = service();
  assert.equal((await ipo.view(false)).state, 'locked');
  await assert.rejects(ipo.launch(LAUNCH, false), ConflictError);
  assert.equal(chain.calls.length, 0);
});

test('unlocked: creates the DAO (CEO approves, wallet only proposes), registers it, creates the token owned by the DAO', async () => {
  const { ipo, chain } = service();
  assert.equal((await ipo.view(true)).state, 'ready');
  const s = await ipo.launch(LAUNCH, true);
  assert.deepEqual(chain.calls.map((c) => `${c.receiver} ${c.method}`), [
    'sputnik-dao.near create', `${USDC} storage_deposit`, 'wrap.near storage_deposit', 'tkn.near create_token',
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
  assert.equal(tok.deposit, '2233430000000000000000000', 'exactly what the factory asks for');
  assert.deepEqual((tok.args.args as { owner_id: string }).owner_id, DAO);
  assert.equal((tok.args.args as { total_supply: string }).total_supply, '1000000000000');
  assert.equal(s.state, 'done');
  assert.equal(s.daoAccountId, DAO);
  assert.equal(s.tokenAccountId, TOKEN);
  assert.deepEqual(s.txHashes, ['tx1', 'tx2', 'tx3', 'tx4']);
  assert.ok(ipo.isDone());
  await assert.rejects(ipo.launch(LAUNCH, true), ConflictError, 'only once');
});

test('a failure between steps, then a retry (now locked: the IPO spent the funds) creates no second DAO', async () => {
  const { ipo, chain } = service();
  chain.failOn('create_token');
  await assert.rejects(ipo.launch(LAUNCH, true));
  const failed = await ipo.view(false);
  assert.equal(failed.state, 'error');
  assert.match(failed.error!, /timed out/);
  assert.equal(failed.daoAccountId, DAO);
  const s = await ipo.launch({ ceoAccountId: 'someone-else.near', symbol: 'ACME' }, false);
  assert.equal(s.state, 'done');
  assert.equal(chain.calls.filter((c) => c.method === 'create').length, 1);
  assert.equal(chain.calls.filter((c) => c.method === 'storage_deposit').length, 2, 'registrations are not repeated');
  assert.equal(s.ceoAccountId, CEO, 'the council is fixed once the DAO exists');
});

test('a DAO name or token symbol someone else owns is refused, not adopted', async () => {
  const chain = fakeChain();
  chain.accounts.set(DAO, { amount: '0', codeHash: '1', globalCodeHash: null });
  const { ipo } = service(chain);
  await assert.rejects(ipo.launch(LAUNCH, true), /not this company's DAO/);

  const chain2 = fakeChain();
  chain2.accounts.set(TOKEN, { amount: '0', codeHash: TOKEN_HASH, globalCodeHash: null });
  chain2.tokens.set('acme', { owner_id: 'squatter.near' });
  await assert.rejects(service(chain2).ipo.launch(LAUNCH, true), /belongs to someone else/);
  assert.equal(chain2.calls.filter((c) => c.method === 'create_token').length, 0);
});

test('a factory or token that is not the code we checked is not paid / not marked done', async () => {
  const chain = fakeChain();
  chain.accounts.set('tkn.near', { amount: '0', codeHash: 'other', globalCodeHash: null });
  const { ipo } = service(chain);
  await assert.rejects(ipo.launch(LAUNCH, true), /different code/);
  assert.equal(chain.calls.filter((c) => c.method === 'create_token').length, 0);

  const chain2 = fakeChain();
  const s2 = service(chain2);
  chain2.keys.set(TOKEN, 1);
  await assert.rejects(s2.ipo.launch(LAUNCH, true), /not the token code/);
  assert.equal(s2.ipo.isDone(), false);
});

test('allocate and dividend file one DAO proposal each; the dividend is pro rata and leaves out the DAO', async () => {
  const { ipo, chain } = service();
  await assert.rejects(ipo.allocate({ accountId: 'ann.near', amount: 1 }), /not public/);
  await ipo.launch(LAUNCH, true);
  let s = await ipo.allocate({ accountId: 'ann.near', amount: 30_000 });
  await ipo.allocate({ accountId: 'bob.near', amount: 10_000 });
  const alloc = chain.calls.at(-1)!;
  assert.equal(alloc.receiver, DAO);
  assert.equal(alloc.method, 'add_proposal');
  assert.equal(alloc.deposit, '0', 'no bond');
  const fc = (alloc.args.proposal as { kind: { FunctionCall: { receiver_id: string; actions: { method_name: string; args: string }[] } } }).kind.FunctionCall;
  assert.equal(fc.receiver_id, TOKEN);
  assert.deepEqual(fc.actions.map((a) => a.method_name), ['storage_deposit', 'ft_transfer']);
  assert.equal(decode(fc.actions[1]!.args).amount, '10000000000');

  // the CEO approves both in Trezu: the DAO's tokens move
  chain.setBal(TOKEN, DAO, units(960_000, 6));
  chain.setBal(TOKEN, 'ann.near', units(30_000, 6));
  chain.setBal(TOKEN, 'bob.near', units(10_000, 6));
  await assert.rejects(ipo.dividend({ token: 'USDC', amount: 100 }), /move revenue into it first/);
  chain.setBal(USDC, DAO, units(500, 6)); // Treasury Ops moved revenue in
  s = await ipo.dividend({ token: 'USDC', amount: 100 });
  const div = chain.calls.at(-1)!;
  const kind = (div.args.proposal as { kind: { FunctionCall: { receiver_id: string; actions: { method_name: string; args: string }[] } } }).kind.FunctionCall;
  assert.equal(kind.receiver_id, USDC);
  const transfers = kind.actions.filter((a) => a.method_name === 'ft_transfer').map((a) => decode(a.args));
  assert.deepEqual(transfers.map((t) => [t.receiver_id, t.amount]), [['ann.near', '75000000'], ['bob.near', '25000000']]);
  assert.equal(kind.actions.filter((a) => a.method_name === 'storage_deposit').length, 2, 'each holder is registered in the same proposal');
  assert.deepEqual(s.proposals.map((p) => p.kind), ['allocate', 'allocate', 'dividend']);
  assert.deepEqual(s.holders, [{ accountId: 'ann.near', balance: 30_000 }, { accountId: 'bob.near', balance: 10_000 }]);
});

test('helpers: DAO name from the company, units, shares', () => {
  assert.equal(daoName('Acme Labs!'), 'acme-labs');
  assert.equal(daoName('é'), 'vibe-city-company');
  assert.equal(units(1.5, 6), 1_500_000n);
  assert.equal(units(0.1, 24), 10n ** 23n);
  assert.deepEqual(shares(100n, [{ accountId: 'a', balance: 1n }, { accountId: 'b', balance: 0n }], 3n), [{ accountId: 'a', amount: 33n }]);
});

test('a wallet that needs approvals: each step waits, Continue never sends a call twice, a rejection lets it start over', async () => {
  const { ipo, chain } = service();
  chain.approvals(true);
  let s = await ipo.launch(LAUNCH, true);
  assert.equal(s.state, 'awaiting_approval');
  assert.equal(s.awaiting, 'sputnik-dao.near create');
  s = await ipo.launch(LAUNCH, false); // Continue before approving: asks OutLayer, sends nothing
  assert.equal(s.state, 'awaiting_approval');
  assert.deepEqual(chain.sent, ['create']);

  chain.decide(true); // the owner approves the create in OutLayer
  s = await ipo.launch(LAUNCH, false);
  assert.equal(s.awaiting, `${USDC} storage_deposit`, 'the DAO exists; the next step waits');
  assert.equal(s.daoAccountId, DAO);
  assert.deepEqual(s.txHashes, ['tx1']);

  chain.decide(false); // the owner rejects the registration
  await assert.rejects(ipo.launch(LAUNCH, false), /rejected/);
  assert.equal((await ipo.view(false)).state, 'error');
  chain.approvals(false);
  s = await ipo.launch(LAUNCH, false); // Retry: sends the rejected step again, and the rest
  assert.equal(s.state, 'done');
  assert.deepEqual(chain.sent, ['create', 'storage_deposit', 'storage_deposit', 'storage_deposit', 'create_token']);
  assert.equal(chain.calls.filter((c) => c.method === 'create').length, 1);

  chain.approvals(true);
  s = await ipo.allocate({ accountId: 'ann.near', amount: 5 });
  assert.equal(s.proposals[0]!.awaitingWalletApproval, true);
  chain.decide(true);
  s = await ipo.view(true);
  assert.equal(s.proposals[0]!.awaitingWalletApproval, false);
  assert.ok(s.proposals[0]!.id !== null && s.proposals[0]!.txHash, 'filed once approved');
});
