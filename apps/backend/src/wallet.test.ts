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
  const o = { binding: null as null | { asset_account_id: string; binding_status: string }, bindConflict: false, setupUnavailable: false, usdc: '0', usdt: '0', policy: { hyperliquid: false, polymarket: false } as Record<string, boolean>, trialClaimed: false, calls };
  const known = new Set([KEY]);
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const USDC_ID = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', USDT_ID = 'nep141:usdt.tether-token.near';
  const fetch_ = (async (url: string, init: RequestInit = {}) => {
    // NEAR Intents: the 1Click token list, intents.near's balances (one view call), CoinGecko logos
    if (url === 'https://1click.chaindefuser.com/v0/tokens') return json(200, [
      { assetId: 'nep141:wrap.near', symbol: 'wNEAR', decimals: 24, blockchain: 'near', price: 4, coingeckoId: 'wrapped-near' },
      { assetId: USDC_ID, symbol: 'USDC', decimals: 6, blockchain: 'near', price: 1, coingeckoId: 'usd-coin' },
      { assetId: USDT_ID, symbol: 'USDT', decimals: 6, blockchain: 'near', price: 1, coingeckoId: 'tether' },
    ]);
    if (url.startsWith('https://rpc.mainnet.fastnear.com')) {
      const q = JSON.parse(String(init.body)).params, args = JSON.parse(Buffer.from(q.args_base64, 'base64').toString());
      assert.equal(`${q.account_id}.${q.method_name}.${args.account_id}`, `intents.near.mt_batch_balance_of.${ADDR}`);
      const bal: Record<string, string> = { [USDC_ID]: o.usdc, [USDT_ID]: o.usdt };
      return json(200, { result: { result: [...Buffer.from(JSON.stringify(args.token_ids.map((id: string) => bal[id] ?? '0')))] } });
    }
    if (url.startsWith('https://api.coingecko.com/')) return json(200, [{ id: 'tether', image: 'https://img.test/usdt.png' }, { id: 'near', image: 'https://img.test/near.png' }]);
    const path = url.replace(/^https?:\/\/[^/]+/, ''), method = init.method ?? 'GET';
    calls.push(`${method} ${path}`);
    if (method === 'POST' && path === '/register') { known.add(NEW_KEY); return json(200, { api_key: NEW_KEY, wallet_id: 'w-new', near_account_id: ADDR, handoff_url: 'x' }); }
    const h = (init.headers ?? {}) as Record<string, string>;
    const connector = path.match(/^\/call\/connectors\.outlayer\.near\/(\w+)$/)?.[1];
    if (connector) {
      // pays with the trial key, names the wallet; the policy is the owner's row, stored at app.outlayer.ai/connect/<name>
      if (h['X-Payment-Key'] !== 'pk-trial' || h['X-Wallet-Id'] !== 'w-1') return json(402, { error: 'payment_required' });
      return json(200, { status: 'completed', output: { success: true, operation: 'status', output: { policy: { present: o.policy[connector] } } } });
    }
    const key = String(h.Authorization ?? '').replace('Bearer ', '');
    if (!known.has(key)) return json(401, { error: 'invalid_api_key', message: 'Invalid or revoked API key' });
    if (path === '/wallet/v1/address?chain=near') return json(200, { wallet_id: 'w-1', chain: 'near', address: ADDR });
    if (path === '/wallet/v1/balance?chain=near') return json(200, { balance: '0', token: 'near', account_id: ADDR });
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
    if (path === '/subscription/status') return json(200, { trial: { calls: 50, calls_used: 3, calls_left: 47 } });
    if (path === '/wallet/v1/payment-key') return o.trialClaimed ? json(200, { payment_key: 'pk-trial' }) : json(404, { error: 'no_payment_key' });
    if (path === '/trial-key' && method === 'POST') { o.trialClaimed = true; return json(200, { payment_key: 'pk-trial', calls: 50 }); }
    if (path === '/wallet/v1/binding/balance') return json(200, { balance: '5000000000000000000000000', token: 'near' });
    return json(404, {});
  }) as typeof fetch;
  return Object.assign(o, { fetch: fetch_ });
}

function setup() {
  const db = openDb(':memory:'), hermes = new FakeHermes(), outlayer = fakeOutlayer();
  const services = buildServices(db, hermes, { outlayerFetch: outlayer.fetch }), { app } = services;
  const hire = async (name: string, template: string) => {
    const { json } = await createDept(app, { name, ...(template ? { template } : {}) });
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
  outlayer.usdc = '5000000'; // the CEO funded 5 USDC and 12 USDT to the wallet's Intents balance
  outlayer.usdt = '12000000';
  const trading = await hire('Trading', 'trading-desk'), agency = await hire('Research', ''); // a custom floor: no company wallet
  assert.deepEqual((await app.inject('/api/wallet')).json().registered, false);

  const bad = await app.inject({ method: 'POST', url: '/api/wallet/key', payload: { apiKey: 'wk_' + 'f'.repeat(64) } });
  assert.equal(bad.statusCode, 400, 'OutLayer does not know it');
  assert.equal((await app.inject({ method: 'POST', url: '/api/wallet/key', payload: { apiKey: 'sk_nope' } })).statusCode, 400, 'not a wk_ key');
  assert.equal((await app.inject('/api/wallet')).json().registered, false, 'nothing stored');

  const r = await app.inject({ method: 'POST', url: '/api/wallet/key', payload: { apiKey: KEY } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().registered, true);
  assert.equal(r.json().accountId, ADDR);
  assert.deepEqual(r.json().balances, [
    { token: 'USDT', amount: '12000000', decimals: 6, source: 'intents', chain: 'near', usd: 12, logo: 'https://img.test/usdt.png' },
    { token: 'USDC', amount: '5000000', decimals: 6, source: 'intents', chain: 'near', usd: 5, logo: null },
  ], 'every non-zero Intents token, largest first; the empty gas account and wNEAR are left out');
  for (const url of ['/api/wallet', '/api/company/settings', '/api/game']) assert.ok(!(await app.inject(url)).body.includes(KEY), `${url} never carries the key`);
  for (const p of trading) assert.deepEqual(hermes.env.get(p), { ...hermes.env.get(p), OUTLAYER_API_KEY: KEY, OUTLAYER_WALLET_ID: 'w-1' });
  for (const p of agency) assert.equal(hermes.env.get(p)?.OUTLAYER_API_KEY, undefined, 'a floor without the company wallet never gets it');
});

test('binding registers a wallet, returns the connect page once, and the treasury quest is done once the wallet is registered', async () => {
  const { app, outlayer, treasuryDone } = setup();
  assert.equal(await treasuryDone(), false);
  const r = await app.inject({ method: 'POST', url: '/api/wallet/bind', payload: { accountId: 'ceo.near' } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().connectUrl, `https://app.outlayer.ai/wallet/connect?key=${NEW_KEY}`);
  assert.deepEqual(outlayer.calls.slice(0, 3), ['POST /register', 'PUT /wallet/v1/binding', 'GET /wallet/v1/binding/setup?kind=personal_account']);

  const pending = (await app.inject('/api/wallet')).json();
  assert.deepEqual(pending.binding, { accountId: 'ceo.near', status: 'pending' });
  assert.ok(!JSON.stringify(pending).includes(NEW_KEY));
  assert.equal(await treasuryDone(), true, 'a registered wallet is a treasury: funding is optional');

  outlayer.binding!.binding_status = 'active'; // the CEO signed on OutLayer's page
  const active = (await app.inject('/api/wallet')).json();
  assert.equal(active.binding.status, 'active');
  const { usd, ...bound } = active.balances[0];
  assert.deepEqual(bound, { token: 'NEAR', amount: '5000000000000000000000000', decimals: 24, source: 'bound', chain: 'near', logo: 'https://img.test/near.png' });
  assert.equal(Math.round(usd), 20, '5 NEAR priced at the wNEAR price');
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

test('Connect Hyperliquid is done only when OutLayer reports the owner\'s policy; each check is one status call', async (t) => {
  const saved = process.env.NEAR_AI_API_KEY; process.env.NEAR_AI_API_KEY = 'k'; // hiring itself waits for NEAR AI
  t.after(() => { if (saved === undefined) delete process.env.NEAR_AI_API_KEY; else process.env.NEAR_AI_API_KEY = saved; });
  const { app, outlayer } = setup();
  await app.inject({ method: 'PATCH', url: '/api/company/settings', payload: { chiefOfStaffModel: 'deepseek/deepseek-v4.1-flash' } });
  const check = (name: string) => app.inject({ method: 'POST', url: `/api/wallet/connectors/${name}/check` });
  assert.equal((await check('hyperliquid')).statusCode, 400, 'no wallet yet');
  await app.inject({ method: 'POST', url: '/api/wallet/key', payload: { apiKey: KEY } });
  const locked = async () => (await app.inject('/api/templates')).json().find((t: { id: string }) => t.id === 'trading-desk').locked;
  assert.equal(await locked(), true);

  const no = (await check('hyperliquid')).json();
  assert.equal(no.connected, false);
  assert.match(no.message, new RegExp(`app\\.outlayer\\.ai/connect/hyperliquid.*${ADDR}`), 'says where to go and which account to enter');
  assert.match(no.message, /built-in default/);
  assert.match(no.message, /47 left/, 'says what the check cost');
  assert.equal(outlayer.calls.filter((c) => c === 'POST /trial-key').length, 1, 'the trial key is claimed once');

  outlayer.policy.hyperliquid = true; // the CEO stored the caps on OutLayer's page
  assert.equal((await check('hyperliquid')).json().connected, true);
  assert.equal(outlayer.calls.filter((c) => c === 'POST /trial-key').length, 1, 'then read back, not claimed again');
  assert.equal(await locked(), false, 'the Trading Desk can be hired');
  const quests = (await app.inject('/api/game')).json().quests;
  assert.equal(quests.find((q: { id: string }) => q.id === 'connect-hyperliquid').done, true);
  assert.equal(quests.find((q: { id: string }) => q.id === 'connect-polymarket').done, false, 'each connector on its own');
  assert.equal((await check('gmail')).statusCode, 400, 'only the trading connectors');
});
