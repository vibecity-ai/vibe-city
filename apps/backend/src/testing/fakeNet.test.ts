import { test } from 'node:test';
import assert from 'node:assert/strict';
import { questApp } from '../testUtils.ts';
import { gameState } from '../routes/game.ts';
import { DEMO_WALLET, FakeNet } from './fakeNet.ts';

test('the offline demo plays the whole game: wallet, connectors, a market job, the IPO and a dividend, with nothing on the network', async () => {
  const net = new FakeNet();
  const { app, kanban, readyDept, services } = questApp({ outlayerFetch: net.fetch, marketFetch: net.fetch, nearRpc: net.rpc });
  const done = async (id: string) => (await gameState(services, true)).quests.find((q) => q.id === id)!.done;

  // the safe: any wk_ key opens the demo wallet, with NEAR for gas and USDC on Intents
  const w = (await app.inject({ method: 'POST', url: '/api/wallet/key', payload: { apiKey: `wk_${'d'.repeat(32)}` } })).json();
  assert.equal(w.accountId, DEMO_WALLET);
  assert.deepEqual(w.balances.map((b: { token: string; source: string }) => `${b.token}/${b.source}`).sort(), ['NEAR/wallet', 'USDC/intents']);
  assert.ok(await done('treasury'));
  assert.ok(await done('dao-funds'), '6 NEAR in the wallet funds the IPO');
  assert.equal((await app.inject({ method: 'POST', url: '/api/wallet/connectors/hyperliquid/check' })).json().connected, true);

  // the market: register, claim (code, then redeemed), live, a job, its delivery, paid
  const d = await readyDept('Copy Desk');
  const reg = await app.inject({ method: 'POST', url: '/api/market/register', payload: { handle: 'copy-desk', name: 'Copy Desk', category: 'creative', departmentId: d.id } });
  assert.equal(reg.statusCode, 200, reg.body);
  assert.ok(reg.json().agents[0].verifiedAt);
  assert.equal((await app.inject({ method: 'POST', url: `/api/market/${d.id}/adoption` })).json().code, 'DEMO-AG-1');
  assert.equal((await app.inject({ method: 'POST', url: `/api/market/${d.id}/adoption` })).json().adopted, true);
  net.tick();
  assert.equal((await app.inject(`/api/market/${d.id}/profile`)).json().listingStatus, 'live');
  net.tick();
  await services.market.tick();
  const job = services.market.view().jobs[0]!;
  assert.equal(job.state, 'working');
  kanban.complete(d.board, job.questId, 'Three headlines that sell coffee.');
  await services.market.tick();
  assert.equal(services.market.view().jobs[0]!.state, 'submitted');
  net.tick();
  await services.market.tick();
  assert.equal(services.market.view().jobs[0]!.state, 'accepted');
  assert.ok(await done('first-job'));
  assert.equal((await gameState(services, true)).ipoUnlocked, true);

  // the IPO: DAO, registrations and the city token on the fake chain; investors buy; a dividend is proposed
  const ipo = await app.inject({ method: 'POST', url: '/api/ipo', payload: { ceoAccountId: 'boss.near', symbol: 'MYCO' } });
  assert.equal(ipo.statusCode, 200, ipo.body);
  assert.equal(ipo.json().state, 'done');
  assert.equal(ipo.json().tokenAccountId, 'myco.tokens.vibecity.near');
  net.tick();
  const after = (await app.inject('/api/ipo')).json();
  assert.equal(after.holders.length, 1);
  assert.ok(after.sale.sold > 0);
  const div = await app.inject({ method: 'POST', url: '/api/ipo/dividend', payload: { token: 'USDC', amount: 10 } });
  assert.equal(div.statusCode, 200, div.body);
  assert.equal(div.json().proposals.length, 1);
});
