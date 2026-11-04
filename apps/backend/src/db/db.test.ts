import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MIGRATIONS, openDb, schemaVersion } from './db.ts';
import { tempDir } from '../testUtils.ts';

const tables = (db: ReturnType<typeof openDb>) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);

test('fresh database is migrated to the latest version', () => {
  const db = openDb(':memory:');
  assert.equal(schemaVersion(db), MIGRATIONS.length);
  assert.ok(['company', 'department', 'department_inventory'].every((t) => tables(db).includes(t)));
});

test('reopening a database does not re-run migrations or lose data', () => {
  const path = join(tempDir(), 'a.sqlite');
  const db = openDb(path);
  db.prepare("INSERT INTO company (singleton, id, name, created_at) VALUES (1, 'c', 'X', 't')").run();
  db.close();
  const again = openDb(path);
  assert.equal(schemaVersion(again), MIGRATIONS.length);
  assert.equal((again.prepare('SELECT name FROM company').get() as { name: string }).name, 'X');
});

test('incremental migration upgrades an older database and keeps data', () => {
  const path = join(tempDir(), 'b.sqlite');
  const v1 = openDb(path);
  v1.prepare("INSERT INTO company (singleton, id, name, created_at) VALUES (1, 'c', 'X', 't')").run();
  v1.close();
  const next = [...MIGRATIONS, 'ALTER TABLE company ADD COLUMN note TEXT;'];
  const v2 = openDb(path, next);
  assert.equal(schemaVersion(v2), MIGRATIONS.length + 1);
  assert.equal((v2.prepare('SELECT name, note FROM company').get() as { name: string; note: null }).note, null);
});

test('v5 drops the workspace columns from a v4 database and keeps the department', () => {
  const path = join(tempDir(), 'w.sqlite');
  const v4 = openDb(path, MIGRATIONS.slice(0, 4));
  v4.prepare("INSERT INTO company (singleton, id, name, created_at) VALUES (1, 'c', 'X', 't')").run();
  v4.prepare("INSERT INTO department (id, company_id, name, name_key, floor_order, workspace_path, workspace_isolation, created_at, updated_at) VALUES ('d', 'c', 'Eng', 'eng', 1, '/srv', 'unverified', 't', 't')").run();
  v4.close();
  const db = openDb(path);
  const cols = (db.prepare('PRAGMA table_info(department)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(!cols.includes('workspace_path') && !cols.includes('workspace_isolation'));
  assert.equal((db.prepare('SELECT name FROM department').get() as { name: string }).name, 'Eng');
});

test('failed migration rolls back and leaves the version unchanged', () => {
  const path = join(tempDir(), 'c.sqlite');
  openDb(path).close();
  assert.throws(() => openDb(path, [...MIGRATIONS, 'CREATE TABLE ok (x); CREATE TABLE ok (x);']));
  const db = openDb(path);
  assert.equal(schemaVersion(db), MIGRATIONS.length);
  assert.ok(!tables(db).includes('ok'));
});

test('a database newer than the build is refused', () => {
  const path = join(tempDir(), 'd.sqlite');
  openDb(path, [...MIGRATIONS, 'CREATE TABLE future (x);']).close();
  assert.throws(() => openDb(path), /newer than this build/);
});

test('only one company row can exist', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO company (singleton, id, name, created_at) VALUES (1, 'a', 'A', 't')").run();
  assert.throws(() => db.prepare("INSERT INTO company (singleton, id, name, created_at) VALUES (2, 'b', 'B', 't')").run());
  assert.throws(() => db.prepare("INSERT INTO company (singleton, id, name, created_at) VALUES (1, 'c', 'C', 't')").run());
});

test('v10 turns the chief and the worker desks into agents with their own profiles', () => {
  const path = join(tempDir(), 'a10.sqlite');
  const v9 = openDb(path, MIGRATIONS.slice(0, 9));
  v9.prepare("INSERT INTO company (singleton, id, name, created_at) VALUES (1, 'c', 'X', 't')").run();
  const ins = v9.prepare(`INSERT INTO department (id, company_id, name, name_key, floor_order, chief_profile_ref, chief_origin, chief_verified_at,
    worker_profile_ref, worker_origin, worker_verified_at, created_at, updated_at) VALUES (?, 'c', ?, ?, ?, ?, ?, ?, ?, ?, ?, 't', 't')`);
  ins.run('d1', 'Eng', 'eng', 1, 'eng-chief', 'associated', 'v', 'vc-w', 'created', 'v');
  ins.run('d2', 'Ops', 'ops', 2, null, null, null, null, null, null);
  const inv = v9.prepare("INSERT INTO department_inventory (department_id, inventory_json, updated_at) VALUES (?, ?, 't')");
  inv.run('d1', JSON.stringify({ limits: { maxConcurrentWorkers: 3, maxTaskRuntimeSeconds: 60, maxDelegationDepth: 1 } }));
  inv.run('d2', JSON.stringify({ limits: { maxConcurrentWorkers: 0, maxTaskRuntimeSeconds: null, maxDelegationDepth: 1 } }));
  v9.prepare("INSERT INTO run_reference (id, department_id, hermes_task_ref, profile_ref, role, state, last_observed_at) VALUES ('r', 'd1', 't_1', 'vc-w', 'worker', 'running', 't')").run();
  v9.close();

  const db = openDb(path);
  const agents = db.prepare('SELECT department_id, agent_key, seat, profile_ref, origin, verified_at FROM department_agent ORDER BY department_id, seat').all()
    .map((r) => ({ ...r }));
  assert.deepEqual(agents, [
    { department_id: 'd1', agent_key: 'chief', seat: 0, profile_ref: 'eng-chief', origin: 'associated', verified_at: 'v' },
    { department_id: 'd1', agent_key: 'W-01', seat: 1, profile_ref: 'vc-w', origin: 'created', verified_at: 'v' },
    { department_id: 'd1', agent_key: 'W-02', seat: 2, profile_ref: null, origin: null, verified_at: null },
    { department_id: 'd1', agent_key: 'W-03', seat: 3, profile_ref: null, origin: null, verified_at: null },
    { department_id: 'd2', agent_key: 'chief', seat: 0, profile_ref: null, origin: null, verified_at: null },
  ]);
  const limits = JSON.parse((db.prepare("SELECT inventory_json FROM department_inventory WHERE department_id = 'd1'").get() as { inventory_json: string }).inventory_json).limits;
  assert.deepEqual(limits, { maxTaskRuntimeSeconds: 60, maxDelegationDepth: 1 });
  const cols = (db.prepare('PRAGMA table_info(department)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(!cols.some((c) => /^(chief|worker)_/.test(c)));
  assert.equal((db.prepare("SELECT agent_key FROM run_reference WHERE id = 'r'").get() as { agent_key: string }).agent_key, 'W-01');
});
