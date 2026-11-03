import { test } from 'node:test';
import assert from 'node:assert/strict';
import { questApp } from './testUtils.ts';
import { FakeChatModel, type ChatTurn } from './model/chatModel.ts';
import { FAKE_SKILLS } from './testing/fakeHermes.ts';
import { modelTier, parseJsonReply } from './domain/hiringService.ts';

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

test('AR rings when a floor with no workers has quests piling up, and only once', async () => {
  const { app, readyDept, create } = questApp({ chatModel: arModel(), hiringScoutMs: 0 });
  const d = await readyDept('Research', { limits: { maxConcurrentWorkers: 0 } });
  assert.equal((await app.inject('/api/hiring/current')).json().request, null);
  await create(d.id, { title: 'A' }); await create(d.id, { title: 'B' });
  const call = (await app.inject('/api/hiring/current')).json().request;
  assert.equal(call.state, 'ringing');
  assert.equal(call.trigger.kind, 'no_workers');
  assert.match(call.trigger.reason, /Research has no workers/);
  // Declining closes it; the same reason does not ring again right away.
  await app.inject({ method: 'POST', url: `/api/hiring/requests/${call.id}/decline` });
  assert.equal((await app.inject('/api/hiring/current')).json().request, null);
});

test('full hire: intake -> brief -> shortlist (2 serious, 2 joke) -> interview -> offer applies to the inventory', async () => {
  const { app, readyDept } = questApp({ chatModel: arModel(), hiringScoutMs: 0 });
  const d = await readyDept('Research');
  const start = await app.inject({ method: 'POST', url: '/api/hiring/requests', payload: { departmentId: d.id } });
  assert.equal(start.statusCode, 201);
  const id = start.json().id;
  assert.equal(start.json().state, 'intake');
  assert.equal(start.json().ar.title, 'Head of Agent Resources');

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
  assert.equal(hired.applied.workersAfter, before.limits.maxConcurrentWorkers + 1);
  const after = (await app.inject(`/api/departments/${d.id}/inventory`)).json();
  assert.equal(after.limits.maxConcurrentWorkers, before.limits.maxConcurrentWorkers + 1);
  assert.ok(after.allowedSkillIds.includes('pdf'));
  assert.deepEqual(after.model, serious[0].loadout.model);
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
