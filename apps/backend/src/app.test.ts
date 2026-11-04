import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openDb } from './db/db.ts';
import { buildApp } from './app.ts';
import { createDept, memApp, tempDir } from './testUtils.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---- company / executive office -------------------------------------------

test('fresh install has exactly one company and the Executive Office on top', async () => {
  const { app, db } = memApp();
  const res = await app.inject('/api/company');
  assert.equal(res.statusCode, 200);
  const c = res.json();
  assert.equal(c.executiveOffice.deletable, false);
  assert.equal(c.executiveOffice.position, 'top');
  assert.deepEqual(c.floors, [{ kind: 'executive' }]);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM company').get() as { n: number }).n, 1);
  // building the app again over the same DB must not create a second company
  const again = buildApp(db);
  assert.equal((await again.inject('/api/company')).json().id, c.id);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM company').get() as { n: number }).n, 1);
});

test('Executive Office is not a department and cannot be deleted or modified', async () => {
  const { app } = memApp();
  for (const method of ['DELETE', 'PATCH', 'GET'] as const) {
    const res = await app.inject({ method, url: '/api/departments/executive-office', payload: method === 'PATCH' ? { name: 'x' } : undefined });
    assert.equal(res.statusCode, 404, method);
  }
  assert.deepEqual((await app.inject('/api/departments')).json().departments, []);
});

// ---- create / read ---------------------------------------------------------

test('creates departments with arbitrary names, UUIDs, defaults', async () => {
  const { app } = memApp();
  const { res, json } = await createDept(app, { name: '  Café ☕ 研究 / R&D  ', purpose: 'anything goes' });
  assert.equal(res.statusCode, 201);
  assert.match(json.id, UUID);
  assert.equal(json.name, 'Café ☕ 研究 / R&D');
  assert.equal(json.state, 'unconfigured');
  assert.equal(json.boardSyncState, 'not_provisioned');
  assert.equal(json.hermesBoardRef, null);
  assert.equal(json.agents.length, 1, 'a department starts with its lead');
  assert.deepEqual([json.agents[0].key, json.agents[0].lead, json.agents[0].profileRef], ['chief', true, null]);
  const got = (await app.inject(`/api/departments/${json.id}`)).json();
  assert.deepEqual(got, json);
});

test('board slug derives from the immutable id and survives renames', async () => {
  const { app } = memApp();
  const d = (await createDept(app, { name: 'Engineering' })).json;
  assert.equal(d.hermesBoardSlug, `vc-${d.id}`);
  assert.match(d.hermesBoardSlug, /^[a-z0-9][a-z0-9\-_]{0,63}$/); // Hermes slug rule
  const renamed = (await app.inject({ method: 'PATCH', url: `/api/departments/${d.id}`, payload: { name: 'Eng 2' } })).json();
  assert.equal(renamed.hermesBoardSlug, d.hermesBoardSlug);
  assert.equal(renamed.id, d.id);
});

test('GET unknown or malformed id is 404', async () => {
  const { app } = memApp();
  assert.equal((await app.inject('/api/departments/not-a-uuid')).statusCode, 404);
  assert.equal((await app.inject('/api/departments/00000000-0000-4000-8000-000000000000')).statusCode, 404);
});

// ---- validation -----------------------------------------------------------

test('rejects invalid department input', async () => {
  const { app } = memApp();
  const bad: Record<string, unknown>[] = [
    {}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(81) }, { name: 5 },
    { name: 'A', purpose: 'p'.repeat(2001) },
    { name: 'A', surprise: true },
    { name: 'A', inventory: { allowedToolsets: ['rm -rf'] } },
    { name: 'A', teammates: -1 },
    { name: 'A', teammates: 11 },
    { name: 'A', teammates: 1.5 },
    { name: 'A', inventory: { limits: { maxConcurrentWorkers: 1 } } },
    { name: 'A', inventory: { limits: { maxDelegationDepth: 2 } } },
    { name: 'A', inventory: { allowedSkillIds: [''] } },
    { name: 'A', inventory: { unknownField: 1 } },
  ];
  for (const body of bad) {
    const { res } = await createDept(app, body);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
  }
  assert.deepEqual((await app.inject('/api/departments')).json().departments, []);
});

test('invalid JSON body is a 4xx, not a crash', async () => {
  const { app } = memApp();
  const res = await app.inject({ method: 'POST', url: '/api/departments', payload: '{nope', headers: { 'content-type': 'application/json' } });
  assert.equal(res.statusCode, 400);
});

test('teammates are created as agents of their own; only the lead profile can be associated', async () => {
  const { app } = memApp();
  const d = (await createDept(app, { name: 'A', teammates: 2 })).json;
  assert.deepEqual(d.agents.map((a: any) => [a.key, a.lead]), [['chief', true], ['W-01', false], ['W-02', false]]);
  const url = `/api/departments/${d.id}`;
  assert.equal((await app.inject({ method: 'PATCH', url, payload: { leadProfileRef: 'Bad Name!' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url, payload: { workerProfileRef: 'vc-worker' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url, payload: {} })).statusCode, 400);
  const ok = (await app.inject({ method: 'PATCH', url, payload: { leadProfileRef: 'vc-lead' } })).json();
  assert.equal(ok.agents[0].profileRef, 'vc-lead');
  assert.equal(ok.agents[1].profileRef, null);
  assert.equal(ok.state, 'unconfigured', 'still unconfigured until the board is synced');
});

// ---- duplicates ------------------------------------------------------------

test('duplicate names (case/space-insensitive) are rejected; rename collisions too', async () => {
  const { app } = memApp();
  const a = (await createDept(app, { name: 'Research' })).json;
  assert.equal((await createDept(app, { name: ' research ' })).res.statusCode, 409);
  const b = (await createDept(app, { name: 'Ops' })).json;
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/departments/${b.id}`, payload: { name: 'RESEARCH' } })).statusCode, 409);
  // renaming to its own name (different case) is fine
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/departments/${a.id}`, payload: { name: 'RESEARCH' } })).statusCode, 200);
});

test('an archived department frees its name', async () => {
  const { app } = memApp();
  const a = (await createDept(app, { name: 'Research' })).json;
  await app.inject({ method: 'DELETE', url: `/api/departments/${a.id}` });
  const again = await createDept(app, { name: 'Research' });
  assert.equal(again.res.statusCode, 201);
  assert.notEqual(again.json.id, a.id);
  assert.notEqual(again.json.hermesBoardSlug, a.hermesBoardSlug);
});

// ---- floor order ------------------------------------------------------------

// ---- inventory -------------------------------------------------------------

test('inventory defaults, partial patch merge, and persistence of limits', async () => {
  const { app } = memApp();
  const d = (await createDept(app, { name: 'A' })).json;
  const url = `/api/departments/${d.id}/inventory`;
  const inv0 = (await app.inject(url)).json();
  assert.deepEqual(inv0, {
    allowedSkillIds: [], allowedMcpTools: [], model: null, allowedToolsets: [], sharedContextRefs: [],
    limits: { maxTaskRuntimeSeconds: null, maxDelegationDepth: 1 },
  });
  const p1 = await app.inject({ method: 'PATCH', url, payload: {
    allowedSkillIds: ['pdf', 'pdf', 'arxiv'], allowedMcpTools: ['github:create_issue'], allowedToolsets: ['file', 'file', 'kanban'],
    limits: { maxDelegationDepth: 1 },
  } });
  assert.equal(p1.statusCode, 200);
  const p2 = (await app.inject({ method: 'PATCH', url, payload: { limits: { maxTaskRuntimeSeconds: 600 }, model: { provider: 'near-ai', id: 'm1' } } })).json();
  assert.deepEqual(p2.model, { provider: 'near-ai', id: 'm1' });
  assert.deepEqual(p2.allowedSkillIds, ['pdf', 'arxiv'], 'deduped, kept');
  assert.deepEqual(p2.allowedToolsets, ['file', 'kanban']);
  assert.deepEqual(p2.limits, { maxTaskRuntimeSeconds: 600, maxDelegationDepth: 1 });
  assert.deepEqual((await app.inject(url)).json(), p2);
});

test('inventory patch rejects bad values and leaves stored inventory untouched', async () => {
  const { app } = memApp();
  const d = (await createDept(app, { name: 'A', inventory: { allowedSkillIds: ['x'] } })).json;
  const url = `/api/departments/${d.id}/inventory`;
  for (const payload of [{ allowedToolsets: ['nope'] }, { limits: { maxConcurrentWorkers: 2 } }, { bogus: 1 }, { limits: { maxTaskRuntimeSeconds: 1 } }]) {
    assert.equal((await app.inject({ method: 'PATCH', url, payload })).statusCode, 400, JSON.stringify(payload));
  }
  assert.deepEqual((await app.inject(url)).json().allowedSkillIds, ['x']);
});

// ---- safe deletion -----------------------------------------------------------

test('DELETE archives: hidden from default list, history and inventory retained, no Hermes deletion implied', async () => {
  const db = openDb(':memory:');
  const app = buildApp(db);
  const d = (await createDept(app, { name: 'A', inventory: { allowedSkillIds: ['s'] } })).json;
  await app.inject({ method: 'PATCH', url: `/api/departments/${d.id}`, payload: { leadProfileRef: 'chief-a' } });
  const del = await app.inject({ method: 'DELETE', url: `/api/departments/${d.id}` });
  assert.equal(del.statusCode, 200);
  assert.equal(del.json().hermesResourcesRetained, true);
  assert.ok(del.json().department.archivedAt);
  assert.deepEqual((await app.inject('/api/departments')).json().departments, []);
  assert.equal((await app.inject('/api/departments?includeArchived=true')).json().departments.length, 1);
  assert.equal((await app.inject(`/api/departments/${d.id}`)).json().agents[0].profileRef, 'chief-a');
  assert.deepEqual((await app.inject(`/api/departments/${d.id}/inventory`)).json().allowedSkillIds, ['s']);
  // second delete, edit, and inventory edit are refused
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/departments/${d.id}` })).statusCode, 404);
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/departments/${d.id}`, payload: { name: 'Z' } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/departments/${d.id}/inventory`, payload: { allowedSkillIds: [] } })).statusCode, 409);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM department').get() as { n: number }).n, 1, 'row is kept');
});

// ---- persistence -------------------------------------------------------------

test('all organizational data survives a backend restart', async () => {
  const path = join(tempDir(), 'vc.sqlite');

  let db = openDb(path);
  let app = buildApp(db);
  const company = (await app.inject('/api/company')).json();
  const a = (await createDept(app, { name: 'Engineering', purpose: 'build', inventory: { allowedToolsets: ['file', 'terminal'] }, teammates: 4 })).json;
  const b = (await createDept(app, { name: 'Research', purpose: 'read' })).json;
  await app.inject({ method: 'PATCH', url: `/api/departments/${b.id}`, payload: { leadProfileRef: 'research-chief' } });
  const c = (await createDept(app, { name: 'Gone' })).json;
  await app.inject({ method: 'DELETE', url: `/api/departments/${c.id}` });
  const before = {
    company: (await app.inject('/api/company')).json(),
    list: (await app.inject('/api/departments?includeArchived=true')).json(),
    invA: (await app.inject(`/api/departments/${a.id}/inventory`)).json(),
  };
  await app.close();
  db.close();

  db = openDb(path);
  app = buildApp(db);
  assert.equal((await app.inject('/api/company')).json().id, company.id);
  assert.deepEqual((await app.inject('/api/company')).json(), before.company);
  assert.deepEqual((await app.inject('/api/departments?includeArchived=true')).json(), before.list);
  assert.deepEqual((await app.inject(`/api/departments/${a.id}/inventory`)).json(), before.invA);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM company').get() as { n: number }).n, 1);
  // new department after restart continues the floor sequence
  assert.equal((await createDept(app, { name: 'Ops' })).json.floorOrder, 4);
});
