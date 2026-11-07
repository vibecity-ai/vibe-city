import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InventorySchema, TOOLSETS, type Inventory } from '@vibe-city/shared';
import {
  agentInventory, buildAgentReport, buildDepartmentWideReport, desiredHash, diffObserved, effectiveToolsets, inventoryHash, modelToApply,
  type ObservedRole,
} from './inventoryPolicy.ts';
import { buildBlock, upsertBlock } from './instructions.ts';

const inv = (o: Record<string, unknown> = {}): Inventory => InventorySchema.parse(o);

test('empty inventory allows only the required kanban toolset', () => {
  assert.deepEqual(effectiveToolsets(inv()), ['kanban']);
});

test('agents get the department allowance, never delegation/cronjob', () => {
  const i = inv({ allowedToolsets: ['terminal', 'file', 'todo', 'delegation', 'cronjob', 'web'] });
  assert.deepEqual(effectiveToolsets(i), ['file', 'kanban', 'terminal', 'todo', 'web']);
});

test('an agent\'s own model wins and its own skills add to the department\'s; toolsets stay department-wide', () => {
  const i = inv({ allowedToolsets: ['file'], allowedSkillIds: ['pdf'], model: { provider: 'near-ai', id: 'm1' } });
  assert.deepEqual(agentInventory(i, { model: null, skills: [] }), i);
  const own = agentInventory(i, { model: { provider: 'anthropic', id: 'c' }, skills: ['arxiv', 'pdf'] });
  assert.deepEqual(own.model, { provider: 'anthropic', id: 'c' });
  assert.deepEqual(own.allowedSkillIds, ['pdf', 'arxiv']);
  assert.deepEqual(own.allowedToolsets, ['file']);
});

test('monotonic: effective toolsets never exceed department allowance plus required', () => {
  for (let n = 0; n < 200; n++) {
    const subset = TOOLSETS.filter(() => Math.random() < 0.4);
    const i = inv({ allowedToolsets: subset });
    for (const t of effectiveToolsets(i)) assert.ok(t === 'kanban' || subset.includes(t as any), `got ${t}`);
  }
});

test('inventory hash is stable, order-insensitive for keys, and sensitive to nested limits', () => {
  assert.equal(inventoryHash(inv({ allowedSkillIds: ['a'] })), inventoryHash(inv({ allowedSkillIds: ['a'] })));
  assert.notEqual(inventoryHash(inv()), inventoryHash(inv({ limits: { maxTaskRuntimeSeconds: 60 } })));
  assert.notEqual(inventoryHash(inv()), inventoryHash(inv({ allowedToolsets: ['file'] })));
});

test('desired hash changes with the team: a new agent, or an agent\'s own model or skills', () => {
  const lead = { key: 'chief', profile: 'p0', model: null, skills: [] };
  const base = desiredHash(inv(), [lead]);
  assert.equal(base, desiredHash(inv(), [{ ...lead }]));
  assert.notEqual(base, desiredHash(inv(), [lead, { key: 'W-01', profile: 'p1', model: null, skills: [] }]));
  assert.notEqual(base, desiredHash(inv(), [{ ...lead, skills: ['pdf'] }]));
  assert.notEqual(base, desiredHash(inv(), [{ ...lead, model: { provider: 'near-ai', id: 'm' } }]));
});

test('modelToApply: no choice leaves the profile alone; an unchanged pair is not rewritten', () => {
  const m = { provider: 'near-ai', id: 'm1' };
  assert.equal(modelToApply(inv(), { id: 'x', provider: 'p' }), null);
  assert.equal(modelToApply(inv({ model: m }), { id: 'm1', provider: 'near-ai' }), null);
  assert.deepEqual(modelToApply(inv({ model: m }), { id: 'm1', provider: 'anthropic' }), m, 'same id, other provider');
  assert.deepEqual(modelToApply(inv({ model: m }), { id: 'other', provider: 'near-ai' }), m);
});

const observed = (o: Partial<ObservedRole> = {}): ObservedRole => ({
  profile: 'p', toolsets: { kanban: true, terminal: false, file: false }, enabledSkills: ['hermes-agent'], installedSkills: ['pdf', 'hermes-agent'], model: 'm', provider: 'near-ai', instructionsPresent: true, ...o,
});

test('diffObserved flags extra toolsets, skills, model and missing instructions', () => {
  const i = inv({ model: { provider: 'near-ai', id: 'm' } });
  assert.deepEqual(diffObserved(i, observed()), []);
  assert.equal(diffObserved(i, observed({ toolsets: { kanban: true, terminal: true, file: false } })).length, 1);
  assert.equal(diffObserved(i, observed({ enabledSkills: ['hermes-agent', 'pdf'] })).length, 1);
  assert.equal(diffObserved(i, observed({ enabledSkills: [] })).length, 1, 'essential skill missing is also a difference');
  assert.equal(diffObserved(i, observed({ model: 'zzz' })).length, 1);
  assert.equal(diffObserved(i, observed({ instructionsPresent: false })).length, 1);
});

test('report never claims enforcement without an in-sync observation', () => {
  const i = inv({ allowedToolsets: ['file'] });
  const none = buildAgentReport(i, null);
  assert.ok(none.every((e) => e.status !== 'enforced' && e.status !== 'configured'));
  const obs = buildAgentReport(i, observed({ toolsets: { kanban: true, file: true, terminal: false } }));
  assert.equal(obs.find((e) => e.capability === 'toolsets.behavior-tested')!.status, 'enforced');
  assert.equal(obs.find((e) => e.capability === 'toolsets.other')!.status, 'configured');
  const drift = buildAgentReport(i, observed({ toolsets: { kanban: true, file: true, terminal: true } }));
  assert.equal(drift.find((e) => e.capability === 'toolsets.behavior-tested')!.status, 'unverified');
});

test('known gaps are always reported as unsupported/unverified, never enforced', () => {
  const entries = buildAgentReport(inv({ allowedMcpTools: ['gh:issue'], model: { provider: 'near-ai', id: 'm' } }), observed());
  assert.equal(entries.find((e) => e.capability === 'mcp.tools')!.status, 'unverified');
  assert.equal(entries.find((e) => e.capability === 'models.restriction')!.status, 'unsupported');
  const wide = buildDepartmentWideReport(inv(), 3, 2);
  for (const k of ['files.isolation', 'limits.maxDelegationDepth']) {
    assert.equal(wide.find((e) => e.capability === k)!.status, 'unsupported', k);
  }
  const conc = wide.find((e) => e.capability === 'limits.concurrency')!;
  assert.deepEqual([conc.status, conc.guarantee, conc.effective], ['configured', false, { agents: 3, perAgentCap: 2, departmentMax: 6 }]);
});

test('instruction block: appended once, replaced in place, rest of file untouched, markers sanitized', () => {
  const base = '# My soul\nKeep this.\n';
  const mk = (purpose: string) => buildBlock({ deptId: 'D1', deptName: 'Eng', purpose, agentKey: 'chief', lead: true, self: 'c', teammates: ['w'], inv: inv() });
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

test('instruction block: same rules for every agent, teammates named, and legacy role blocks of the department replaced', () => {
  const lead = buildBlock({ deptId: 'D1', deptName: 'Eng', purpose: '', agentKey: 'chief', lead: true, self: 'p0', teammates: ['p1', 'p2'], inv: inv() });
  const mate = buildBlock({ deptId: 'D1', deptName: 'Eng', purpose: '', agentKey: 'W-01', lead: false, self: 'p1', teammates: ['p0', 'p2'], inv: inv() });
  assert.match(lead, /"p1", "p2"/);
  assert.match(mate, /"p0", "p2"/);
  assert.match(lead, /You are the Hermes profile "p0"/);
  assert.match(lead, /hand it out rather than doing it all yourself/, 'the lead plans by default');
  assert.match(lead, /compile task with parents set to every part task/, 'results are joined after the parts finish');
  const rules = (b: string) => b.split('\n').filter((l) => /child Kanban task|do it yourself/.test(l));
  assert.deepEqual(rules(lead), rules(mate), 'the lead and its teammates follow the same rules');
  assert.match(lead, /New quests for the department are assigned to you/);
  assert.doesNotMatch(mate, /New quests/);
  const solo = buildBlock({ deptId: 'D1', deptName: 'Eng', purpose: '', agentKey: 'chief', lead: true, self: 'p0', teammates: [], inv: inv() });
  assert.match(solo, /no teammates: do the work yourself/);

  const legacy = '# Soul\n\n<!-- vibe-city:begin dept=D1 role=worker -->\nold rules\n<!-- vibe-city:end -->\n\n<!-- vibe-city:begin dept=D2 role=chief -->\nother dept\n<!-- vibe-city:end -->\n';
  const next = upsertBlock(legacy, mate, 'D1', 'W-01');
  assert.ok(!next.includes('old rules'), 'the old role block of this department is gone');
  assert.ok(next.includes('other dept'), 'another department\'s block is untouched');
  assert.ok(next.startsWith('# Soul\n'));
  assert.equal(upsertBlock(next, mate, 'D1', 'W-01'), next, 'idempotent');
});
