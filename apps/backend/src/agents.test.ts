import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentViewSchema, profileNameForAgent } from '@vibe-city/shared';
import { provApp } from './testUtils.ts';

const agent = async (t: ReturnType<typeof provApp>, id: string, key: string) => t.app.inject(`/api/departments/${id}/agents/${key}`);

test('before provisioning the agent view has no profile, no read-back and says why sessions are missing', async () => {
  const t = provApp();
  const d = await t.create('Research');
  const res = await agent(t, d.id, 'chief');
  assert.equal(res.statusCode, 200);
  const v = AgentViewSchema.parse(res.json());
  assert.equal(v.profileRef, null);
  assert.equal(v.observedAt, null);
  assert.deepEqual([v.skills, v.toolsets, v.sessions], [[], [], null]);
  assert.match(v.sessionsError!, /Sync the department first/);
});

test('after provisioning: installed skills with their enabled state, toolsets and model come from the read-back', async () => {
  const t = provApp();
  const d = await t.create('Engineering', { inventory: { allowedToolsets: ['file', 'terminal'], allowedSkillIds: ['pdf'], model: { provider: 'near-ai', id: 'm-1' } } });
  assert.equal((await t.provision(d.id)).statusCode, 200);

  const chief = AgentViewSchema.parse((await agent(t, d.id, 'chief')).json());
  assert.equal(chief.profileRef, profileNameForAgent(d.id, 'chief'));
  assert.equal(chief.lead, true);
  assert.ok(chief.observedAt);
  assert.equal(chief.model, 'm-1');
  const skill = (n: string) => chief.skills.find((s) => s.name === n);
  assert.deepEqual(skill('pdf'), { name: 'pdf', enabled: true, essential: false });
  assert.deepEqual(skill('arxiv'), { name: 'arxiv', enabled: false, essential: false });
  assert.deepEqual(skill('hermes-agent'), { name: 'hermes-agent', enabled: true, essential: true });
  // every agent gets the department toolsets (minus delegation/cronjob), not a coordination-only subset
  assert.equal(chief.toolsets.find((x) => x.name === 'file')?.enabled, true);
  assert.equal(chief.toolsets.find((x) => x.name === 'delegation')?.enabled, false);
  assert.equal(chief.toolsets.find((x) => x.name === 'kanban')?.enabled, true);

  const worker = AgentViewSchema.parse((await agent(t, d.id, 'W-01')).json());
  assert.equal(worker.profileRef, profileNameForAgent(d.id, 'W-01'));
  assert.equal(worker.lead, false);
  assert.equal(worker.toolsets.find((x) => x.name === 'file')?.enabled, true);
  assert.deepEqual(worker.sessions, []);
  assert.equal(worker.sessionsError, null);
});

test('sessions are relayed as safe fields only: ISO times, scrubbed titles, no host paths', async () => {
  const t = provApp();
  const d = await t.create('Ops');
  await t.provision(d.id);
  t.hermes.sessions.set(profileNameForAgent(d.id, 'chief'), [{
    id: 'local-abc', title: 'Read /home/someone/secret/plan.md', source: 'kanban', model: 'gpt-x', startedAt: 1793301218.1, endedAt: null,
    lastActive: 1793301244, active: true, messageCount: 10, toolCallCount: 4, endReason: null,
  }]);
  const res = await agent(t, d.id, 'chief');
  const v = AgentViewSchema.parse(res.json());
  assert.equal(v.sessions!.length, 1);
  const s = v.sessions![0]!;
  assert.equal(s.title, 'Read <path>/plan.md');
  assert.equal(s.startedAt, new Date(1793301218.1 * 1000).toISOString());
  assert.equal(s.endedAt, null);
  assert.equal(s.active, true);
  assert.doesNotMatch(res.body, /\/home\/someone/);
});

test('Hermes unreachable: sessions are null with a reason, the last read-back is still shown', async () => {
  const t = provApp();
  const d = await t.create('Design', { inventory: { allowedSkillIds: ['pdf'] } });
  await t.provision(d.id);
  t.hermes.online = false;
  const res = await agent(t, d.id, 'W-01');
  assert.equal(res.statusCode, 200);
  const v = AgentViewSchema.parse(res.json());
  assert.equal(v.sessions, null);
  assert.match(v.sessionsError!, /not reachable/);
  assert.equal(v.skills.find((s) => s.name === 'pdf')?.enabled, true);
});

test('unknown agent or department is a 404', async () => {
  const t = provApp();
  const d = await t.create('Legal');
  assert.equal((await agent(t, d.id, 'janitor')).statusCode, 404);
  assert.equal((await agent(t, d.id, 'W-02')).statusCode, 404, 'no such seat');
  assert.equal((await agent(t, d.id, 'worker')).statusCode, 404);
  assert.equal((await agent(t, '00000000-0000-4000-8000-000000000000', 'chief')).statusCode, 404);
});
