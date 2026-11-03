import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EffectiveInventorySchema, HermesDefaultsViewSchema, profileNamesForDepartment } from '@vibe-city/shared';
import { HermesUnavailableError } from './hermes/ports.ts';
import { provApp, questApp } from './testUtils.ts';

const NO_WORKERS = { limits: { maxConcurrentWorkers: 0 } };

test('with no workers, provisioning creates only the chief and the chief gets the department toolsets', async () => {
  const t = provApp();
  const d = await t.create('Solo', { inventory: { ...NO_WORKERS, allowedToolsets: ['file', 'terminal', 'web', 'delegation', 'cronjob'] } });
  const res = await t.provision(d.id);
  assert.equal(res.json().state, 'ready', res.body);
  const { chief, worker } = profileNamesForDepartment(d.id);
  assert.ok(t.hermes.profiles.has(chief));
  assert.ok(!t.hermes.profiles.has(worker), 'no worker profile is created');
  assert.equal(res.json().worker.ref, null);
  const c = t.hermes.profiles.get(chief)!;
  const on = Object.entries(c.toolsets).filter(([, v]) => v).map(([k]) => k).sort();
  assert.deepEqual(on, ['file', 'kanban', 'terminal', 'web'], 'department toolsets plus kanban; never delegation/cronjob');
  assert.match(c.soul, /no workers: do the work yourself/);
});

test('with no workers, effective inventory has no worker section and reconcile stays ready', async () => {
  const t = provApp();
  const d = await t.create('Solo', { inventory: NO_WORKERS });
  await t.provision(d.id);
  const eff = EffectiveInventorySchema.parse((await t.app.inject(`/api/departments/${d.id}/effective-inventory`)).json());
  assert.equal(eff.worker, null);
  assert.equal(eff.departmentWide.find((e) => e.capability === 'limits.maxConcurrentWorkers')!.status, 'configured');
  const rec = (await t.app.inject({ method: 'POST', url: '/api/runtime/reconcile' })).json();
  assert.equal(rec.departments[0].state, 'ready');
  assert.ok(!t.hermes.calls.some((c) => c.startsWith('createProfile') && c.includes('worker')), 'reconcile does not create a worker');
});

test('raising workers from 0 to 1 provisions a worker profile on the next run', async () => {
  const t = provApp();
  const d = await t.create('Grow', { inventory: NO_WORKERS });
  await t.provision(d.id);
  await t.app.inject({ method: 'PATCH', url: `/api/departments/${d.id}/inventory`, payload: { limits: { maxConcurrentWorkers: 1 } } });
  const res = await t.provision(d.id);
  assert.equal(res.json().state, 'ready', res.body);
  assert.ok(t.hermes.profiles.has(profileNamesForDepartment(d.id).worker));
});

test('with no workers, a quest tells the chief to do the work itself, and only the chief may hold tasks', async () => {
  const t = questApp();
  const d = await t.readyDept('Solo', NO_WORKERS);
  assert.equal(d.worker, null);
  const res = await t.create(d.id, { objective: 'Write the report' });
  assert.equal(res.statusCode, 201, res.body);
  const { questId } = res.json();
  const raw = await t.kanban.getTask(d.board, questId);
  assert.match(raw.task.body!, /no workers: do the work yourself/);
  assert.ok(!raw.task.body!.includes('vc-'), 'no worker profile is named');

  t.kanban.seedTask(d.board, { title: 'Self task', assignee: d.chief, parents: [questId] });
  t.kanban.seedTask(d.board, { title: 'Foreign task', assignee: 'someone-else', parents: [questId] });
  const q = await t.get_(d.id, questId);
  assert.equal(q.violations.length, 1, JSON.stringify(q.violations));
  assert.match(q.violations[0], /someone-else.*no workers/);
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

test('runtime defaults return 503 when Hermes is unreachable', async () => {
  const t = provApp();
  t.hermes.failNext('getToolsets', new HermesUnavailableError('down'));
  assert.equal((await t.app.inject('/api/runtime/defaults')).statusCode, 503);
});
