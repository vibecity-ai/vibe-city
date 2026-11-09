import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATES, TemplateSchema } from '@vibe-city/shared';
import { memApp } from './testUtils.ts';
import { readdirSync, readFileSync } from 'node:fs';

test('every template parses and has a lead plus teammates with distinct titles', () => {
  for (const t of TEMPLATES) {
    TemplateSchema.parse(t);
    assert.ok(t.seats.length >= 3, `${t.id} is a team`);
    assert.equal(new Set(t.seats.map((s) => s.title)).size, t.seats.length, `${t.id} titles are distinct`);
    assert.equal(t.inventory.limits.dailyBudgetCredits, t.dailyBudgetCredits);
  }
  assert.deepEqual(TEMPLATES.map((t) => t.id), ['software', 'marketplace-agency', 'treasury-ops', 'trading-desk', 'token-treasury', 'prediction-desk', 'red-team', 'blue-team']);
});

test('hiring the Software Department creates four agents with their titles and no schedule', async () => {
  const { app, db } = memApp();
  const r = await app.inject({ method: 'POST', url: '/api/departments', payload: { name: 'Software', template: 'software' } });
  assert.equal(r.statusCode, 201, r.body);
  const d = r.json();
  assert.deepEqual(d.agents.map((a: any) => [a.key, a.title]), [['chief', 'Engineering Manager'], ['W-01', 'Coder'], ['W-02', 'QA & Testing'], ['W-03', 'DevOps']]);
  assert.match(d.purpose, /pr url=/, 'the template purpose is copied');
  assert.equal(d.templateId, 'software', 'the floor knows its template (its station and screens)');
  const inv = (await app.inject(`/api/departments/${d.id}/inventory`)).json();
  assert.deepEqual(inv.allowedToolsets, ['terminal', 'file', 'code_execution', 'web']);
  assert.equal(inv.limits.dailyBudgetCredits, 1000);
  assert.equal((db.prepare('SELECT template_id FROM department WHERE id = ?').get(d.id) as { template_id: string }).template_id, 'software');
  assert.equal((await app.inject(`/api/schedules?departmentId=${d.id}`)).json().schedules.length, 0);
  // the persona keeps the seat title (the dialogue window and the hover card read it)
  const coder = (await app.inject(`/api/departments/${d.id}/characters/W-01`)).json();
  assert.equal(coder.title, 'Coder');
});

test('hiring the Trading Desk creates four agents and one disabled schedule; the Red Team seats use the abliterated model', async () => {
  const { app } = memApp();
  const td = (await app.inject({ method: 'POST', url: '/api/departments', payload: { name: 'Trading', template: 'trading-desk' } })).json();
  assert.equal(td.agents.length, 4);
  assert.deepEqual(td.agents.find((a: any) => a.title === 'Perps Trader').skills, ['hyperliquid-connector']);
  const scheds = (await app.inject(`/api/schedules?departmentId=${td.id}`)).json().schedules;
  assert.equal(scheds.length, 1);
  assert.equal(scheds[0].enabled, false);
  const red = (await app.inject({ method: 'POST', url: '/api/departments', payload: { name: 'Red', template: 'red-team' } })).json();
  assert.ok(red.agents.every((a: any) => a.model?.id === 'deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated'));
  // a department without a template keeps the plain generated titles and no `title` on its agents
  const plain = (await app.inject({ method: 'POST', url: '/api/departments', payload: { name: 'Plain', teammates: 1 } })).json();
  assert.ok(plain.agents.every((a: any) => !('title' in a)));
  assert.equal((await app.inject({ method: 'POST', url: '/api/departments', payload: { name: 'X', template: 'nope' } })).statusCode, 400);
  const list = (await app.inject('/api/templates')).json();
  assert.equal(list.length, 8);
  // without NEAR AI connected, hiring is off: every card points at that quest first
  const saved = process.env.NEAR_AI_API_KEY;
  delete process.env.NEAR_AI_API_KEY;
  try {
    const { app: fresh } = memApp();
    const off = (await fresh.inject('/api/templates')).json();
    assert.ok(off.every((t: any) => t.locked && t.unlocks === 'connect-ai'));
    process.env.NEAR_AI_API_KEY = 'test-key';
    const { app: on } = memApp();
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
