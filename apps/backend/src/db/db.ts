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
  // v6: characters (persona per agent seat) and dialogue-window chat history. Personas never grant capabilities.
  `CREATE TABLE agent_character (
     department_id TEXT NOT NULL REFERENCES department(id),
     agent_key TEXT NOT NULL,
     character_json TEXT NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY (department_id, agent_key)
   );
   CREATE TABLE chat_message (
     id TEXT PRIMARY KEY,
     department_id TEXT NOT NULL REFERENCES department(id),
     agent_key TEXT NOT NULL,
     seq INTEGER NOT NULL,
     message_json TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE INDEX chat_message_thread_idx ON chat_message(department_id, agent_key, seq);`,
  // v7: AR hiring requests and their candidates (feature spec 7.1). A request changes nothing in Hermes until the offer.
  `CREATE TABLE hiring_request (
     id TEXT PRIMARY KEY,
     state TEXT NOT NULL,
     trigger_json TEXT NOT NULL,
     department_id TEXT,
     brief_json TEXT,
     messages_json TEXT NOT NULL DEFAULT '[]',
     scouting_until TEXT,
     hired_candidate_id TEXT,
     applied_json TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE hiring_candidate (
     id TEXT PRIMARY KEY,
     request_id TEXT NOT NULL REFERENCES hiring_request(id),
     idx INTEGER NOT NULL,
     candidate_json TEXT NOT NULL,
     interview_json TEXT NOT NULL DEFAULT '[]'
   );
   CREATE INDEX hiring_candidate_req_idx ON hiring_candidate(request_id, idx);`,
  // v8: quests between departments (feature spec 2.4): requests, quest origins, per-department policy, MCP tokens.
  `CREATE TABLE quest_request (
     id TEXT PRIMARY KEY,
     from_department_id TEXT NOT NULL REFERENCES department(id),
     to_department_id TEXT REFERENCES department(id),
     to_label TEXT NOT NULL,
     title TEXT NOT NULL,
     objective TEXT NOT NULL,
     reason TEXT NOT NULL,
     state TEXT NOT NULL,
     note TEXT,
     quest_id TEXT,
     created_at TEXT NOT NULL,
     decided_at TEXT
   );
   CREATE INDEX quest_request_from_idx ON quest_request(from_department_id, created_at);
   CREATE TABLE quest_origin (
     quest_id TEXT NOT NULL,
     department_id TEXT NOT NULL REFERENCES department(id),
     origin TEXT NOT NULL,
     from_department_id TEXT,
     request_id TEXT,
     created_at TEXT NOT NULL,
     PRIMARY KEY (department_id, quest_id)
   );
   CREATE TABLE quest_policy (
     department_id TEXT PRIMARY KEY REFERENCES department(id),
     policy_json TEXT NOT NULL
   );
   CREATE TABLE agent_token (
     department_id TEXT PRIMARY KEY REFERENCES department(id),
     token_hash TEXT NOT NULL UNIQUE,
     created_at TEXT NOT NULL
   );`,
  // v9: schedules (feature spec 8). One row per fire makes firing idempotent across restarts.
  `CREATE TABLE schedule (
     id TEXT PRIMARY KEY,
     department_id TEXT NOT NULL REFERENCES department(id),
     name TEXT NOT NULL,
     cron TEXT NOT NULL,
     timezone TEXT NOT NULL,
     title TEXT NOT NULL,
     objective TEXT NOT NULL,
     instructions TEXT NOT NULL,
     enabled INTEGER NOT NULL,
     next_run_at TEXT,
     last_run_at TEXT,
     last_quest_id TEXT,
     last_error TEXT,
     created_at TEXT NOT NULL,
     deleted_at TEXT
   );
   CREATE TABLE schedule_fire (
     schedule_id TEXT NOT NULL REFERENCES schedule(id),
     fire_at TEXT NOT NULL,
     quest_id TEXT,
     error TEXT,
     PRIMARY KEY (schedule_id, fire_at)
   );`,
  // v10: one Hermes profile per agent. The chief becomes the lead (seat 0, key 'chief'); the shared worker profile
  // becomes W-01; any further worker desks become agents W-02… that get their own profiles on the next provision.
  // A hire's model and skills now belong to its agent, not the department.
  `CREATE TABLE department_agent (
     department_id TEXT NOT NULL REFERENCES department(id),
     agent_key TEXT NOT NULL,
     seat INTEGER NOT NULL,
     profile_ref TEXT,
     origin TEXT CHECK (origin IN ('created','associated')),
     verified_at TEXT,
     model_json TEXT,
     skills_json TEXT NOT NULL DEFAULT '[]',
     created_at TEXT NOT NULL,
     PRIMARY KEY (department_id, agent_key),
     UNIQUE (department_id, seat)
   );
   INSERT INTO department_agent (department_id, agent_key, seat, profile_ref, origin, verified_at, created_at)
     SELECT id, 'chief', 0, chief_profile_ref, chief_origin, chief_verified_at, created_at FROM department;
   WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10)
   INSERT INTO department_agent (department_id, agent_key, seat, profile_ref, origin, verified_at, created_at)
     SELECT d.id, 'W-' || printf('%02d', n.i), n.i,
       CASE WHEN n.i = 1 THEN d.worker_profile_ref END, CASE WHEN n.i = 1 THEN d.worker_origin END,
       CASE WHEN n.i = 1 THEN d.worker_verified_at END, d.created_at
     FROM department d
     JOIN department_inventory inv ON inv.department_id = d.id
     JOIN n ON n.i <= COALESCE(json_extract(inv.inventory_json, '$.limits.maxConcurrentWorkers'), 0);
   UPDATE department_inventory SET inventory_json = json_remove(inventory_json, '$.limits.maxConcurrentWorkers');
   ALTER TABLE department DROP COLUMN chief_profile_ref;
   ALTER TABLE department DROP COLUMN worker_profile_ref;
   ALTER TABLE department DROP COLUMN chief_verified_at;
   ALTER TABLE department DROP COLUMN worker_verified_at;
   ALTER TABLE department DROP COLUMN chief_origin;
   ALTER TABLE department DROP COLUMN worker_origin;
   ALTER TABLE run_reference ADD COLUMN agent_key TEXT;
   UPDATE run_reference SET agent_key = CASE role WHEN 'chief' THEN 'chief' ELSE 'W-01' END;
   ALTER TABLE run_reference DROP COLUMN role;`,
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
