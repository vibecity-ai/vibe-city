import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db/db.ts';
import { buildServices } from './app.ts';
import { FakeHermes } from './testing/fakeHermes.ts';
import { createDept } from './testUtils.ts';
import { gameState } from './routes/game.ts';

const KEY = 'wk_' + 'a'.repeat(64), NEW_KEY = 'wk_' + 'b'.repeat(64), ADDR = 'c'.repeat(64);

/** A fake OutLayer: knows KEY (and NEW_KEY once registered), records calls, binding goes pending -> active on demand. */
function fakeOutlayer() {
  const calls: string[] = [];
  const o = { binding: null as null | { asset_account_id: string; binding_status: string }, bindConflict: false, setupUnavailable: false, usdc: '0', calls };
  const known = new Set([KEY]);
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch_ = (async (url: string, init: RequestInit = {}) => {
    const path = url.replace(/^https?:\/\/[^/]+/, ''), method = init.method ?? 'GET';
    calls.push(`${method} ${path}`);
    if (method === 'POST' && path === '/register') { known.add(NEW_KEY); return json(200, { api_key: NEW_KEY, wallet_id: 'w-new', near_account_id: ADDR, handoff_url: 'x' }); }
    const key = String((init.headers as Record<string, string>)?.Authorization ?? '').replace('Bearer ', '');
    if (!known.has(key)) return json(401, { error: 'invalid_api_key', message: 'Invalid or revoked API key' });
    if (path === '/wallet/v1/address?chain=near') return json(200, { wallet_id: 'w-1', chain: 'near', address: ADDR });
    if (path === '/wallet/v1/balance?chain=near') return json(200, { balance: '0', token: 'near', account_id: ADDR });
    if (path.startsWith('/wallet/v1/balance?token=17208628') && path.endsWith('&source=intents')) return json(200, { balance: o.usdc, token: 'nep141:usdc', account_id: ADDR });
    if (path === '/wallet/v1/binding' && method === 'GET') return o.binding ? json(200, o.binding) : json(404, { error: 'not_found' });
    if (path === '/wallet/v1/binding' && method === 'PUT') {
      if (o.bindConflict) return json(409, { message: 'account already has a contract' });
      o.binding = { asset_account_id: JSON.parse(String(init.body)).asset_account_id, binding_status: 'pending' };
      return json(200, { ...o.binding, executor_account_id: ADDR });
    }
    if (path === '/wallet/v1/binding/setup?kind=personal_account') {
      return o.setupUnavailable
        ? json(400, { error: 'bad_request', message: 'the wallet contract (code hash X) is not published on this network, so the setup transaction could not succeed' })
        : json(200, { actions: [] });
    }
    if (path === '/wallet/v1/binding/balance') return json(200, { balance: '5000000000000000000000000', token: 'near' });
    return json(404, {});
  }) as typeof fetch;
  return Object.assign(o, { fetch: fetch_ });
}

function setup() {
  const db = openDb(':memory:'), hermes = new FakeHermes(), outlayer = fakeOutlayer();
  const services = buildServices(db, hermes, { outlayerFetch: outlayer.fetch }), { app } = services;
  const hire = async (name: string, template: string) => {
    const { json } = await createDept(app, { name, template });
    const prov = (await app.inject({ method: 'POST', url: `/api/departments/${json.id}/provision` })).json();
    assert.equal(prov.state, 'ready', JSON.stringify(prov));
    return (prov.agents as { ref: string }[]).map((a) => a.ref);
  };
  // fresh: /api/game caches 5 s, and a signature on OutLayer's page reaches us only on the next read
  const treasuryDone = async () => (await gameState(services, true)).quests.find((q) => q.id === 'treasury')!.done;
  return { app, hermes, outlayer, hire, treasuryDone };
}

test('a pasted wallet key is checked with OutLayer, never returned, and reaches only company-wallet floors', async () => {
  const { app, hermes, hire, outlayer } = setup();
  outlayer.usdc = '5000000'; // the CEO funded 5 USDC to the wallet's Intents balance
  const trading = await hire('Trading', 'trading-desk'), software = await hire('Software', 'software');
  assert.deepEqual((await app.inject('/api/wallet')).json().registered, false);

  const bad = await app.inject({ method: 'POST', url: '/api/wallet/key', payload: { apiKey: 'wk_' + 'f'.repeat(64) } });
  assert.equal(bad.statusCode, 400, 'OutLayer does not know it');
  assert.equal((await app.inject({ method: 'POST', url: '/api/wallet/key', payload: { apiKey: 'sk_nope' } })).statusCode, 400, 'not a wk_ key');
  assert.equal((await app.inject('/api/wallet')).json().registered, false, 'nothing stored');

  const r = await app.inject({ method: 'POST', url: '/api/wallet/key', payload: { apiKey: KEY } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().registered, true);
  assert.equal(r.json().accountId, ADDR);
  assert.deepEqual(r.json().balances, [{ token: 'near', amount: '0', source: 'wallet' }, { token: 'usdc', amount: '5000000', source: 'intents' }], 'USDC funded to Intents shows');
  for (const url of ['/api/wallet', '/api/company/settings', '/api/game']) assert.ok(!(await app.inject(url)).body.includes(KEY), `${url} never carries the key`);
  for (const p of trading) assert.deepEqual(hermes.env.get(p), { ...hermes.env.get(p), OUTLAYER_API_KEY: KEY, OUTLAYER_WALLET_ID: 'w-1' });
  for (const p of software) assert.equal(hermes.env.get(p)?.OUTLAYER_API_KEY, undefined, 'a wallet: none floor never gets it');
});

test('binding registers a wallet, returns the connect page once, and the treasury quest is done when it is active', async () => {
  const { app, outlayer, treasuryDone } = setup();
  assert.equal(await treasuryDone(), false);
  const r = await app.inject({ method: 'POST', url: '/api/wallet/bind', payload: { accountId: 'ceo.near' } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().connectUrl, `https://app.outlayer.ai/wallet/connect?key=${NEW_KEY}`);
  assert.deepEqual(outlayer.calls.slice(0, 3), ['POST /register', 'PUT /wallet/v1/binding', 'GET /wallet/v1/binding/setup?kind=personal_account']);

  const pending = (await app.inject('/api/wallet')).json();
  assert.deepEqual(pending.binding, { accountId: 'ceo.near', status: 'pending' });
  assert.ok(!JSON.stringify(pending).includes(NEW_KEY));
  assert.equal(await treasuryDone(), false, 'pending with an empty wallet is not a treasury yet');

  outlayer.binding!.binding_status = 'active'; // the CEO signed on OutLayer's page
  const active = (await app.inject('/api/wallet')).json();
  assert.equal(active.binding.status, 'active');
  assert.deepEqual(active.balances[0], { token: 'near', amount: '5000000000000000000000000', source: 'bound' });
  assert.equal(await treasuryDone(), true);
});

test('binding an account that already runs a contract is a 409, and the account id must be a NEAR account', async () => {
  const { app, outlayer } = setup();
  outlayer.bindConflict = true;
  assert.equal((await app.inject({ method: 'POST', url: '/api/wallet/bind', payload: { accountId: 'ceo.near' } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: '/api/wallet/bind', payload: { accountId: 'not an account' } })).statusCode, 400);
});

test('when OutLayer cannot build the signing transaction, bind says why instead of returning a dead signing page', async () => {
  const { app, outlayer } = setup();
  outlayer.setupUnavailable = true;
  const r = await app.inject({ method: 'POST', url: '/api/wallet/bind', payload: { accountId: 'ceo.near' } });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().message, /not published on this network/);
  assert.ok(!r.body.includes('connect?key='), 'no signing page');
  // the wallet it registered can still be replaced by pasting a key
  assert.equal((await app.inject({ method: 'POST', url: '/api/wallet/key', payload: { apiKey: KEY } })).statusCode, 200);
  assert.equal((await app.inject('/api/wallet')).json().accountId, ADDR);
});
