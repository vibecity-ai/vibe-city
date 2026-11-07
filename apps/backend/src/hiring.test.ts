import { test } from 'node:test';
import assert from 'node:assert/strict';
import { questApp } from './testUtils.ts';
import { FakeChatModel, type ChatTurn } from './model/chatModel.ts';
import { FAKE_SKILLS } from './testing/fakeHermes.ts';
import { modelTier, parseJsonReply } from './domain/hiringService.ts';
import { dailyCredits, parsePriceList } from './model/nearPrices.ts';

/** AR's scripted model: asks once, then returns a brief for the floor named in the system prompt's trigger. */
const arModel = () => new FakeChatModel((turns: ChatTurn[]) => {
  const sys = turns[0]!.content;
  if (sys.startsWith('You write short')) {
    return JSON.stringify({ candidates: [
      { name: 'Ada Brightwell', pitch: 'I read fast and cite everything.', traits: ['careful', 'quick'], speechStyle: 'crisp', quirk: 'colour-codes notes' },
      { name: 'Milo Tran', pitch: 'Give me the hard ones.', traits: ['bold', 'precise'], speechStyle: 'calm', quirk: 'two monitors, one plant' },
    ] });
  }
  if (sys.includes('job candidate')) return JSON.stringify({ say: 'Happy to take a test question.', mood: 'happy', replies: ['Go on'] });
  if (turns.length <= 2) return JSON.stringify({ say: 'Which floor and what skills?', mood: 'focused', replies: ['Research, pdf skills'], brief: null });
  return JSON.stringify({ say: 'Got it. Here is the brief.', mood: 'happy', replies: ['Looks good'], brief: { department: 'research', focus: 'Reads papers and PDFs', skills: ['pdf', 'arxiv', 'not-installed'], budgetPerDay: 300, notes: '' } });
});

test('AR rings when a one-agent floor has quests piling up, and only once', async () => {
  const { app, readyDept, create } = questApp({ chatModel: arModel(), hiringScoutMs: 0 });
  const d = await readyDept('Research', {}, 0);
  assert.equal((await app.inject('/api/hiring/current')).json().request, null);
  await create(d.id, { title: 'A' }); await create(d.id, { title: 'B' });
  const call = (await app.inject('/api/hiring/current')).json().request;
  assert.equal(call.state, 'ringing');
  assert.equal(call.trigger.kind, 'no_workers');
  assert.match(call.trigger.reason, /Research has \d+ quests on the board and one agent doing everything alone/);
  // Declining closes it; the same reason does not ring again right away.
  await app.inject({ method: 'POST', url: `/api/hiring/requests/${call.id}/decline` });
  assert.equal((await app.inject('/api/hiring/current')).json().request, null);
});

test('full hire: intake -> brief -> shortlist (2 serious, 2 joke) -> interview -> offer adds an agent with its own profile', async () => {
  const { app, hermes, readyDept } = questApp({ chatModel: arModel(), hiringScoutMs: 0 });
  const d = await readyDept('Research');
  const start = await app.inject({ method: 'POST', url: '/api/hiring/requests', payload: { departmentId: d.id } });
  assert.equal(start.statusCode, 201);
  const id = start.json().id;
  assert.equal(start.json().state, 'intake');
  assert.equal(start.json().ar.title, 'Chief of Staff');
  // hiring and floor drafting are the same person: the assistant and AR merged into the Chief of Staff
  assert.equal(start.json().ar.name, (await app.inject('/api/assistant')).json().character.name);

  // No brief yet: confirming is refused.
  assert.equal((await app.inject({ method: 'POST', url: `/api/hiring/requests/${id}/brief`, payload: {} })).statusCode, 400);
  let r = (await app.inject({ method: 'POST', url: `/api/hiring/requests/${id}/chat`, payload: { message: 'We need help' } })).json();
  assert.equal(r.brief, null);
  r = (await app.inject({ method: 'POST', url: `/api/hiring/requests/${id}/chat`, payload: { message: 'Research, reading PDFs, 300 a day' } })).json();
  assert.equal(r.messages.length, 4);
  assert.equal(r.brief.departmentId, d.id);
  assert.equal(r.brief.budgetPerDay, 300);

  r = (await app.inject({ method: 'POST', url: `/api/hiring/requests/${id}/brief`, payload: {} })).json();
  assert.equal(r.state, 'shortlist'); // scoutMs 0: the timer is already over
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

  const iv = await app.inject({ method: 'POST', url: `/api/hiring/requests/${id}/candidates/${serious[0].id}/interview`, payload: { message: 'Summarise a paper in one line.' } });
  assert.equal(iv.statusCode, 200);
  assert.equal(iv.json().agent.text, 'Happy to take a test question.');
  assert.ok(iv.json().stats.tokens > 0);

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

test('scouting hides candidates until the timer runs out', async () => {
  const { app, readyDept } = questApp({ chatModel: arModel(), hiringScoutMs: 60_000 });
  const d = await readyDept('Research');
  const id = (await app.inject({ method: 'POST', url: '/api/hiring/requests', payload: { departmentId: d.id } })).json().id;
  const r = (await app.inject({ method: 'POST', url: `/api/hiring/requests/${id}/brief`, payload: { brief: { departmentId: d.id, focus: 'Reading', skills: [], budgetPerDay: 100, notes: '' } } })).json();
  assert.equal(r.state, 'scouting');
  assert.deepEqual(r.candidates, []);
  assert.ok(Date.parse(r.scoutingUntil) > Date.now());
});

test('without a model the intake is 503; model tiers and reply parsing', async () => {
  const { app, readyDept } = questApp();
  const d = await readyDept('Ops');
  const id = (await app.inject({ method: 'POST', url: '/api/hiring/requests', payload: { departmentId: d.id } })).json().id;
  const r = await app.inject({ method: 'POST', url: `/api/hiring/requests/${id}/chat`, payload: { message: 'hi' } });
  assert.equal(r.statusCode, 503);
  assert.equal(modelTier('deepseek/deepseek-v4.1-flash'), 1);
  assert.equal(modelTier('Qwen/Qwen3-235B-A22B'), 3);
  assert.equal(modelTier('zai-org/GLM-4.6'), 2);
  assert.equal(parseJsonReply('not json').say, 'not json');
  assert.equal(parseJsonReply('<think>x</think>{"say":"hi","mood":"smug","replies":["a"]}').mood, 'smug');
});

test('NEAR price list keeps only agent-capable models; priced shortlists use real costs and vary', async () => {
  const usd = (perM: number) => ({ amount: Math.round(perM * 1000), scale: 9, currency: 'USD' });
  const entry = (id: string, inM: number, outM: number, im = ['text'], om = ['text'], f = ['tools']) =>
    ({ modelId: id, inputCostPerToken: usd(inM), outputCostPerToken: usd(outM), metadata: { contextLength: 1000, architecture: { inputModalities: im, outputModalities: om }, supportedFeatures: f } });
  const list = parsePriceList({ models: [
    entry('model-a', 0.1, 0.5, ['text', 'image']), entry('model-b', 1, 5), entry('m-1', 5, 25),
    entry('base-model', 0.01, 0.01, ['text'], ['text'], []), // no tool calling: Hermes cannot drive it
    entry('claude-x', 0.01, 0.01, ['audio']), entry('img', 1, 1, ['text'], ['image']),
  ] });
  assert.deepEqual([...list.keys()], ['model-a', 'model-b', 'm-1']);
  assert.equal(list.get('model-a')!.vision, true);
  assert.equal(dailyCredits(list.get('model-a')!), 15); // $0.10 + $0.05 a day
  assert.equal(dailyCredits(list.get('m-1')!), 750);

  const { app, readyDept } = questApp({ chatModel: arModel(), hiringScoutMs: 0, modelPrices: { list: async () => list } });
  const d = await readyDept('Research');
  const seen = new Set<string>();
  for (let i = 0; i < 6; i++) {
    const id = (await app.inject({ method: 'POST', url: '/api/hiring/requests', payload: { departmentId: d.id } })).json().id;
    const r = (await app.inject({ method: 'POST', url: `/api/hiring/requests/${id}/brief`, payload: { brief: { departmentId: d.id, focus: 'Reading', skills: [], budgetPerDay: 200, notes: '' } } })).json();
    for (const c of r.candidates) assert.ok(list.has(c.loadout.model.id), `${c.loadout.model.id} must be priced and tool-capable`);
    for (const c of r.candidates.filter((x: any) => x.serious)) {
      assert.equal(c.costPerDay, dailyCredits(list.get(c.loadout.model.id)!));
      assert.match(c.note, /NEAR AI price: \$/);
      seen.add(c.loadout.model.id);
    }
    await app.inject({ method: 'POST', url: `/api/hiring/requests/${id}/decline` });
  }
  assert.ok(seen.has('model-a') && seen.has('model-b'), 'balanced and premium are both drawn from what fits the budget');
});
