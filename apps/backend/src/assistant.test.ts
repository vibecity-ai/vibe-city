import { test } from 'node:test';
import assert from 'node:assert/strict';
import { questApp } from './testUtils.ts';
import { FakeChatModel } from './model/chatModel.ts';
import { clampDraft, clampListing } from './domain/assistantService.ts';
import { parsePriceList } from './model/nearPrices.ts';

test('the assistant drafts a floor limited to what Hermes has, and creates nothing', async () => {
  const model = new FakeChatModel(() => JSON.stringify({
    say: 'A Legal floor. Here is my pitch.', mood: 'happy', replies: ['Looks good'],
    draft: { name: 'Legal', purpose: 'Review contracts.', skills: ['pdf', 'contract-wizard'], toolsets: ['web', 'file', 'delegation'], model: 'near-ai/model-a', teammates: 2 },
  }));
  const { app } = questApp({ chatModel: model });
  const view = (await app.inject('/api/assistant')).json();
  assert.equal(view.character.title, 'Chief of Staff');
  assert.equal(view.modelReady, true);
  const before = (await app.inject('/api/departments')).json().departments.length;
  const r = await app.inject({ method: 'POST', url: '/api/assistant/department-draft', payload: { messages: [{ from: 'user', text: 'We need legal help' }] } });
  assert.equal(r.statusCode, 200);
  const d = r.json().draft;
  assert.equal(d.name, 'Legal');
  assert.deepEqual(d.skills, ['pdf']);
  assert.deepEqual(d.toolsets, ['web', 'file']);
  assert.deepEqual(d.model, { provider: 'near-ai', id: 'model-a' });
  assert.equal(d.teammates, 2);
  assert.ok(d.creditsPerDay > 0);
  assert.ok(d.dropped.some((x: string) => x.includes('contract-wizard')));
  assert.ok(d.dropped.some((x: string) => x.includes('delegation')));
  assert.equal((await app.inject('/api/departments')).json().departments.length, before, 'drafting creates nothing');
  // The system prompt lists what Hermes really has.
  assert.match(model.calls[0]![0]!.content, /Skills installed in Hermes.*pdf/);
});

test('without a model the draft is 503; malformed drafts are dropped', async () => {
  const { app } = questApp();
  const r = await app.inject({ method: 'POST', url: '/api/assistant/department-draft', payload: { messages: [{ from: 'user', text: 'hi' }] } });
  assert.equal(r.statusCode, 503);
  assert.equal(clampDraft({ purpose: 'x' }, { skills: [], toolsets: [], offered: [] }), null);
  assert.equal(clampDraft({ name: 'Ops', model: 'nope/never' }, { skills: [], toolsets: [], offered: [] })!.model, null);
});

test('priced drafts: only agent-capable models are offered, cheapest first, and the cost is the real price per agent', async () => {
  const usd = (perM: number) => ({ amount: Math.round(perM * 1000), scale: 9, currency: 'USD' });
  const entry = (id: string, inM: number, outM: number, f = ['tools']) =>
    ({ modelId: id, inputCostPerToken: usd(inM), outputCostPerToken: usd(outM), metadata: { architecture: { inputModalities: ['text'], outputModalities: ['text'] }, supportedFeatures: f } });
  const prices = parsePriceList({ models: [entry('model-b', 1, 5), entry('model-a', 0.1, 0.5), entry('m-1', 0.01, 0.01, [])] });
  const model = new FakeChatModel(() => JSON.stringify({ say: 'Here.', mood: 'happy', replies: [], draft: { name: 'Ops', purpose: 'x', model: 'near-ai/model-b', teammates: 1 } }));
  const { app } = questApp({ chatModel: model, modelPrices: { list: async () => prices } });
  const r = (await app.inject({ method: 'POST', url: '/api/assistant/department-draft', payload: { messages: [{ from: 'user', text: 'ops floor' }] } })).json();
  assert.deepEqual(r.draft.model, { provider: 'near-ai', id: 'model-b' });
  assert.equal(r.draft.creditsPerDay, 2 * 150); // ($1 + $0.50) a day, lead + one teammate
  const sys = model.calls[0]![0]!.content;
  assert.match(sys, /near-ai\/model-a \(15 credits\/day\), near-ai\/model-b \(150 credits\/day\)/);
  assert.doesNotMatch(sys, /m-1|claude-x|base-model/);
  // No model chosen: the floor runs on Hermes' current default, priced when known.
  assert.equal(clampDraft({ name: 'Ops' }, { skills: [], toolsets: [], offered: [], prices, current: 'model-a' })!.creditsPerDay, 2 * 15);
});

test('a drafted roster reaches the card and the created floor: names, titles, what each does', async () => {
  const model = new FakeChatModel(() => JSON.stringify({ say: 'Here.', mood: 'happy', replies: [], draft: { name: 'Ship It', purpose: 'Ships code.',
    agents: [{ name: 'Rhea', title: 'Release Lead', does: 'Plans the work and merges.' }, { name: 'Ode', title: 'Test Writer', does: 'Writes the tests first.' }] } }));
  const { app } = questApp({ chatModel: model });
  const d = (await app.inject({ method: 'POST', url: '/api/assistant/department-draft', payload: { messages: [{ from: 'user', text: 'ship code' }] } })).json().draft;
  assert.equal(d.teammates, 1);
  assert.deepEqual(d.agents[1], { name: 'Ode', title: 'Test Writer', does: 'Writes the tests first.' });
  const created = await app.inject({ method: 'POST', url: '/api/departments', payload: { name: d.name, purpose: d.purpose, agents: d.agents.map(({ name, title }: { name: string; title: string }) => ({ name, title })) } });
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().id;
  const lead = (await app.inject(`/api/departments/${id}/characters/chief`)).json();
  assert.equal(lead.name, 'Rhea'); assert.equal(lead.title, 'Release Lead');
  assert.equal((await app.inject(`/api/departments/${id}/characters/W-01`)).json().name, 'Ode');
});

test('the market listing draft names a listable floor and a handle and category the market accepts', async () => {
  const model = new FakeChatModel(() => JSON.stringify({ say: 'Here it is.', mood: 'happy', replies: ['List it'], draft: {
    floor: 'markets intel', handle: 'Markets Intel!!', name: 'Markets Intel', category: 'astrology', slaHours: 9999, tagline: 'Daily crypto brief.', description: 'Prices, flows, news.', priceUsdc: '$7' } }));
  const { app } = questApp({ chatModel: model });
  const id = (await app.inject({ method: 'POST', url: '/api/departments', payload: { name: 'Markets Intel', purpose: 'Watches markets.' } })).json().id;
  const r = await app.inject({ method: 'POST', url: '/api/assistant/market-draft', payload: { messages: [{ from: 'user', text: 'list markets intel' }] } });
  assert.equal(r.statusCode, 200, r.body);
  const d = r.json().draft;
  assert.equal(d.departmentId, id);
  assert.equal(d.handle, 'markets-intel');
  assert.equal(d.category, 'other');
  assert.equal(d.slaHours, 720);
  assert.equal(d.priceUsdc, '7.00');
  assert.match(model.calls[0]![0]!.content, /- Markets Intel: Watches markets\./);
  // a floor that is not on the listable list is never drafted
  assert.equal(clampListing({ floor: 'Nope' }, (await app.inject('/api/departments')).json().departments), null);
});

test('a floor already on the market is not offered for listing again', async () => {
  const model = new FakeChatModel(() => JSON.stringify({ say: 'Which one?', mood: 'happy', replies: [], draft: { floor: 'Listed Desk', handle: 'listed-desk', name: 'L', category: 'other', slaHours: 24 } }));
  const { app, db } = questApp({ chatModel: model }) as ReturnType<typeof questApp> & { db: import('node:sqlite').DatabaseSync };
  const listed = (await app.inject({ method: 'POST', url: '/api/departments', payload: { name: 'Listed Desk' } })).json();
  await app.inject({ method: 'POST', url: '/api/departments', payload: { name: 'Fresh Desk' } });
  db.prepare("INSERT INTO market_agent (department_id, handle, token, created_at) VALUES (?, 'listed-desk', 'aat_x', '2026-11-10')").run(listed.id);
  const r = (await app.inject({ method: 'POST', url: '/api/assistant/market-draft', payload: { messages: [{ from: 'user', text: 'list one' }] } })).json();
  assert.equal(r.draft, null, 'the listed floor is not listable');
  assert.match(model.calls[0]![0]!.content, /- Fresh Desk/);
  assert.doesNotMatch(model.calls[0]![0]!.content, /- Listed Desk/);
});
