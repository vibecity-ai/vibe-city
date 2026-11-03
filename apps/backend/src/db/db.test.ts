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
