import { test } from 'node:test';
import assert from 'node:assert/strict';
import { questApp } from './testUtils.ts';
import { aiKeyFor } from './routes/ai.ts';
import { setSecrets } from './routes/company.ts';
import type { PriceList } from './model/nearPrices.ts';

const KEY = 'sk-near-0123456789abcdef';
const prices = { list: async (): Promise<PriceList> => new Map([['m/one', { inPerM: 2, outPerM: 10, context: 1000, vision: false }]]) };
const usage = { prompt_tokens: 1_000_000, completion_tokens: 100_000 }; // $2 + $1

test('metering proxy: forwards with the company key, records burn per floor, enforces the daily budget', async () => {
  const seen: Array<{ url: string; auth: string | null; body: any }> = [];
  const upstream = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : null;
    seen.push({ url, auth: new Headers(init.headers).get('authorization'), body });
    if (body?.stream) {
      const sse = [{ id: 'r2', choices: [{ delta: { content: 'hi' } }] }, { id: 'r2', choices: [], usage }].map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
      return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
    }
    return Response.json({ id: 'r1', model: 'm/one', choices: [{ message: { content: 'hi' } }], usage });
  }) as typeof fetch;
  const { app, db, hermes, readyDept } = questApp({ modelPrices: prices, aiProxy: { publicUrl: 'http://vc.test', upstreamUrl: 'http://near.test/v1/', fetch: upstream } });
  setSecrets(db, { nearAiApiKey: KEY });
  const a = await readyDept('A', { limits: { dailyBudgetCredits: 500 } }), b = await readyDept('B');
  const call = (dept: string, body: object, auth = `Bearer ${aiKeyFor(db, dept)}`) =>
    app.inject({ method: 'POST', url: '/ai/v1/chat/completions', headers: { authorization: auth }, payload: body });

  // provisioning: every profile holds its floor's pseudo key and points NEAR AI at the proxy; the company key stays here
  for (const p of a.refs) {
    assert.equal(hermes.env.get(p)?.NEAR_AI_API_KEY, aiKeyFor(db, a.id));
    assert.equal(hermes.providerUrls.get(`${p}/near-ai`), 'http://vc.test/ai/v1');
  }
  assert.notEqual(aiKeyFor(db, a.id), aiKeyFor(db, b.id));

  for (const auth of [`Bearer ${KEY}`, `Bearer vc_ai_${a.id}_${'0'.repeat(64)}`, `Bearer ${aiKeyFor(db, 'gone')}`]) assert.equal((await call(a.id, { model: 'm/one' }, auth)).statusCode, 401);
  assert.equal(seen.length, 0, 'an unknown key reaches nothing');

  const plain = await call(a.id, { model: 'm/one', messages: [] });
  assert.equal(plain.json().id, 'r1');
  assert.deepEqual([seen[0]!.url, seen[0]!.auth], ['http://near.test/v1/chat/completions', `Bearer ${KEY}`]);
  const today = async () => Object.fromEntries((await app.inject('/api/ai/usage')).json().byDepartment.map((d: any) => [d.departmentId, d.todayCents]));
  assert.deepEqual([(await today())[a.id], (await today())[b.id]], [300, 0]);

  const stream = await call(a.id, { model: 'm/one', stream: true });
  assert.match(stream.body, /"content":"hi"[\s\S]*\[DONE\]/, 'the stream passes through whole');
  assert.deepEqual(seen[1]!.body.stream_options, { include_usage: true });
  assert.equal((await today())[a.id], 600);

  // 600 of 500 cents: refused before NEAR AI is called; the other floor still works
  const over = await call(a.id, { model: 'm/one' });
  assert.deepEqual([over.statusCode, over.json().error.type, seen.length], [429, 'budget', 2]);
  assert.equal((await call(b.id, { model: 'm/one' })).statusCode, 200);

  // the runway finally has a burn to divide by
  await app.inject({ method: 'PATCH', url: '/api/company/settings', payload: { nearAiCreditsLoadedCents: 2800 } });
  const r = (await app.inject('/api/game')).json().runway;
  assert.deepEqual([r.creditsRemainingCents, Math.round(r.dailyBurnCents), r.days], [1900, 129, 14]);
});

test('metering proxy: prompt tokens NEAR AI served from its cache cost the cache price', async () => {
  const cachedPrices = { list: async (): Promise<PriceList> => new Map([
    ['m/cache', { inPerM: 2, outPerM: 10, cachedPerM: 0.2, context: 1000, vision: false }],
    ['m/one', { inPerM: 2, outPerM: 10, context: 1000, vision: false }],
  ]) };
  const answer = { id: 'r', usage: { ...usage, prompt_tokens_details: { cached_tokens: 900_000 } } };
  const { app, db, readyDept } = questApp({ modelPrices: cachedPrices, aiProxy: { publicUrl: 'http://vc.test', upstreamUrl: 'http://near.test/v1', fetch: (async () => Response.json(answer)) as typeof fetch } });
  setSecrets(db, { nearAiApiKey: KEY });
  const a = await readyDept('A'), b = await readyDept('B');
  for (const [d, model] of [[a.id, 'm/cache'], [b.id, 'm/one']] as const) {
    await app.inject({ method: 'POST', url: '/ai/v1/chat/completions', headers: { authorization: `Bearer ${aiKeyFor(db, d)}` }, payload: { model } });
  }
  const today = Object.fromEntries((await app.inject('/api/ai/usage')).json().byDepartment.map((d: any) => [d.departmentId, d.todayCents]));
  // 100k fresh x $2 + 900k cached x $0.20 + 100k out x $10 = $1.38; a model without a cache price bills all input in full
  assert.deepEqual([today[a.id], today[b.id]], [138, 300]);
});
