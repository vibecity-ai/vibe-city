import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openDb } from './db/db.ts';
import { buildApp } from './app.ts';
import { createDept, memApp, tempDir } from './testUtils.ts';

const floors = async (app: ReturnType<typeof buildApp>) => (await app.inject('/api/company')).json().floors as any[];
const names = async (app: ReturnType<typeof buildApp>) =>
  (await app.inject('/api/departments')).json().departments.map((d: any) => d.name);

test('empty building: only the Executive Office', async () => {
  const { app } = memApp();
  assert.deepEqual(await floors(app), [{ kind: 'executive' }]);
});

test('each new department is inserted directly below the Executive Office; others shift down', async () => {
  const { app } = memApp();
  const a = (await createDept(app, { name: 'A' })).json;
  assert.equal(a.floorPosition, 1);
  const b = (await createDept(app, { name: 'B' })).json;
  assert.equal(b.floorPosition, 1);
  assert.equal((await app.inject(`/api/departments/${a.id}`)).json().floorPosition, 2, 'existing floor shifted down');
  assert.deepEqual(await floors(app), [{ kind: 'executive' }, { kind: 'department', departmentId: b.id }, { kind: 'department', departmentId: a.id }]);
  assert.deepEqual(await names(app), ['B', 'A']);
});

test('Executive Office stays on top through create, archive and rename', async () => {
  const { app } = memApp();
  const a = (await createDept(app, { name: 'A' })).json;
  await createDept(app, { name: 'B' });
  await app.inject({ method: 'PATCH', url: `/api/departments/${a.id}`, payload: { name: 'A renamed' } });
  await app.inject({ method: 'DELETE', url: `/api/departments/${a.id}` });
  assert.equal((await floors(app))[0].kind, 'executive');
  assert.equal((await floors(app)).length, 2);
});

test('archiving closes the gap and removes the floor position; archived departments keep their creation id', async () => {
  const { app } = memApp();
  const [a, b, c] = [(await createDept(app, { name: 'A' })).json, (await createDept(app, { name: 'B' })).json, (await createDept(app, { name: 'C' })).json];
  await app.inject({ method: 'DELETE', url: `/api/departments/${b.id}` });
  const list = (await app.inject('/api/departments')).json().departments;
  assert.deepEqual(list.map((d: any) => [d.name, d.floorPosition]), [['C', 1], ['A', 2]]);
  const archived = (await app.inject(`/api/departments/${b.id}`)).json();
  assert.equal(archived.floorPosition, null);
  assert.equal(archived.floorOrder, 2);
  const all = (await app.inject('/api/departments?includeArchived=true')).json().departments;
  assert.deepEqual(all.map((d: any) => d.name), ['C', 'A', 'B'], 'archived listed last');
  assert.equal(c.floorOrder, 3);
  assert.equal(a.floorOrder, 1);
});

test('creation ids are never reused after deleting the newest department', async () => {
  const { app } = memApp();
  await createDept(app, { name: 'A' });
  const b = (await createDept(app, { name: 'B' })).json;
  await app.inject({ method: 'DELETE', url: `/api/departments/${b.id}` });
  const c = (await createDept(app, { name: 'C' })).json;
  assert.equal(c.floorOrder, 3);
  assert.equal(c.floorPosition, 1);
});

test('floors are identical after reloading the database', async () => {
  const path = join(tempDir(), 'floors.sqlite');
  let db = openDb(path);
  let app = buildApp(db);
  const ids: string[] = [];
  for (const n of ['A', 'B', 'C', 'D']) ids.push((await createDept(app, { name: n })).json.id);
  await app.inject({ method: 'DELETE', url: `/api/departments/${ids[2]}` });
  const before = { floors: await floors(app), list: (await app.inject('/api/departments?includeArchived=true')).json() };
  await app.close();
  db.close();
  db = openDb(path);
  app = buildApp(db);
  assert.deepEqual(await floors(app), before.floors);
  assert.deepEqual((await app.inject('/api/departments?includeArchived=true')).json(), before.list);
  assert.deepEqual(await names(app), ['D', 'B', 'A']);
});
