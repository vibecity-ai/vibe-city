import { test } from 'node:test';
import assert from 'node:assert/strict';
import { questApp } from './testUtils.ts';
import { FakeHermes } from './testing/fakeHermes.ts';
import { FakeAgentChat } from './testing/fakeAgentChat.ts';
import { FakeChatModel } from './model/chatModel.ts';
import { clampDraft, clampListing } from './domain/assistantService.ts';
import { parsePriceList } from './model/nearPrices.ts';

/** The Chief of Staff's Hermes chat with a scripted agent: what it was told, and the floor draft that came back. */
async function draftWith(floor: Record<string, unknown>, extra: Parameters<typeof questApp>[0] = {}) {
  const hermes = new FakeHermes();
  const agentChat = new FakeAgentChat(hermes, () => `Here is my pitch.\n<vc>${JSON.stringify({ mood: 'happy', replies: ['Looks good'], proposal: null, floor })}</vc>`);
  const { app, services } = questApp({ agentChat, ...extra }, hermes);
  const cos = services.chiefOfStaffId;
  assert.equal((await app.inject({ method: 'POST', url: `/api/departments/${cos}/provision` })).json().state, 'ready');
  const r = await app.inject({ method: 'POST', url: `/api/departments/${cos}/characters/chief/chat`, payload: { message: 'Design a custom floor' } });
  assert.equal(r.statusCode, 200, r.body);
  return { app, draft: r.json().agent.floorDraft, system: agentChat.turns[0]!.system };
}

test('the Chief of Staff drafts a floor in its Hermes chat, limited to what Hermes has, and creates nothing', async () => {
  const { app, draft: d, system } = await draftWith({ name: 'Legal', purpose: 'Review contracts.', skills: ['pdf', 'contract-wizard'], toolsets: ['web', 'file', 'delegation'], model: 'near-ai/model-a', teammates: 2 });
  assert.equal((await app.inject('/api/assistant')).json().character.title, 'Chief of Staff');
  assert.equal(d.name, 'Legal');
  assert.deepEqual(d.skills, ['pdf']);
  assert.deepEqual(d.toolsets, ['web', 'file']);
  assert.deepEqual(d.model, { provider: 'near-ai', id: 'model-a' });
  assert.equal(d.teammates, 2);
  assert.ok(d.creditsPerDay > 0);
  assert.ok(d.dropped.some((x: string) => x.includes('contract-wizard')));
  assert.ok(d.dropped.some((x: string) => x.includes('delegation')));
  assert.equal((await app.inject('/api/departments')).json().departments.length, 0, 'drafting creates nothing');
  // The system prompt lists what Hermes really has.
  assert.match(system, /Skills installed in Hermes.*pdf/);
});

test('malformed drafts are dropped', async () => {
  assert.equal((await draftWith({ purpose: 'no name' })).draft, undefined);
  assert.equal(clampDraft({ purpose: 'x' }, { skills: [], toolsets: [], offered: [] }), null);
  assert.equal(clampDraft({ name: 'Ops', model: 'nope/never' }, { skills: [], toolsets: [], offered: [] })!.model, null);
});

test('priced drafts: only agent-capable models are offered, cheapest first, and the cost is the real price per agent', async () => {
  const usd = (perM: number) => ({ amount: Math.round(perM * 1000), scale: 9, currency: 'USD' });
  const entry = (id: string, inM: number, outM: number, f = ['tools']) =>
    ({ modelId: id, inputCostPerToken: usd(inM), outputCostPerToken: usd(outM), metadata: { architecture: { inputModalities: ['text'], outputModalities: ['text'] }, supportedFeatures: f } });
  const prices = parsePriceList({ models: [entry('model-b', 1, 5), entry('model-a', 0.1, 0.5), entry('m-1', 0.01, 0.01, [])] });
  const { draft, system } = await draftWith({ name: 'Ops', purpose: 'x', model: 'near-ai/model-b', teammates: 1 }, { modelPrices: { list: async () => prices } });
  assert.deepEqual(draft.model, { provider: 'near-ai', id: 'model-b' });
  assert.equal(draft.creditsPerDay, 2 * 150); // ($1 + $0.50) a day, lead + one teammate
  assert.match(system, /near-ai\/model-a \(15 credits\/day, Incognito\), near-ai\/model-b \(150 credits\/day, Incognito\)/);
  assert.doesNotMatch(system, /m-1|claude-x|base-model/);
  // No model chosen: the floor runs on Hermes' current default, priced when known.
  assert.equal(clampDraft({ name: 'Ops' }, { skills: [], toolsets: [], offered: [], prices, current: 'model-a' })!.creditsPerDay, 2 * 15);
});

test('a drafted roster reaches the card and the created floor: names, titles, what each does', async () => {
  const { app, draft: d } = await draftWith({ name: 'Ship It', purpose: 'Ships code.',
    agents: [{ name: 'Rhea', title: 'Release Lead', does: 'Plans the work and merges.' }, { name: 'Ode', title: 'Test Writer', does: 'Writes the tests first.' }] });
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
