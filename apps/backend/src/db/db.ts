import { DatabaseSync } from 'node:sqlite';

/** Append-only. Never edit a released migration; add a new entry. */
export const MIGRATIONS: readonly string[] = [
  // v1: company, departments, department inventory
  `CREATE TABLE company (
     singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
     id TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE TABLE department (
     id TEXT PRIMARY KEY,
     company_id TEXT NOT NULL REFERENCES company(id),
     name TEXT NOT NULL,
     name_key TEXT NOT NULL,
     purpose TEXT NOT NULL DEFAULT '',
     floor_order INTEGER NOT NULL UNIQUE,
     workspace_path TEXT,
     workspace_isolation TEXT NOT NULL DEFAULT 'unverified' CHECK (workspace_isolation IN ('unverified','verified')),
     chief_profile_ref TEXT,
     worker_profile_ref TEXT,
     hermes_board_ref TEXT,
     board_sync_state TEXT NOT NULL DEFAULT 'not_provisioned' CHECK (board_sync_state IN ('not_provisioned','synced','error')),
     archived_at TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE UNIQUE INDEX department_active_name_uq ON department(name_key) WHERE archived_at IS NULL;
   CREATE UNIQUE INDEX department_board_uq ON department(hermes_board_ref) WHERE hermes_board_ref IS NOT NULL;
   CREATE TABLE department_inventory (
     department_id TEXT PRIMARY KEY REFERENCES department(id),
     inventory_json TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );`,
  // v2 (Milestone 2): provisioning lifecycle, verified-resource tracking, run references
  `ALTER TABLE department ADD COLUMN provisioning_state TEXT NOT NULL DEFAULT 'unconfigured'
     CHECK (provisioning_state IN ('unconfigured','provisioning','ready','error','disconnected'));
   ALTER TABLE department ADD COLUMN provisioning_error_json TEXT;
   ALTER TABLE department ADD COLUMN provisioning_attempts INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE department ADD COLUMN board_verified_at TEXT;
   ALTER TABLE department ADD COLUMN chief_verified_at TEXT;
   ALTER TABLE department ADD COLUMN worker_verified_at TEXT;
   ALTER TABLE department ADD COLUMN chief_origin TEXT CHECK (chief_origin IN ('created','associated'));
   ALTER TABLE department ADD COLUMN worker_origin TEXT CHECK (worker_origin IN ('created','associated'));
   ALTER TABLE department ADD COLUMN inventory_applied_hash TEXT;
   ALTER TABLE department ADD COLUMN inventory_applied_at TEXT;
   ALTER TABLE department ADD COLUMN observed_config_json TEXT;
   ALTER TABLE department ADD COLUMN last_reconciled_at TEXT;
   CREATE TABLE run_reference (
     id TEXT PRIMARY KEY,
     department_id TEXT NOT NULL REFERENCES department(id),
     hermes_task_ref TEXT NOT NULL,
     hermes_run_ref TEXT,
     parent_task_ref TEXT,
     profile_ref TEXT NOT NULL,
     role TEXT NOT NULL CHECK (role IN ('chief','worker')),
     state TEXT NOT NULL CHECK (state IN ('queued','running','completed','failed','cancelled','unknown')),
     last_observed_at TEXT NOT NULL,
     UNIQUE (department_id, hermes_task_ref, hermes_run_ref)
   );
   CREATE INDEX run_reference_dept_idx ON run_reference(department_id);`,
  // v3: explicit user confirmation before Vibe City modifies a pre-existing (associated) Hermes profile
  `ALTER TABLE department ADD COLUMN confirmed_profile_refs_json TEXT NOT NULL DEFAULT '[]';`,
  // v4 (Milestone 3): resume cursor for the Hermes event stream. A cursor only, never event content.
  `CREATE TABLE event_cursor (
     board_slug TEXT PRIMARY KEY,
     last_event_id INTEGER NOT NULL,
     updated_at TEXT NOT NULL
   );`,
  // v5: departments no longer have a workspace path; Hermes gives every task its own folder.
  `ALTER TABLE department DROP COLUMN workspace_path;
   ALTER TABLE department DROP COLUMN workspace_isolation;`,
];

export function schemaVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

/** Opens (and migrates) the Vibe City metadata DB. Use ':memory:' in tests. */
export function openDb(path: string, migrations: readonly string[] = MIGRATIONS): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const current = schemaVersion(db);
  if (current > migrations.length) {
    throw new Error(`Database schema v${current} is newer than this build (v${migrations.length})`);
  }
  for (let v = current; v < migrations.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(migrations[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return db;
}
