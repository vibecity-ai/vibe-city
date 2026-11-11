import { test } from 'node:test';
import assert from 'node:assert/strict';
import { questApp } from './testUtils.ts';
import { FakeChatModel, type ChatTurn } from './model/chatModel.ts';
import { FAKE_SKILLS, FakeHermes } from './testing/fakeHermes.ts';
import { FakeAgentChat } from './testing/fakeAgentChat.ts';
import { modelTier, parseJsonReply } from './domain/hiringService.ts';
import { parseAgentReply } from './domain/chatService.ts';
import { dailyCredits, parsePriceList } from './model/nearPrices.ts';

/** The candidates' personas come from the Chief of Staff's chat model. */
const arModel = () => new FakeChatModel((turns: ChatTurn[]) => turns[0]!.content.startsWith('You write short')
  ? JSON.stringify({ candidates: [
      { name: 'Ada Brightwell', pitch: 'I read fast and cite everything.', traits: ['careful', 'quick'], speechStyle: 'crisp', quirk: 'colour-codes notes' },
      { name: 'Milo Tran', pitch: 'Give me the hard ones.', traits: ['bold', 'precise'], speechStyle: 'calm', quirk: 'two monitors, one plant' },
    ] })
  : '{}');
const scout = (app: any, brief: object) => app.inject({ method: 'POST', url: '/api/hiring/requests', payload: { brief: { focus: 'Reading', skills: [], budgetPerDay: 100, notes: '', ...brief } } });

test('AR rings when a one-agent floor has quests piling up, and only once', async () => {
  const { app, readyDept, create } = questApp({ chatModel: arModel() });
  const d = await readyDept('Research', {}, 0);
  assert.equal((await app.inject('/api/hiring/current')).json().request, null);
  await create(d.id, { title: 'A' }); await create(d.id, { title: 'B' });
  const call = (await app.inject('/api/hiring/current')).json().request;
  assert.equal(call.state, 'ringing');
  assert.equal(call.trigger.kind, 'no_workers');
  assert.match(call.trigger.reason, /Research has \d+ jobs on the board and one agent doing everything alone/);
  // Declining closes it; the same reason does not ring again right away.
  await app.inject({ method: 'POST', url: `/api/hiring/requests/${call.id}/decline` });
  assert.equal((await app.inject('/api/hiring/current')).json().request, null);
});

test('full hire: a confirmed brief -> candidates right away (2 serious, 2 joke) -> offer adds an agent with its own profile', async () => {
  const { app, hermes, readyDept } = questApp({ chatModel: arModel() });
  const d = await readyDept('Research');
  assert.equal((await scout(app, { departmentId: 'nope' })).statusCode, 404);
  const res = await scout(app, { departmentId: d.id, focus: 'Reads papers and PDFs', skills: ['pdf', 'arxiv', 'not-installed'], budgetPerDay: 300 });
  assert.equal(res.statusCode, 201);
  const r = res.json(), id = r.id;
  assert.equal(r.ar.title, 'Chief of Staff');
  // hiring and floor drafting are the same person: the assistant and AR merged into the Chief of Staff
  assert.equal(r.ar.name, (await app.inject('/api/assistant')).json().character.name);
  assert.deepEqual([r.brief.departmentName, r.brief.budgetPerDay], ['Research', 300]);
  assert.equal(r.state, 'shortlist'); // no scouting wait
  assert.equal(r.candidates.length, 4);
  const serious = r.candidates.filter((c: any) => c.serious);
  const jokes = r.candidates.filter((c: any) => !c.serious);
  assert.equal(serious.length, 2);
  assert.equal(jokes.length, 2);
  for (const c of r.candidates) {
    for (const s of c.loadout.skills) assert.ok(FAKE_SKILLS.includes(s), `skill ${s} must be installed in Hermes`);
    assert.ok(c.loadout.model, 'every candidate has a model Hermes offers');
  }
  assert.ok(serious.every((c: any) => c.loadout.skills.includes('pdf')));
  assert.ok(serious.some((c: any) => c.character.name === 'Ada Brightwell'));
  assert.ok(jokes.every((c: any) => c.fitScore < 25 && c.gag));
  assert.ok(Math.min(...serious.map((c: any) => c.fitScore)) > Math.max(...jokes.map((c: any) => c.fitScore)));

  // A joke candidate needs the CEO to overrule AR's concerns.
  assert.equal((await app.inject({ method: 'POST', url: `/api/hiring/requests/${id}/offer`, payload: { candidateId: jokes[0].id } })).statusCode, 409);

  const before = (await app.inject(`/api/departments/${d.id}/inventory`)).json();
  const hired = (await app.inject({ method: 'POST', url: `/api/hiring/requests/${id}/offer`, payload: { candidateId: serious[0].id } })).json();
  assert.equal(hired.state, 'hired');
  assert.deepEqual([hired.applied.seat, hired.applied.teamBefore, hired.applied.teamAfter], ['W-02', 2, 3]);
  assert.deepEqual(hired.applied.model, serious[0].loadout.model);
  assert.deepEqual((await app.inject(`/api/departments/${d.id}/inventory`)).json(), before, 'the floor\'s own inventory is untouched');
  // The re-provision runs in the background: wait for it, then the hire is a real profile with its own loadout.
  let dept = (await app.inject(`/api/departments/${d.id}`)).json();
  for (let i = 0; i < 200 && dept.state !== 'ready'; i++) { await new Promise((r) => setImmediate(r)); dept = (await app.inject(`/api/departments/${d.id}`)).json(); }
  assert.equal(dept.state, 'ready');
  const hire = dept.agents.find((a: any) => a.key === 'W-02');
  assert.equal(hire.profileRef, hired.applied.profileRef);
  assert.deepEqual(hire.model, serious[0].loadout.model);
  assert.deepEqual(hire.skills, serious[0].loadout.skills);
  const p = hermes.profiles.get(hire.profileRef)!;
  assert.equal(p.model, serious[0].loadout.model.id);
  assert.equal(p.skills.pdf, true);
  // The hire's persona sits on the new seat.
  const seat = (await app.inject(`/api/departments/${d.id}/characters/${hired.applied.seat}`)).json();
  assert.equal(seat.name, serious[0].character.name);
  // The request is closed: nothing open is returned.
  assert.equal((await app.inject('/api/hiring/current')).json().request, null);
});

test('model tiers and reply parsing', () => {
  assert.equal(modelTier('deepseek/deepseek-v4.1-flash'), 1);
  assert.equal(modelTier('Qwen/Qwen3-235B-A22B'), 3);
  assert.equal(modelTier('zai-org/GLM-4.6'), 2);
  assert.equal(parseJsonReply('not json').say, 'not json');
  // cut off by the token limit: the JSON never reaches the dialogue, only what was said
  assert.equal(parseJsonReply('Locked in, boss.\n\n{"say": "Locked in, boss.", "mood": "focused", "draft": {"').say, 'Locked in, boss.');
  assert.equal(parseJsonReply('{"say": "Hi \\"boss\\".", "mood": "focused", "draft": {"na').say, 'Hi "boss".');
  assert.equal(parseJsonReply('<think>x</think>{"say":"hi","mood":"smug","replies":["a"]}').mood, 'smug');
});

test('NEAR price list keeps only agent-capable models; priced shortlists use real costs and vary', async () => {
  const usd = (perM: number) => ({ amount: Math.round(perM * 1000), scale: 9, currency: 'USD' });
  const entry = (id: string, inM: number, outM: number, im = ['text'], om = ['text'], f = ['tools']) =>
    ({ modelId: id, inputCostPerToken: usd(inM), outputCostPerToken: usd(outM), metadata: { contextLength: 1000, architecture: { inputModalities: im, outputModalities: om }, supportedFeatures: f } });
  const sealed = entry('model-b', 1, 5), partner = entry('m-1', 5, 25);
  // NEAR AI's flag for a model served from an attested TEE; its owner says whose TEE
  Object.assign(sealed.metadata, { verifiable: true, ownedBy: 'nearai', modelIcon: 'https://avatars.example/b.png' });
  Object.assign(partner.metadata, { verifiable: true, ownedBy: 'attested 3p', modelIcon: 'javascript:alert(1)' });
  Object.assign(sealed, { cacheReadCostPerToken: usd(0.02) }); // prompt tokens served from NEAR AI's cache
  const list = parsePriceList({ models: [
    entry('model-a', 0.1, 0.5, ['text', 'image']), sealed, partner,
    entry('anthropic/claude-x', 0.01, 0.01), // rejects the reasoning_effort Hermes always sends
    entry('base-model', 0.01, 0.01, ['text'], ['text'], []), // no tool calling: Hermes cannot drive it
    entry('claude-x', 0.01, 0.01, ['audio']), entry('img', 1, 1, ['text'], ['image']),
  ] });
  assert.deepEqual([...list.keys()], ['model-a', 'model-b', 'm-1']);
  assert.equal(list.get('model-a')!.vision, true);
  assert.equal(list.get('model-b')!.privacy, 'private');
  assert.equal(list.get('m-1')!.privacy, 'confidential');
  assert.equal(list.get('model-a')!.privacy, undefined); // routed to the vendor: no tag
  assert.equal(list.get('model-b')!.icon, 'https://avatars.example/b.png');
  assert.equal(list.get('m-1')!.icon, undefined); // only https logos reach the browser
  assert.equal(Math.round(list.get('model-b')!.cachedPerM! * 1000), 20);
  assert.equal(list.get('model-a')!.cachedPerM, undefined); // no cache price: cached tokens cost full input
  assert.equal(dailyCredits(list.get('model-a')!), 15); // $0.10 + $0.05 a day
  assert.equal(dailyCredits(list.get('m-1')!), 750);

  const { app, readyDept } = questApp({ chatModel: arModel(), modelPrices: { list: async () => list } });
  const d = await readyDept('Research');
  const seen = new Set<string>();
  for (let i = 0; i < 6; i++) {
    const r = (await scout(app, { departmentId: d.id, budgetPerDay: 200 })).json();
    for (const c of r.candidates) assert.ok(list.has(c.loadout.model.id), `${c.loadout.model.id} must be priced and tool-capable`);
    for (const c of r.candidates.filter((x: any) => x.serious)) {
      assert.equal(c.costPerDay, dailyCredits(list.get(c.loadout.model.id)!));
      assert.match(c.note, /NEAR AI price: \$/);
      if (c.loadout.model.id === 'model-b') assert.match(c.note, /Private TEE: sealed in NEAR AI's TEE/);
      seen.add(c.loadout.model.id);
    }
  }
  assert.ok(seen.has('model-a') && seen.has('model-b'), 'balanced and premium are both drawn from what fits the budget');
});

test('the Chief of Staff hires in its own Hermes chat: brief, models with prices, candidates, hire; skills it loads stay on the reply', async () => {
  const usd = (perM: number) => ({ amount: Math.round(perM * 1000), scale: 9, currency: 'USD' });
  const entry = (id: string, inM: number, outM: number) => ({ modelId: id, inputCostPerToken: usd(inM), outputCostPerToken: usd(outM), metadata: { contextLength: 1000, architecture: { inputModalities: ['text'], outputModalities: ['text'] }, supportedFeatures: ['tools'] } });
  const sealed = entry('model-b', 1, 5);
  Object.assign(sealed.metadata, { verifiable: true, ownedBy: 'nearai' });
  const list = parsePriceList({ models: [entry('model-a', 0.1, 0.5), sealed] });
  const hermes = new FakeHermes();
  const agentChat = new FakeAgentChat(hermes, (t) => /\$3/.test(t.message)
    ? 'Here is the brief.\n<vc>{"mood":"happy","replies":[],"proposal":null,"hire":{"department":"research","focus":"Reads papers","skills":["pdf"],"budgetPerDay":300,"notes":"","model":"model-b"}}</vc>'
    : 'Sure.\n<vc>{"mood":"focused","replies":[],"proposal":null}</vc>');
  agentChat.events = [{ kind: 'thinking' }, { kind: 'skill', name: 'vibe-city' }];
  const { app, services, readyDept } = questApp({ agentChat, chatModel: arModel(), modelPrices: { list: async () => list } }, hermes);
  const cos = services.chiefOfStaffId;
  await app.inject({ method: 'POST', url: `/api/departments/${cos}/provision` });
  const d = await readyDept('Research');
  const say = async (message: string) => (await app.inject({ method: 'POST', url: `/api/departments/${cos}/characters/chief/chat`, payload: { message } })).json();

  const hello = await say('How are we doing?');
  assert.doesNotMatch(agentChat.turns.at(-1)!.system, /## Hiring/, 'no hiring talk: no per-day model costs or candidates');
  assert.deepEqual(hello.agent.skills, ['vibe-city'], 'the skill Hermes reported loading stays on the reply');
  assert.equal(hello.user.skills, undefined);

  const brief = (await say('I want to hire someone for Research, $3 a day')).agent.hire;
  assert.deepEqual(brief, { departmentId: d.id, departmentName: 'Research', focus: 'Reads papers', skills: ['pdf'], budgetPerDay: 300, notes: '', model: 'model-b' });
  const sys = agentChat.turns.at(-1)!.system;
  assert.match(sys, /- model-a \(near-ai\): about \$0\.15 a day for one busy agent, small by price; \$0\.10 in \/ \$0\.50 out per 1M tokens/);
  assert.match(sys, /- model-b \(near-ai\): about \$1\.50 a day.*Private TEE/);
  assert.match(sys, /- claude-x \(anthropic\): price unknown/);
  assert.ok(sys.indexOf('model-a (') < sys.indexOf('model-b ('), 'cheapest first');
  assert.match(sys, /NEAR AI list prices/);

  // confirming the brief card: candidates right away, and the chat knows them on the next turn
  const { departmentName: _, ...input } = brief;
  const r = (await app.inject({ method: 'POST', url: '/api/hiring/requests', payload: { brief: input } })).json();
  assert.equal(r.candidates.length, 4);
  assert.equal(r.candidates.find((c: any) => c.serious && c.loadout.model.id === 'model-b')?.serious, true, 'the recommended model is on a serious candidate');
  // no hiring words in this turn: the open request alone keeps the candidates in the briefing
  await say('Then nothing changes?');
  for (const c of r.candidates) assert.ok(agentChat.turns.at(-1)!.system.includes(`${c.character.name} (`), 'every candidate is in the briefing');
  const pick = r.candidates.find((c: any) => c.serious);
  assert.equal((await app.inject({ method: 'POST', url: `/api/hiring/requests/${r.id}/offer`, payload: { candidateId: pick.id } })).json().state, 'hired');

  // a brief for a floor that does not exist is no brief
  assert.equal(parseAgentReply('x<vc>{"hire":{"department":"Security Audits","focus":"a"}}</vc>', { floors: [{ id: d.id, name: 'Research' }] }).hire, undefined);
});
