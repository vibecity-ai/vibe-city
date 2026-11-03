import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TaskNode } from '@vibe-city/shared';
import { STATUS, canCancel, connectionBanner, formatBytes, planningNote, requestIdFor, treeRows } from './format.ts';

const node = (id: string, depth: number, childIds: string[] = [], o: Partial<TaskNode> = {}): TaskNode => ({
  id, title: id, role: depth ? 'worker' : 'chief', assignee: 'p', status: 'done', parentIds: [], childIds, depth, failed: false,
  createdAt: null, startedAt: null, completedAt: null, summary: null, error: null, attachmentCount: 0, runs: [], ...o,
});

test('every quest status has a label, tone and hint', () => {
  for (const s of Object.values(STATUS)) assert.ok(s.label && s.hint && s.tone);
});

test('chief finishing is explained as planning, never as quest completion', () => {
  const flags = { planningComplete: true, delegated: true, hasFailures: false, hasBlocked: false, idle: true, unauthorizedAssignees: false };
  assert.match(planningNote({ flags, status: 'running' })!, /only when all worker tasks are done/);
  assert.equal(planningNote({ flags, status: 'completed' }), null);
  assert.match(planningNote({ flags: { ...flags, delegated: false }, status: 'completed' })!, /without creating worker tasks/);
});

test('cancel is offered only while something can still run', () => {
  assert.equal(canCancel('running'), true);
  assert.equal(canCancel('cancelling'), true);
  assert.equal(canCancel('completed'), false);
  assert.equal(canCancel('cancelled'), false);
});

test('connection banner distinguishes link loss, dashboard offline and gateway unavailable', () => {
  assert.equal(connectionBanner(true, 'connected'), null);
  assert.match(connectionBanner(false, null)!.text, /backend/);
  assert.match(connectionBanner(true, 'dashboard_offline')!.text, /dashboard is offline/);
  assert.match(connectionBanner(true, 'gateway_unavailable')!.text, /gateway is not running/);
  assert.equal(connectionBanner(true, 'dashboard_offline')!.tone, 'bad');
});

test('treeRows nests descendants depth-first and shows shared children once', () => {
  const nodes = [node('r', 0, ['a', 'b']), node('a', 1, ['g']), node('b', 1, ['g']), node('g', 2)];
  assert.deepEqual(treeRows(nodes).map((r) => [r.node.id, r.depth]), [['r', 0], ['a', 1], ['g', 2], ['b', 1]]);
});

test('treeRows still lists orphans of a truncated tree', () => {
  assert.equal(treeRows([node('r', 0, ['missing']), node('x', 3)]).length, 2);
});

test('request id is stable for identical content and changes when the content changes', () => {
  let n = 0;
  const gen = () => `id${++n}`;
  const a = requestIdFor('A', null, gen);
  assert.equal(requestIdFor('A', a, gen).id, a.id, 'retry of the same form reuses the id (no duplicate quest)');
  assert.notEqual(requestIdFor('B', a, gen).id, a.id);
});

test('formatBytes', () => {
  assert.deepEqual([formatBytes(10), formatBytes(2048), formatBytes(3 * 1024 * 1024)], ['10 B', '2.0 KB', '3.0 MB']);
});
