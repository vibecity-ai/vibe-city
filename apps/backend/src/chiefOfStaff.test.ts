import { test } from 'node:test';
import assert from 'node:assert/strict';
import { questApp } from './testUtils.ts';
import { FakeChatModel } from './model/chatModel.ts';
import type { PriceList } from './model/nearPrices.ts';

const KEY = 'sk-near-0123456789abcdef';
const prices = { list: async (): Promise<PriceList> => new Map([
  ['big/model-a', { inPerM: 2, outPerM: 8, context: 128000, vision: false }],
  ['small/model-b', { inPerM: 0.1, outPerM: 0.4, context: 64000, vision: false }],
]) };

test('the first quest: the CEO pastes a NEAR AI key and picks the Chief of Staff model; both are tried before saving', async (t) => {
  const saved = process.env.NEAR_AI_API_KEY; delete process.env.NEAR_AI_API_KEY;
  t.after(() => { if (saved !== undefined) process.env.NEAR_AI_API_KEY = saved; });
  const model = new FakeChatModel();
  const { app, readyDept, hermes } = questApp({ chatModel: model, modelPrices: prices, chatModelDefault: 'small/model-b' });
  const patch = (body: object) => app.inject({ method: 'PATCH', url: '/api/company/settings', payload: body });
  const quest = async () => (await app.inject('/api/game')).json().quests.find((q: { id: string }) => q.id === 'connect-ai');
  assert.equal((await quest()).done, false);
  assert.equal((await quest()).title, 'Set up your Chief of Staff');

  // the picker: NEAR AI's priced models, cheapest per day first, and the default in use until one is chosen
  const list = (await app.inject('/api/assistant/models')).json();
  assert.deepEqual(list.models.map((m: { id: string }) => m.id), ['small/model-b', 'big/model-a']);
  assert.deepEqual([list.current, list.chosen], ['small/model-b', false]);

  // a floor hired before the key exists gets it as soon as the key is saved
  const d = await readyDept('Ops');
  assert.equal((await patch({ chiefOfStaffModel: 'big/model-a' })).statusCode, 400, 'no key yet');
  const bad = await patch({ nearAiApiKey: 'bad-key', chiefOfStaffModel: 'big/model-a' });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().message, /rejected this API key/);
  assert.equal((await patch({ nearAiApiKey: KEY, chiefOfStaffModel: 'nope/never' })).statusCode, 400, 'only models NEAR AI offers');
  assert.equal((await app.inject('/api/company/settings')).json().nearAiApiKeySet, false, 'a failed try saves nothing');

  const ok = await patch({ nearAiApiKey: KEY, chiefOfStaffModel: 'big/model-a' });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual([ok.json().nearAiApiKeySet, ok.json().chiefOfStaffModel], [true, 'big/model-a']);
  assert.ok(!ok.body.includes(KEY) && !(await app.inject('/api/company/settings')).body.includes(KEY), 'the key never leaves the server');
  assert.deepEqual(model.checks.at(-1), { apiKey: KEY, model: 'big/model-a' }, 'tried together with the chosen model');
  assert.equal((await quest()).done, true);
  for (const p of d.refs) assert.equal(hermes.env.get(p)?.NEAR_AI_API_KEY, KEY, `${p} thinks with the pasted key`);
  const later = await readyDept('Later');
  for (const p of later.refs) assert.equal(hermes.env.get(p)?.NEAR_AI_API_KEY, KEY, `${p}, hired after, too`);

  // changing only the model later keeps the key, and is tried with it
  assert.equal((await patch({ chiefOfStaffModel: 'small/model-b' })).statusCode, 200);
  assert.deepEqual(model.checks.at(-1), { apiKey: KEY, model: 'small/model-b' });
  assert.deepEqual([(await app.inject('/api/assistant/models')).json().current, (await app.inject('/api/assistant/models')).json().chosen], ['small/model-b', true]);
});

test('the live chat model reads the pasted key and chosen model on every call, and says why a key fails', async () => {
  const { OpenAiCompatModel } = await import('./model/chatModel.ts');
  let key: string | null = null, chosen = 'small/model-b';
  const seen: Array<{ auth: string | null; model: string }> = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { model: string };
    const auth = new Headers(init.headers).get('authorization');
    seen.push({ auth, model: body.model });
    if (auth === 'Bearer bad') return new Response('{}', { status: 401 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 });
  }) as typeof globalThis.fetch;
  const m = new OpenAiCompatModel({ baseUrl: 'https://x/v1', apiKey: () => key, model: () => chosen, fetch });
  assert.equal(m.ready, false);
  key = 'good'; chosen = 'big/model-a';
  assert.equal(m.ready, true, 'no restart needed');
  await m.complete([{ role: 'user', content: 'hi' }]);
  assert.deepEqual(seen.at(-1), { auth: 'Bearer good', model: 'big/model-a' });
  await assert.rejects(m.check('bad', 'big/model-a'), /rejected this API key/);
  await m.check('good', 'small/model-b');
});
