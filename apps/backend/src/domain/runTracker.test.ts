import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/db.ts';
import { CompanyService } from './companyService.ts';
import { DepartmentService } from './departmentService.ts';
import { RunTracker, runState } from './runTracker.ts';
import type { KanbanClient } from '../hermes/kanbanClient.ts';

test('runState maps Hermes statuses without guessing', () => {
  assert.equal(runState({ status: 'running', outcome: null, ended_at: null }), 'running');
  assert.equal(runState({ status: 'done', outcome: 'completed', ended_at: 5 }), 'completed');
  assert.equal(runState({ status: 'crashed', outcome: 'crashed', ended_at: 5 }), 'failed');
  assert.equal(runState({ status: 'reclaimed', outcome: 'reclaimed', ended_at: 5 }), 'cancelled');
  assert.equal(runState({ status: 'weird', outcome: null, ended_at: 5 }), 'unknown');
});

function setup() {
  const db = openDb(':memory:');
  const c = new CompanyService(db).ensureCompany();
  const depts = new DepartmentService(db, c.id);
  const d = depts.create({ name: 'Eng', purpose: '', teammates: 1 });
  depts.markBoardSynced(d.id, d.hermesBoardSlug);
  depts.patchAgent(d.id, 'chief', { profile_ref: 'chief-x' });
  depts.patchAgent(d.id, 'W-01', { profile_ref: 'worker-x' });
  return { db, depts, tracker: new RunTracker(db, depts), id: d.id };
}

const detail = (runs: any[], children: string[] = []) => ({ task: {}, links: { parents: [], children }, child_results: [], attachments: [], runs });

test('observe records the runs of every agent, idempotently, and flags foreign profiles', async () => {
  const { tracker, id } = setup();
  const tasks: Record<string, any> = {
    q1: detail([{ id: 1, profile: 'chief-x', status: 'done', outcome: 'completed', ended_at: 9 }], ['c1', 'c2']),
    c1: detail([{ id: 2, profile: 'worker-x', status: 'done', outcome: 'completed', ended_at: 9 }]),
    c2: detail([{ id: 3, profile: 'intruder', status: 'done', outcome: 'completed', ended_at: 9 }]),
  };
  const fake = { getTask: async (_b: string, t: string) => tasks[t] } as unknown as KanbanClient;
  const first = await tracker.observe(id, fake, 'q1');
  assert.deepEqual(first.recorded.map((r) => [r.hermesTaskRef, r.hermesRunRef, r.agentKey, r.state, r.parentTaskRef]),
    [['q1', '1', 'chief', 'completed', null], ['c1', '2', 'W-01', 'completed', 'q1']]);
  assert.equal(first.violations.length, 1);
  assert.match(first.violations[0]!, /intruder/);
  const second = await tracker.observe(id, fake, 'q1');
  assert.equal(second.recorded.length, 2, 'no duplicates on re-observation');
});

test('observe refuses an unprovisioned department', async () => {
  const db = openDb(':memory:');
  const c = new CompanyService(db).ensureCompany();
  const depts = new DepartmentService(db, c.id);
  const d = depts.create({ name: 'Eng', purpose: '', teammates: 0 });
  await assert.rejects(new RunTracker(db, depts).observe(d.id, {} as KanbanClient, 'x'), /not synced/);
});
