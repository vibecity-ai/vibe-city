import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATES, TemplateSchema } from '@vibe-city/shared';
import { memApp } from './testUtils.ts';
import { readdirSync, readFileSync } from 'node:fs';

test('every template parses and has a lead plus teammates with distinct titles', () => {
  for (const t of TEMPLATES) {
    TemplateSchema.parse(t);
    assert.ok(t.hidden || t.seats.length >= 3, `${t.id} is a team`);
    assert.equal(new Set(t.seats.map((s) => s.title)).size, t.seats.length, `${t.id} titles are distinct`);
    assert.equal(t.inventory.limits.dailyBudgetCredits, t.dailyBudgetCredits);
    // without the skills toolset the agents could not load the skills the template names
    for (const ts of ['skills', 'memory', 'todo']) assert.ok(t.inventory.allowedToolsets.includes(ts as never), `${t.id} has ${ts}`);
  }
  assert.deepEqual(TEMPLATES.map((t) => t.id), ['treasury-ops', 'trading-desk', 'prediction-desk', 'chief-of-staff']);
});

test('hiring Treasury Ops creates three agents with their titles and no schedule', async () => {
  const { app, db } = memApp();
  const r = await app.inject({ method: 'POST', url: '/api/departments', payload: { name: 'Treasury', template: 'treasury-ops' } });
  assert.equal(r.statusCode, 201, r.body);
  const d = r.json();
  assert.deepEqual(d.agents.map((a: any) => [a.key, a.title]), [['chief', 'Head of Treasury Ops'], ['W-01', 'Swap Operator'], ['W-02', 'Reconciler']]);
  assert.match(d.purpose, /dao account=/, 'the template purpose is copied');
  assert.equal(d.templateId, 'treasury-ops', 'the floor knows its template (its station and screens)');
  const inv = (await app.inject(`/api/departments/${d.id}/inventory`)).json();
  assert.deepEqual(inv.allowedSkillIds, ['agent-custody', 'defillama'], 'swaps go through agent-custody only; defillama prices them');
  assert.deepEqual(inv.allowedToolsets, ['web', 'terminal', 'skills', 'memory', 'todo', 'session_search', 'clarify']);
  assert.equal(inv.limits.dailyBudgetCredits, 300);
  assert.equal((db.prepare('SELECT template_id FROM department WHERE id = ?').get(d.id) as { template_id: string }).template_id, 'treasury-ops');
  assert.equal((await app.inject(`/api/schedules?departmentId=${d.id}`)).json().schedules.length, 0);
  // the persona keeps the seat title (the dialogue window and the hover card read it)
  const swapper = (await app.inject(`/api/departments/${d.id}/characters/W-01`)).json();
  assert.equal(swapper.title, 'Swap Operator');
});

test('there is one Treasury Ops per company: a second is refused while the first is active, and the grid shows it taken', async () => {
  const { app } = memApp();
  const hire = (name: string) => app.inject({ method: 'POST', url: '/api/departments', payload: { name, template: 'treasury-ops' } });
  const hired = async () => Object.fromEntries((await app.inject('/api/templates')).json().map((t: any) => [t.id, t.hired]));
  assert.deepEqual(await hired(), { 'treasury-ops': false, 'trading-desk': false, 'prediction-desk': false });
  const first = await hire('Treasury');
  assert.equal(first.statusCode, 201, first.body);
  const second = await hire('Treasury Two');
  assert.equal(second.statusCode, 409);
  assert.match(second.json().message, /one per company/);
  assert.deepEqual(await hired(), { 'treasury-ops': true, 'trading-desk': false, 'prediction-desk': false });
  assert.equal((await app.inject({ method: 'POST', url: '/api/departments', payload: { name: 'Desk', template: 'trading-desk' } })).statusCode, 201, 'other templates are not single');
  // archived, it frees the slot
  await app.inject({ method: 'DELETE', url: `/api/departments/${first.json().id}` });
  assert.equal((await hire('Treasury Two')).statusCode, 201);
});

test('hiring the Trading Desk creates four agents and one disabled schedule', async () => {
  const { app } = memApp();
  const td = (await app.inject({ method: 'POST', url: '/api/departments', payload: { name: 'Trading', template: 'trading-desk' } })).json();
  assert.equal(td.agents.length, 4);
  assert.deepEqual(td.agents.find((a: any) => a.title === 'Perps Trader').skills, ['hyperliquid-connector']);
  const scheds = (await app.inject(`/api/schedules?departmentId=${td.id}`)).json().schedules;
  assert.equal(scheds.length, 1);
  assert.equal(scheds[0].enabled, false);
  // a department without a template keeps the plain generated titles and no `title` on its agents
  const plain = (await app.inject({ method: 'POST', url: '/api/departments', payload: { name: 'Plain', teammates: 1 } })).json();
  assert.ok(plain.agents.every((a: any) => !('title' in a)));
  assert.equal((await app.inject({ method: 'POST', url: '/api/departments', payload: { name: 'X', template: 'nope' } })).statusCode, 400);
  const list = (await app.inject('/api/templates')).json();
  assert.equal(list.length, 3);
  // without NEAR AI connected, hiring is off: every card points at that quest first
  const saved = process.env.NEAR_AI_API_KEY;
  delete process.env.NEAR_AI_API_KEY;
  try {
    const { app: fresh } = memApp();
    const off = (await fresh.inject('/api/templates')).json();
    assert.ok(off.every((t: any) => t.locked && t.unlocks === 'connect-ai'));
    process.env.NEAR_AI_API_KEY = 'test-key';
    const { app: on } = memApp();
    assert.equal((await on.inject('/api/templates')).json()[0].unlocks, 'connect-ai', 'a key alone is not enough: the Chief of Staff needs a model');
    await on.inject({ method: 'PATCH', url: '/api/company/settings', payload: { chiefOfStaffModel: 'deepseek/deepseek-v4.1-flash' } });
    const tl = (await on.inject('/api/templates')).json();
    assert.equal(tl.find((t: any) => t.id === 'trading-desk').unlocks, 'connect-hyperliquid');
    assert.equal(tl.find((t: any) => t.id === 'trading-desk').locked, true);
  } finally { if (saved === undefined) delete process.env.NEAR_AI_API_KEY; else process.env.NEAR_AI_API_KEY = saved; }
});

test('every skill a template names is installed in the container (else it stays silently disabled)', () => {
  const dir = new URL('../../../docker/skills/', import.meta.url);
  const vendored = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  const optional = readFileSync(new URL('HERMES_OPTIONAL', dir), 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => l.trim().split('/').pop()!);
  // bundled with Hermes 0.22.6 (the pinned image), seeded into every profile
  const builtin = ['github', 'requesting-code-review', 'test-driven-development', 'systematic-debugging', 'codebase-inspection', 'spike', 'simplify-code', 'dogfood'];
  const known = new Set([...vendored, ...optional, ...builtin]);
  for (const t of TEMPLATES) for (const s of t.inventory.allowedSkillIds) assert.ok(known.has(s), `${t.id}: skill ${s} is not installed by docker/cont-init.d/04-vibe-city-skills`);
});

test('every wallet floor can reach OutLayer (curl needs terminal) and names no skill the container cannot run', () => {
  for (const t of TEMPLATES.filter((x) => x.wallet === 'company')) {
    assert.ok(t.inventory.allowedToolsets.includes('terminal'), `${t.id}: agent-custody and the connectors are curl calls`);
    assert.ok(!t.inventory.allowedSkillIds.includes('risk-metrics-calculation'), `${t.id}: needs numpy/pandas, not in the image`);
  }
});
