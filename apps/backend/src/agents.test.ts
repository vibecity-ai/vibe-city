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
  assert.match(v.sessionsError!, /Sync the floor first/);
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
    lastActive: 1793301244, active: true, messageCount: 10, toolCallCount: 4, endReason: null, preview: null,
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


test('task steps: the run sessions of that task, in plain words, failures marked, paths scrubbed, nothing raw', async () => {
  const t = provApp();
  const d = await t.create('Ops');
  await t.provision(d.id);
  const p = profileNameForAgent(d.id, 'chief');
  const run = (id: string, task: string, startedAt: number, active = false) => ({
    id, title: 'x', source: 'kanban', model: null, startedAt, endedAt: null, lastActive: null, active, messageCount: 3, toolCallCount: 1, endReason: null,
    preview: `# Kanban task ${task}: Research`,
  });
  t.hermes.sessions.set(p, [run('local-2', 't_abcd1234', 20, true), run('local-other', 't_ffff0000', 15), run('local-1', 't_abcd1234', 10),
    { ...run('vibecity-ceo-1', 't_abcd1234', 5), source: 'api_server' }]);
  const msg = (m: Partial<import('./hermes/ports.ts').SessionMessage>) => ({ role: 'assistant' as const, content: '', at: '2026-11-05T10:00:00.000Z', calls: [], toolCallId: null, toolName: null, ...m });
  t.hermes.sessionLog.set(`${p}/local-1`, [
    msg({ role: 'user', content: '# Kanban task t_abcd1234: Research\n\nsecret prompt' }),
    msg({ calls: [{ id: 'a', name: 'web_search', args: '{"query":"near ai models"}' }, { id: 'b', name: 'terminal', args: '{"command":"cat /opt/data/profiles/x/notes.md"}' }] }),
    msg({ role: 'tool', toolCallId: 'a', content: '{"results":[]}' }),
    msg({ role: 'tool', toolCallId: 'b', content: '{"output":"","exit_code":1,"error":null}' }),
  ]);
  t.hermes.sessionLog.set(`${p}/local-2`, [msg({ content: 'Found three sources, writing it up.' }), msg({ calls: [{ id: 'c', name: 'kanban_complete', args: '{"summary":"done"}' }] })]);
  const res = await t.app.inject(`/api/departments/${d.id}/agents/chief/tasks/t_abcd1234/steps`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().steps.map((s: any) => [s.kind, s.text, s.detail]), [
    ['tool', 'Searched the web', 'near ai models'],
    ['failed', 'Ran a command', 'cat <path>/notes.md'],
    ['note', 'Found three sources, writing it up.', null],
    ['tool', 'Finished the task', 'done'],
  ]);
  // where on the floor each tool lives: the city draws the step coming from there
  assert.deepEqual(res.json().steps.map((s: any) => s.via), ['web', 'terminal', null, 'board']);
  assert.equal(res.json().active, true);
  assert.doesNotMatch(res.body, /secret prompt|\/opt\/data/);
  assert.equal((await t.app.inject(`/api/departments/${d.id}/agents/chief/tasks/nope/steps`)).statusCode, 404);
});
