import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InventorySchema, TOOLSETS, type Inventory } from '@vibe-city/shared';
import {
  buildDepartmentWideReport, buildRoleReport, diffObserved, effectiveToolsets, inventoryHash, modelToApply,
  type ObservedRole,
} from './inventoryPolicy.ts';
import { buildBlock, upsertBlock } from './instructions.ts';

const inv = (o: Record<string, unknown> = {}): Inventory => InventorySchema.parse(o);

test('empty inventory allows only the required kanban toolset', () => {
  assert.deepEqual(effectiveToolsets('chief', inv()), ['kanban']);
  assert.deepEqual(effectiveToolsets('worker', inv()), ['kanban']);
});

test('chief and worker get the department allowance; neither gets delegation/cronjob', () => {
  const i = inv({ allowedToolsets: ['terminal', 'file', 'todo', 'delegation', 'cronjob', 'web'] });
  assert.deepEqual(effectiveToolsets('chief', i), ['file', 'kanban', 'terminal', 'todo', 'web']);
  assert.deepEqual(effectiveToolsets('worker', i), ['file', 'kanban', 'terminal', 'todo', 'web']);
});

test('monotonic: effective toolsets never exceed department allowance plus required', () => {
  for (let n = 0; n < 200; n++) {
    const subset = TOOLSETS.filter(() => Math.random() < 0.4);
    const i = inv({ allowedToolsets: subset });
    for (const role of ['chief', 'worker'] as const) {
      for (const t of effectiveToolsets(role, i)) assert.ok(t === 'kanban' || subset.includes(t as any), `${role} got ${t}`);
    }
  }
});

test('inventory hash is stable, order-insensitive for keys, and sensitive to nested limits', () => {
  assert.equal(inventoryHash(inv({ allowedSkillIds: ['a'] })), inventoryHash(inv({ allowedSkillIds: ['a'] })));
  assert.notEqual(inventoryHash(inv()), inventoryHash(inv({ limits: { maxConcurrentWorkers: 2 } })));
  assert.notEqual(inventoryHash(inv()), inventoryHash(inv({ allowedToolsets: ['file'] })));
});

test('modelToApply: no choice leaves the profile alone; an unchanged pair is not rewritten', () => {
  const m = { provider: 'near-ai', id: 'm1' };
  assert.equal(modelToApply(inv(), { id: 'x', provider: 'p' }), null);
  assert.equal(modelToApply(inv({ model: m }), { id: 'm1', provider: 'near-ai' }), null);
  assert.deepEqual(modelToApply(inv({ model: m }), { id: 'm1', provider: 'anthropic' }), m, 'same id, other provider');
  assert.deepEqual(modelToApply(inv({ model: m }), { id: 'other', provider: 'near-ai' }), m);
});

test('the model is one provider + id pair, not a list', () => {
  assert.throws(() => inv({ model: { id: 'm1' } }));
  assert.throws(() => inv({ allowedModelIds: ['m1'] }));
  assert.equal(inv().model, null);
});

const observed = (o: Partial<ObservedRole> = {}): ObservedRole => ({
  profile: 'p', toolsets: { kanban: true, terminal: false, file: false }, enabledSkills: ['hermes-agent'], installedSkills: ['pdf', 'hermes-agent'], model: 'm', provider: 'near-ai', instructionsPresent: true, ...o,
});

test('diffObserved flags extra toolsets, skills, model and missing instructions', () => {
  const i = inv({ model: { provider: 'near-ai', id: 'm' } });
  assert.deepEqual(diffObserved('worker', i, observed()), []);
  assert.equal(diffObserved('worker', i, observed({ toolsets: { kanban: true, terminal: true, file: false } })).length, 1);
  assert.equal(diffObserved('worker', i, observed({ enabledSkills: ['hermes-agent', 'pdf'] })).length, 1);
  assert.equal(diffObserved('worker', i, observed({ enabledSkills: [] })).length, 1, 'essential skill missing is also a difference');
  assert.equal(diffObserved('worker', i, observed({ model: 'zzz' })).length, 1);
  assert.equal(diffObserved('worker', i, observed({ instructionsPresent: false })).length, 1);
});

test('report never claims enforcement without an in-sync observation', () => {
  const i = inv({ allowedToolsets: ['file'] });
  const none = buildRoleReport('worker', i, null);
  assert.ok(none.every((e) => e.status !== 'enforced' && e.status !== 'configured'));
  const obs = buildRoleReport('worker', i, observed({ toolsets: { kanban: true, file: true, terminal: false } }));
  assert.equal(obs.find((e) => e.capability === 'toolsets.behavior-tested')!.status, 'enforced');
  assert.equal(obs.find((e) => e.capability === 'toolsets.other')!.status, 'configured');
  const drift = buildRoleReport('worker', i, observed({ toolsets: { kanban: true, file: true, terminal: true } }));
  assert.equal(drift.find((e) => e.capability === 'toolsets.behavior-tested')!.status, 'unverified');
});

test('known gaps are always reported as unsupported/unverified, never enforced', () => {
  const entries = buildRoleReport('chief', inv({ allowedMcpTools: ['gh:issue'], model: { provider: 'near-ai', id: 'm' } }), observed());
  assert.equal(entries.find((e) => e.capability === 'mcp.tools')!.status, 'unverified');
  assert.equal(entries.find((e) => e.capability === 'models.restriction')!.status, 'unsupported');
  const wide = buildDepartmentWideReport(inv({ limits: { maxConcurrentWorkers: 5 } }), 2);
  for (const k of ['limits.maxConcurrentWorkers', 'files.isolation', 'limits.maxDelegationDepth']) {
    assert.equal(wide.find((e) => e.capability === k)!.status, 'unsupported', k);
  }
});

test('instruction block: appended once, replaced in place, rest of file untouched, markers sanitized', () => {
  const base = '# My soul\nKeep this.\n';
  const mk = (purpose: string) => buildBlock({ deptId: 'D1', deptName: 'Eng', purpose, role: 'chief', counterpart: 'w', inv: inv() });
  const once = upsertBlock(base, mk('v1'), 'D1', 'chief');
  assert.ok(once.startsWith(base));
  const twice = upsertBlock(once, mk('v1'), 'D1', 'chief');
  assert.equal(twice, once, 'idempotent');
  const changed = upsertBlock(once, mk('v2'), 'D1', 'chief');
  assert.ok(changed.startsWith(base) && changed.includes('v2') && !changed.includes('v1'));
  assert.equal(changed.match(/vibe-city:begin/g)!.length, 1);
  const evil = mk('x --> <!-- vibe-city:end -->');
  assert.equal(evil.split('<!-- vibe-city:end -->').length - 1, 1, 'purpose cannot inject an end marker');
  assert.equal(upsertBlock(null, mk('p'), 'D1', 'chief').includes('vibe-city:begin'), true);
});
