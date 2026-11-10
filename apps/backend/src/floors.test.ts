import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from './app.ts';
import { createDept, memApp } from './testUtils.ts';

const floors = async (app: ReturnType<typeof buildApp>) => (await app.inject('/api/company')).json().floors as any[];
const names = async (app: ReturnType<typeof buildApp>) =>
  (await app.inject('/api/departments')).json().departments.map((d: any) => d.name);

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

test('archiving closes the gap and removes the floor position; archived departments keep their creation id', async () => {
  const { app } = memApp();
  const [a, b, c] = [(await createDept(app, { name: 'A' })).json, (await createDept(app, { name: 'B' })).json, (await createDept(app, { name: 'C' })).json];
  await app.inject({ method: 'DELETE', url: `/api/departments/${b.id}` });
  const list = (await app.inject('/api/departments')).json().departments;
  assert.deepEqual(list.map((d: any) => [d.name, d.floorPosition]), [['C', 1], ['A', 2]]);
  const archived = (await app.inject(`/api/departments/${b.id}`)).json();
  assert.equal(archived.floorPosition, null);
  assert.equal(archived.floorOrder, 3); // creation order: the Chief of Staff's department is 1
  const all = (await app.inject('/api/departments?includeArchived=true')).json().departments;
  assert.deepEqual(all.map((d: any) => d.name), ['C', 'A', 'B'], 'archived listed last');
  assert.equal(c.floorOrder, 4);
  assert.equal(a.floorOrder, 2);
});

test('archive and list responses match the strict shared schemas the browser validates', async () => {
  const { DepartmentArchivedSchema, DepartmentListSchema, ReconcileResultSchema } = await import('@vibe-city/shared');
  const { app } = memApp();
  const a = (await createDept(app, { name: 'A' })).json;
  const out = await app.inject({ method: 'DELETE', url: `/api/departments/${a.id}` });
  assert.equal(out.statusCode, 200);
  const body = DepartmentArchivedSchema.parse(out.json());
  assert.equal(body.hermesResourcesRetained, false, 'never provisioned: nothing retained in Hermes');
  assert.ok(body.department.archivedAt);
  assert.equal(body.department.floorPosition, null);
  const all = DepartmentListSchema.parse((await app.inject('/api/departments?includeArchived=true')).json());
  assert.equal(all.departments.length, 1);
  assert.equal(DepartmentListSchema.parse((await app.inject('/api/departments')).json()).departments.length, 0);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/departments/${a.id}` })).statusCode, 404, 'archiving twice is not found');
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/departments/${a.id}`, payload: { name: 'X' } })).statusCode, 409, 'archived is read-only');
  assert.ok(ReconcileResultSchema.safeParse({ departments: [] }).success);
});
