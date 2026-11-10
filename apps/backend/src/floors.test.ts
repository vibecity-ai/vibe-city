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

test('the Chief of Staff never collides with a floor named "Chief of Staff", and cannot be archived or edited', async () => {
  const { openDb, MIGRATIONS } = await import('./db/db.ts');
  const { buildServices } = await import('./app.ts');
  const { join } = await import('node:path');
  const { tempDir } = await import('./testUtils.ts');
  /** A database from before the last migration with one department row (raw, as an older build wrote it). */
  const older = (file: string, id: string, templateId: string | null) => {
    const path = join(tempDir(), file), db = openDb(path, MIGRATIONS.slice(0, -1));
    db.prepare("INSERT INTO company (singleton, id, name, created_at) VALUES (1, 'c', 'Acme', 'now')").run();
    db.prepare(`INSERT INTO department (id, company_id, name, name_key, purpose, floor_order, created_at, updated_at, template_id)
      VALUES (?, 'c', 'Chief of Staff', 'chief of staff', '', 1, 'now', 'now', ?)`).run(id, templateId);
    db.prepare("INSERT INTO department_inventory (department_id, inventory_json, updated_at) VALUES (?, '{}', 'now')").run(id);
    db.prepare("INSERT INTO department_agent (department_id, agent_key, seat, skills_json, created_at) VALUES (?, 'chief', 0, '[]', 'now')").run(id);
    db.close();
    return path;
  };
  // the CEO named a floor "Chief of Staff" before the hidden Chief of Staff existed: the next start creates it anyway
  const a = buildServices(openDb(older('floor.sqlite', '11111111-1111-4111-8111-111111111111', null)));
  assert.notEqual(a.chiefOfStaffId, '11111111-1111-4111-8111-111111111111');
  assert.deepEqual(await names(a.app), ['Chief of Staff'], 'the floor stays a floor');
  assert.equal((await a.app.inject({ method: 'DELETE', url: `/api/departments/${a.chiefOfStaffId}` })).statusCode, 409);
  assert.equal((await a.app.inject({ method: 'PATCH', url: `/api/departments/${a.chiefOfStaffId}`, payload: { name: 'Boss' } })).statusCode, 409);
  assert.equal((await a.app.inject({ method: 'DELETE', url: '/api/departments/11111111-1111-4111-8111-111111111111' })).statusCode, 200);
  a.db.close();
  // a Chief of Staff an older build created with a floor's name key: rekeyed, so the name is free for a floor
  const b = buildServices(openDb(older('cos.sqlite', '22222222-2222-4222-8222-222222222222', 'chief-of-staff')));
  assert.equal(b.chiefOfStaffId, '22222222-2222-4222-8222-222222222222');
  assert.equal((await createDept(b.app, { name: 'Chief of Staff' })).res.statusCode, 201);
  b.db.close();
});
