import { test } from 'node:test';
import assert from 'node:assert/strict';
import { questApp } from './testUtils.ts';
import { describeKind, formatNear, NearAiCredits } from './domain/moneyService.ts';
import { NearRpc, NearRpcError, type NearReader } from './near/rpc.ts';

const NEAR = 10n ** 24n;
/** A tiny fake chain: two accounts and a Sputnik DAO with two proposals. */
function fakeChain(): NearReader {
  const balances: Record<string, bigint> = { 'boss.near': 12n * NEAR + NEAR / 2n, 'acme.sputnik-dao.near': 250n * NEAR };
  return {
    async balance(id) { if (!(id in balances)) throw new NearRpcError('This account does not exist on this network.'); return balances[id]!.toString(); },
    async view(contract, method, args) {
      if (contract !== 'acme.sputnik-dao.near') throw new NearRpcError('This account has no contract (is it a Sputnik DAO?).');
      if (method === 'get_policy') return { proposal_bond: (NEAR / 10n).toString(), roles: [{ name: 'council', kind: { Group: ['boss.near', 'cto.near'] } }, { name: 'all', kind: 'Everyone' }] } as never;
      if (method === 'get_last_proposal_id') return 2 as never;
      if (method === 'get_proposals') {
        assert.deepEqual(args, { from_index: 0, limit: 10 });
        return [
          { id: 0, proposer: 'boss.near', description: 'Pay the designer', kind: { Transfer: { token_id: '', receiver_id: 'design.near', amount: (5n * NEAR).toString() } }, status: 'Approved', vote_counts: { council: [2, 0, 0] }, submission_time: '1793900000000000000' },
          { id: 1, proposer: 'cto.near', description: 'Add a signer', kind: { AddMemberToRole: { member_id: 'cfo.near', role: 'council' } }, status: 'InProgress', vote_counts: { council: [1, 0, 0] }, submission_time: '1793990000000000000' },
        ] as never;
      }
      throw new Error('unknown method ' + method);
    },
  };
}

test('the safe: wallets, treasury mirror and credits are read separately; nothing is stored but public ids', async () => {
  const { app } = questApp({ money: { credits: { configured: false, read: async () => { throw new Error('x'); } }, reader: () => ({ url: 'fake://rpc', rpc: fakeChain() }) } });
  let v = (await app.inject('/api/money')).json();
  assert.deepEqual(v.settings, { network: 'mainnet', daoAccountId: null, trezuUrl: null });
  assert.deepEqual(v.wallets, []);
  assert.equal(v.treasury, null);
  assert.equal(v.credits.connected, false);

  assert.equal((await app.inject({ method: 'POST', url: '/api/money/wallets', payload: { accountId: 'Not An Account!' } })).statusCode, 400);
  v = (await app.inject({ method: 'POST', url: '/api/money/wallets', payload: { accountId: 'boss.near' } })).json();
  assert.deepEqual(v.wallets, [{ accountId: 'boss.near', primary: true, balance: (12n * NEAR + NEAR / 2n).toString(), error: null }]);
  v = (await app.inject({ method: 'POST', url: '/api/money/wallets', payload: { accountId: 'ghost.near' } })).json();
  assert.equal(v.wallets[1].primary, false);
  assert.match(v.wallets[1].error, /does not exist/);
  v = (await app.inject({ method: 'POST', url: '/api/money/wallets/ghost.near/primary' })).json();
  assert.equal(v.wallets.find((w: any) => w.primary).accountId, 'ghost.near');
  v = (await app.inject({ method: 'DELETE', url: '/api/money/wallets/ghost.near' })).json();
  assert.deepEqual(v.wallets.map((w: any) => [w.accountId, w.primary]), [['boss.near', true]], 'the remaining wallet becomes primary');

  await app.inject({ method: 'PATCH', url: '/api/money/settings', payload: { daoAccountId: 'acme.sputnik-dao.near', trezuUrl: 'https://trezu.app' } });
  v = (await app.inject('/api/money?fresh=1')).json();
  assert.equal(v.treasury.balance, (250n * NEAR).toString());
  assert.equal(v.treasury.proposalBond, (NEAR / 10n).toString());
  assert.deepEqual(v.treasury.roles, [{ name: 'council', members: 2 }, { name: 'all', members: null }]);
  assert.deepEqual(v.treasury.proposals.map((p: any) => [p.id, p.kind, p.status, p.approve]), [[1, 'Add cfo.near as council', 'InProgress', 1], [0, 'Transfer 5 NEAR to design.near', 'Approved', 2]]);
  assert.equal(v.treasury.error, null);

  await app.inject({ method: 'PATCH', url: '/api/money/settings', payload: { daoAccountId: 'boss.near' } });
  v = (await app.inject('/api/money?fresh=1')).json();
  assert.match(v.treasury.error, /no contract/);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/money/settings', payload: { network: 'devnet' } })).statusCode, 400);
});

test('credits from NEAR AI Cloud: amounts, and an expired token reported in words', async () => {
  const calls: string[] = [];
  const ok = new NearAiCredits({ baseUrl: 'https://cloud-api.near.ai/v1', orgId: 'org_1', token: 'jwt', fetch: (async (url: string, init: RequestInit) => {
    calls.push(`${url} ${(init.headers as Record<string, string>).authorization}`);
    return new Response(JSON.stringify({ total_spent: 12_340_000_000, total_spent_display: '$12.34', remaining: 87_660_000_000, total_requests: 412, total_tokens: 900000, last_usage_at: '2026-11-05T10:00:00Z' }), { status: 200 });
  }) as typeof fetch });
  const r = await ok.read();
  assert.deepEqual(calls, ['https://cloud-api.near.ai/v1/organizations/org_1/usage/balance Bearer jwt']);
  assert.deepEqual(r, { remaining: '$87.66', spent: '$12.34', requests: 412, tokens: 900000, lastUsageAt: '2026-11-05T10:00:00Z' });
  const bad = new NearAiCredits({ baseUrl: 'https://cloud-api.near.ai/v1', orgId: 'o', token: 't', fetch: (async () => new Response('{}', { status: 401 })) as typeof fetch });
  await assert.rejects(bad.read(), /expired/);
  const { app } = questApp({ money: { credits: bad, reader: () => ({ url: 'fake', rpc: fakeChain() }) } });
  const v = (await app.inject('/api/money')).json();
  assert.equal(v.credits.connected, true);
  assert.match(v.credits.error, /rejected the access token/);
});

test('NEAR RPC client: view calls are base64 JSON in and bytes out; errors are plain words', async () => {
  const sent: any[] = [];
  const rpc = new NearRpc('https://rpc.example', { fetch: (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); sent.push(body.params);
    if (body.params.request_type === 'view_account') return new Response(JSON.stringify({ error: { cause: { name: 'UNKNOWN_ACCOUNT' } } }));
    return new Response(JSON.stringify({ result: { result: [...Buffer.from(JSON.stringify({ ok: 1 }))] } }));
  }) as typeof fetch });
  assert.deepEqual(await rpc.view('dao.near', 'get_policy', { a: 1 }), { ok: 1 });
  assert.equal(Buffer.from(sent[0].args_base64, 'base64').toString(), '{"a":1}');
  assert.equal(sent[0].finality, 'final');
  await assert.rejects(rpc.balance('nobody.near'), /does not exist/);
  assert.equal(formatNear((12n * NEAR + NEAR / 2n).toString()), '12.5');
  assert.equal(formatNear('0'), '0');
  assert.equal(describeKind('ChangeConfig'), 'Change Config');
});
