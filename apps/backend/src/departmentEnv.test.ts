import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HermesUnavailableError } from './hermes/ports.ts';
import { createDept, questApp } from './testUtils.ts';

const E = (dept: string, name = '') => `/api/departments/${dept}/env${name ? `/${name}` : ''}`;

test('a floor variable goes into every agent profile and is never sent back', async () => {
  const t = questApp();
  const d = await t.readyDept('Eng');
  const put = await t.app.inject({ method: 'PUT', url: E(d.id, 'SERP_API_KEY'), payload: { value: 'sk-secret-123' } });
  assert.equal(put.statusCode, 200, put.body);
  assert.deepEqual(put.json().vars.map((v: { name: string; onAgents: boolean }) => [v.name, v.onAgents]), [['SERP_API_KEY', true]]);
  assert.equal(put.json().warning, null);
  for (const p of d.refs) assert.equal(t.hermes.env.get(p)?.SERP_API_KEY, 'sk-secret-123', p);
  const get = await t.app.inject(E(d.id));
  assert.ok(!get.body.includes('sk-secret'), 'the value never leaves the server');
  assert.ok(!put.body.includes('sk-secret'));

  const del = await t.app.inject({ method: 'DELETE', url: E(d.id, 'SERP_API_KEY') });
  assert.equal(del.statusCode, 200);
  assert.deepEqual(del.json().vars, []);
  for (const p of d.refs) assert.equal(t.hermes.env.get(p)?.SERP_API_KEY, undefined, 'removed from the profile');
  assert.equal((await t.app.inject({ method: 'DELETE', url: E(d.id, 'SERP_API_KEY') })).statusCode, 404);
});

test('names Vibe City manages, bad names and multi-line values are refused', async () => {
  const t = questApp();
  const d = await t.readyDept('Eng');
  for (const n of ['NEAR_AI_API_KEY', 'GH_TOKEN', 'API_SERVER_KEY', 'HERMES_HOME', 'PATH', 'lower_case', 'X', '1ABC']) {
    assert.equal((await t.app.inject({ method: 'PUT', url: E(d.id, n), payload: { value: 'v' } })).statusCode, 400, n);
  }
  for (const value of ['', 'a\nb', 'x'.repeat(4097)]) {
    assert.equal((await t.app.inject({ method: 'PUT', url: E(d.id, 'OK_NAME'), payload: { value } })).statusCode, 400, JSON.stringify(value));
  }
  assert.equal((await t.app.inject({ method: 'PUT', url: E('00000000-0000-4000-8000-000000000000', 'OK_NAME'), payload: { value: 'v' } })).statusCode, 404);
});

test('saved while Hermes is down or before the first sync, it reaches the agents at the sync', async () => {
  const t = questApp();
  const d = await t.readyDept('Eng');
  t.hermes.failNext('setProfileEnv', new HermesUnavailableError('down'));
  const put = (await t.app.inject({ method: 'PUT', url: E(d.id, 'BASE_URL'), payload: { value: 'https://x.test' } })).json();
  assert.equal(put.vars[0].onAgents, false);
  assert.match(put.warning, /next sync/);
  assert.equal((await t.app.inject({ method: 'POST', url: `/api/departments/${d.id}/provision` })).json().state, 'ready');
  for (const p of d.refs) assert.equal(t.hermes.env.get(p)?.BASE_URL, 'https://x.test');
  assert.equal((await t.app.inject(E(d.id))).json().vars[0].onAgents, true);

  const { json: raw } = await createDept(t.app, { name: 'Raw' });
  const early = (await t.app.inject({ method: 'PUT', url: E(raw.id, 'BASE_URL'), payload: { value: 'v' } })).json();
  assert.match(early.warning, /first synced/);
  const prov = (await t.app.inject({ method: 'POST', url: `/api/departments/${raw.id}/provision` })).json();
  for (const a of prov.agents as { ref: string }[]) assert.equal(t.hermes.env.get(a.ref)?.BASE_URL, 'v');
});

test('removing waits for Hermes: nothing is forgotten while an agent still has it', async () => {
  const t = questApp();
  const d = await t.readyDept('Eng');
  await t.app.inject({ method: 'PUT', url: E(d.id, 'TOKEN_A'), payload: { value: 'v' } });
  t.hermes.failNext('unsetProfileEnv', new HermesUnavailableError('down'));
  assert.equal((await t.app.inject({ method: 'DELETE', url: E(d.id, 'TOKEN_A') })).statusCode, 503);
  assert.equal((await t.app.inject(E(d.id))).json().vars.length, 1, 'still listed, so it can be removed again');
});
