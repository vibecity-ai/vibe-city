import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EffectiveInventorySchema, HermesDefaultsViewSchema, profileNameForAgent } from '@vibe-city/shared';
import { DepartmentService } from './domain/departmentService.ts';
import { provApp, questApp } from './testUtils.ts';

test('a solo department provisions only its lead, which gets the department toolsets and works alone', async () => {
  const t = provApp();
  const d = await t.create('Solo', { teammates: 0, inventory: { allowedToolsets: ['file', 'terminal', 'web', 'delegation', 'cronjob'] } });
  const res = await t.provision(d.id);
  assert.equal(res.json().state, 'ready', res.body);
  const lead = profileNameForAgent(d.id, 'chief');
  assert.deepEqual(res.json().agents.map((a: any) => [a.key, a.ref]), [['chief', lead]]);
  assert.ok(!t.hermes.calls.some((c) => c.startsWith('createProfile') && !c.includes(lead)), 'no other profile is created');
  const c = t.hermes.profiles.get(lead)!;
  const on = Object.entries(c.toolsets).filter(([, v]) => v).map(([k]) => k).sort();
  assert.deepEqual(on, ['file', 'kanban', 'terminal', 'web'], 'department toolsets plus kanban; never delegation/cronjob');
  assert.match(c.soul, /no teammates: do the work yourself/);
});

test('every agent is its own profile, with the same rules and the others named as teammates', async () => {
  const t = provApp();
  t.hermes.concurrencyCap = 1;
  const d = await t.create('Team', { teammates: 2, inventory: { allowedToolsets: ['file'] } });
  const res = await t.provision(d.id);
  assert.equal(res.json().state, 'ready', res.body);
  const [lead, w1, w2] = ['chief', 'W-01', 'W-02'].map((k) => profileNameForAgent(d.id, k)) as [string, string, string];
  assert.deepEqual(res.json().agents.map((a: any) => a.ref), [lead, w1, w2]);
  for (const [me, others] of [[lead, [w1, w2]], [w1, [lead, w2]], [w2, [lead, w1]]] as const) {
    const p = t.hermes.profiles.get(me)!;
    assert.equal(p.toolsets.file, true, `${me} has the department toolsets`);
    for (const o of others) assert.ok(p.soul.includes(`"${o}"`), `${me} knows teammate ${o}`);
    assert.ok(!p.soul.includes(`"${me}"`), `${me} is not its own teammate`);
  }
  assert.match(t.hermes.profiles.get(lead)!.soul, /New quests for the department are assigned to you/);
  assert.doesNotMatch(t.hermes.profiles.get(w1)!.soul, /New quests/);
  const eff = EffectiveInventorySchema.parse((await t.app.inject(`/api/departments/${d.id}/effective-inventory`)).json());
  assert.deepEqual(eff.agents.map((a) => a.profileRef), [lead, w1, w2]);
  const conc = eff.departmentWide.find((e) => e.capability === 'limits.concurrency')!;
  assert.deepEqual(conc.effective, { agents: 3, perAgentCap: 1, departmentMax: 3 });
  const rec = (await t.app.inject({ method: 'POST', url: '/api/runtime/reconcile' })).json();
  assert.equal(rec.departments[0].state, 'ready');
});

test('a new agent gets its own profile, model and skills on the next run; the rest of the team learns about it', async () => {
  const t = provApp();
  const d = await t.create('Grow', { teammates: 0, inventory: { model: { provider: 'near-ai', id: 'm-1' }, allowedSkillIds: ['pdf'] } });
  await t.provision(d.id);
  const depts = new DepartmentService(t.db, (await t.app.inject('/api/company')).json().id);
  const added = depts.addAgent(d.id, { model: { provider: 'near-ai', id: 'model-a' }, skills: ['arxiv'] });
  assert.equal(added.agent_key, 'W-01');
  assert.equal((await t.dept(d.id)).state, 'unconfigured', 'the team changed: Hermes must be updated');
  const res = await t.provision(d.id);
  assert.equal(res.json().state, 'ready', res.body);
  const lead = t.hermes.profiles.get(profileNameForAgent(d.id, 'chief'))!;
  const hire = t.hermes.profiles.get(profileNameForAgent(d.id, 'W-01'))!;
  assert.equal(hire.model, 'model-a', 'the hire keeps its own model');
  assert.equal(lead.model, 'm-1', 'the floor keeps its model');
  assert.equal(hire.skills.arxiv, true);
  assert.equal(lead.skills.arxiv, false, 'the hire\'s skills are its own');
  assert.equal(hire.skills.pdf, true, 'department skills apply to everyone');
  assert.ok(lead.soul.includes(`"${profileNameForAgent(d.id, 'W-01')}"`), 'the lead now names its teammate');
  assert.doesNotMatch(lead.soul, /no teammates/);
});

test('a solo quest tells the lead to do the work itself, and only the department\'s agents may hold tasks', async () => {
  const t = questApp();
  const d = await t.readyDept('Solo', {}, 0);
  assert.equal(d.teammate, undefined);
  const res = await t.create(d.id, { objective: 'Write the report' });
  assert.equal(res.statusCode, 201, res.body);
  const { questId } = res.json();
  const raw = await t.kanban.getTask(d.board, questId);
  assert.match(raw.task.body!, /no teammates: do the work yourself/);
  assert.ok(!raw.task.body!.includes('vc-'), 'no other profile is named');

  t.kanban.seedTask(d.board, { title: 'Self task', assignee: d.lead, parents: [questId] });
  t.kanban.seedTask(d.board, { title: 'Foreign task', assignee: 'someone-else', parents: [questId] });
  const q = await t.get_(d.id, questId);
  assert.equal(q.violations.length, 1, JSON.stringify(q.violations));
  assert.match(q.violations[0], /someone-else.*not one of this department's agents/);
});

test('a team quest names every teammate; each task is attributed to the agent it is assigned to', async () => {
  const t = questApp();
  const d = await t.readyDept('Team', {}, 2);
  const [lead, w1, w2] = d.refs;
  const { questId } = (await t.create(d.id, { objective: 'Research three markets' })).json();
  const body = (await t.kanban.getTask(d.board, questId)).task.body!;
  assert.ok(body.includes(`"${w1}"`) && body.includes(`"${w2}"`), 'both teammates are offered');
  assert.ok(!body.includes(`"${lead}"`), 'the lead does not hand work to itself');
  t.kanban.complete(d.board, questId, 'split in two');
  const a = t.kanban.seedTask(d.board, { title: 'Market A', assignee: w1!, parents: [questId] });
  const b = t.kanban.seedTask(d.board, { title: 'Market B', assignee: w2!, parents: [questId] });
  t.kanban.startRun(d.board, a.id, w1!);
  t.kanban.startRun(d.board, b.id, w2!);
  const q = await t.get_(d.id, questId);
  assert.deepEqual(q.tasks.map((n: any) => n.agentKey), ['chief', 'W-01', 'W-02']);
  assert.equal(q.counts.running, 2, 'two agents work at the same time');
  assert.deepEqual(q.violations, []);
});

test('runtime defaults report the default profile: model, toolsets (with manageability) and skills', async () => {
  const t = provApp();
  const p = t.hermes.profiles.get('default')!;
  p.toolsets.tts = false;
  p.skills.arxiv = false;
  const v = HermesDefaultsViewSchema.parse((await t.app.inject('/api/runtime/defaults')).json());
  assert.equal(v.model, 'base-model');
  const ts = (n: string) => v.toolsets.find((x) => x.name === n)!;
  assert.deepEqual(ts('terminal'), { name: 'terminal', enabled: true, manageable: true });
  assert.equal(ts('tts').enabled, false);
  assert.equal(ts('delegation').manageable, false, 'excluded for agents');
  assert.equal(ts('kanban').manageable, false, 'always on, not a choice');
  assert.deepEqual(v.skills.find((s) => s.name === 'arxiv'), { name: 'arxiv', enabled: false });
  assert.ok(t.hermes.calls.every((c) => !/^(set|write|create)/.test(c)), 'reading defaults changes nothing in Hermes');
});

